const { app, BrowserWindow, dialog, ipcMain, safeStorage } = require('electron');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { createInterface } = require('node:readline');
const { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } = require('node:fs');
const path = require('node:path');

let win;
let backend;
let activeRun;
let settings;
let settingsFile;
let quitting = false;
const pending = new Map();

function persist() {
  const temporary = settingsFile + '.tmp';
  writeFileSync(temporary, JSON.stringify(settings, null, 2), 'utf8');
  renameSync(temporary, settingsFile);
}

function startBackend(directory) {
  const root = app.isPackaged ? process.resourcesPath : path.join(__dirname, '..');
  const java = path.join(root, 'runtime', 'bin', 'java.exe');
  const jar = app.isPackaged ? path.join(root, 'backend.jar')
    : path.join(root, 'backend', 'target', 'jharness-backend.jar');
  backend = spawn(existsSync(java) ? java : 'java', ['-Dfile.encoding=UTF-8', '-jar', jar, directory],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  createInterface({ input: backend.stdout }).on('line', line => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.event) {
      if (message.event === 'done' && activeRun === message.runId) activeRun = undefined;
      if (win && !win.isDestroyed()) win.webContents.send('jh:event', message);
      return;
    }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error(message.error));
    else request.resolve(message.result);
  });
  backend.stderr.resume();
  backend.stdin.on('error', () => {});
  function fail() {
    backend = undefined;
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error('Java 后端已退出。请重新打开 JHarness。'));
    }
    pending.clear();
    if (activeRun && win && !win.isDestroyed()) {
      win.webContents.send('jh:event', { runId: activeRun, event: 'error', data: { message: 'Java 后端已退出。' } });
      win.webContents.send('jh:event', { runId: activeRun, event: 'done', data: {} });
    }
    activeRun = undefined;
  }
  backend.once('error', fail);
  backend.once('exit', fail);
}

function call(method, params = {}) {
  if (!backend?.stdin.writable) return Promise.reject(new Error('Java 后端未运行。'));
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('Java 后端响应超时。'));
    }, 35000);
    pending.set(id, { resolve, reject, timer });
    backend.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
}

function publicSettings() {
  const { encryptedKey, ...model } = settings.model;
  return { projects: settings.projects, model: { ...model, hasKey: Boolean(encryptedKey) } };
}

function savedKey() {
  return settings.model.encryptedKey
    ? safeStorage.decryptString(Buffer.from(settings.model.encryptedKey, 'base64')) : '';
}

function modelInput(input) {
  const provider = input.provider === 'deepseek' ? 'deepseek' : 'compatible';
  const model = provider === 'deepseek' ? 'deepseek-flash' : String(input.model || '').trim();
  const baseUrl = provider === 'deepseek' ? 'https://api.deepseek.com' : String(input.baseUrl || '').trim();
  const key = String(input.key || '').trim() || (settings.model.provider === provider
    && settings.model.baseUrl === baseUrl ? savedKey() : '');
  if (!model || !baseUrl || !key) throw new Error('请填写 Base URL、模型 ID 和 API Key。');
  let url;
  try { url = new URL(baseUrl); } catch { throw new Error('请输入有效的 Base URL。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('请输入有效的 HTTP 或 HTTPS Base URL。');
  }
  return { provider, model, baseUrl, key };
}

function context(projectId, sessionId) {
  const project = settings.projects.find(item => item.id === projectId);
  if (!project || !project.sessions.some(item => item.id === sessionId)) throw new Error('找不到此会话。');
  return { projectId, sessionId, projectPath: project.directory };
}

function register() {
  ipcMain.handle('jh:state', () => publicSettings());
  ipcMain.handle('jh:project', async () => {
    const result = await dialog.showOpenDialog(win, { title: '打开项目', properties: ['openDirectory'] });
    if (result.canceled) return null;
    const directory = result.filePaths[0];
    let project = settings.projects.find(item => item.directory.toLowerCase() === directory.toLowerCase());
    if (!project) {
      project = { id: randomUUID(), directory, name: path.basename(directory) || directory, sessions: [] };
      settings.projects.unshift(project);
      persist();
    }
    return project;
  });
  ipcMain.handle('jh:session', (_, projectId) => {
    const project = settings.projects.find(item => item.id === projectId);
    if (!project) throw new Error('请先打开一个项目。');
    const session = { id: randomUUID(), title: '新会话' };
    project.sessions.unshift(session);
    persist();
    return session;
  });
  ipcMain.handle('jh:history', (_, project, session) => call('history', context(project, session)));
  ipcMain.handle('jh:test-model', (_, input) => call('testModel', modelInput(input)));
  ipcMain.handle('jh:save-model', (_, input) => {
    const { key, ...model } = modelInput(input);
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows 凭证保护不可用。');
    settings.model = { ...model, encryptedKey: safeStorage.encryptString(key).toString('base64') };
    persist();
    return publicSettings().model;
  });
  ipcMain.handle('jh:chat', async (_, projectId, sessionId, message, runId) => {
    if (activeRun) throw new Error('已有会话正在运行。');
    const selected = context(projectId, sessionId);
    const model = modelInput(settings.model);
    if (typeof message !== 'string' || !message.trim() || message.length > 16000) {
      throw new Error('请输入 16,000 字符以内的消息。');
    }
    activeRun = runId;
    try {
      const session = settings.projects.find(item => item.id === projectId).sessions.find(item => item.id === sessionId);
      if (session.title === '新会话') {
        session.title = message.trim().replace(/\s+/g, ' ').slice(0, 40);
        persist();
      }
      await call('chat', { ...selected, ...model, message, runId });
      return session.title;
    } catch (error) {
      if (activeRun === runId) activeRun = undefined;
      throw error;
    }
  });
  ipcMain.handle('jh:stop', (_, runId) => call('stop', { runId }));
}

app.setName('JHarness');
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  app.whenReady().then(() => {
    const directory = app.getPath('userData');
    mkdirSync(directory, { recursive: true });
    settingsFile = path.join(directory, 'settings.json');
    settings = existsSync(settingsFile) ? JSON.parse(readFileSync(settingsFile, 'utf8'))
      : { projects: [], model: { provider: 'deepseek', model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com' } };
    register();
    startBackend(path.join(directory, 'workspaces'));
    win = new BrowserWindow({
      width: 1240, height: 830, minWidth: 780, minHeight: 570,
      backgroundColor: '#fcfcfb', autoHideMenuBar: true,
      webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true,
        nodeIntegration: false, sandbox: true }
    });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', event => event.preventDefault());
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }).catch(() => {
    dialog.showErrorBox('JHarness', '无法读取应用设置。');
    app.quit();
  });
}

app.on('window-all-closed', () => app.quit());
app.on('before-quit', event => {
  if (quitting || !backend) return;
  event.preventDefault();
  quitting = true;
  const child = backend;
  if (activeRun) call('stop', { runId: activeRun }).catch(() => {});
  child.stdin.end();
  const timer = setTimeout(() => { child.kill(); app.quit(); }, 1800);
  child.once('exit', () => { clearTimeout(timer); app.quit(); });
});

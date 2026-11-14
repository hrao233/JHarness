const { app, BrowserWindow, clipboard, dialog, ipcMain, safeStorage } = require('electron');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const { randomUUID } = require('node:crypto');
const { createInterface } = require('node:readline');
const { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } = require('node:fs');
const path = require('node:path');
const { importAttachment, projectParts, label } = require('./context-parts.cjs');
const git = promisify(execFile);

let win;
let backend;
let activeRun;
let settings;
let settingsFile;
let quitting = false;
const pending = new Map();
const attachments = new Map();
const effortValues = ['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

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
  const models = settings.models.map(({ encryptedKey, ...model }) => ({ ...model, hasKey: Boolean(encryptedKey) }));
  return { projects: settings.projects, models, defaultModelId: settings.defaultModelId,
    bookmarks: settings.bookmarks || [] };
}

function modelInput(input) {
  const provider = input.provider === 'deepseek' ? 'deepseek' : 'compatible';
  const model = String(input.model || (provider === 'deepseek' ? 'deepseek-flash' : '')).trim();
  const baseUrl = provider === 'deepseek' ? 'https://api.deepseek.com' : String(input.baseUrl || '').trim();
  const saved = settings.models.find(item => item.id === input.id && item.provider === provider
    && item.baseUrl === baseUrl);
  const key = String(input.key || '').trim() || (saved?.encryptedKey
    ? safeStorage.decryptString(Buffer.from(saved.encryptedKey, 'base64')) : '');
  if (!model || !baseUrl || !key) throw new Error('请填写 Base URL、模型 ID 和 API Key。');
  if (provider === 'deepseek' && !['deepseek-flash', 'deepseek-v4-pro'].includes(model)) {
    throw new Error('请选择 DeepSeek 官方模型。');
  }
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
  ipcMain.handle('jh:copy', (_, text) => {
    if (typeof text !== 'string') throw new Error('无法复制此内容。');
    clipboard.writeText(text);
  });
  ipcMain.handle('jh:bookmark-add', (_, value) => {
    context(value.projectId, value.sessionId);
    const { projectId, sessionId, turn, role, text } = value;
    if (!Number.isSafeInteger(turn) || turn < 1 || !['user', 'assistant'].includes(role)
        || typeof text !== 'string' || !text.trim()) throw new Error('无法收藏此消息。');
    const bookmarks = settings.bookmarks ||= [];
    if (!bookmarks.some(item => item.sessionId === sessionId && item.turn === turn && item.role === role && item.text === text)) {
      bookmarks.unshift({ id: randomUUID(), projectId, sessionId, turn, role, text });
      persist();
    }
    return bookmarks;
  });
  ipcMain.handle('jh:bookmark-remove', (_, id) => {
    settings.bookmarks = (settings.bookmarks || []).filter(item => item.id !== id);
    persist();
    return settings.bookmarks;
  });
  ipcMain.handle('jh:git-review', async (_, projectId) => {
    const project = settings.projects.find(item => item.id === projectId);
    if (!project) throw new Error('请先打开 Git 项目。');
    const options = { cwd: project.directory, windowsHide: true, encoding: 'utf8',
      maxBuffer: 1024 * 1024, timeout: 12000, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } };
    const run = args => git('git', ['--no-pager', '-c', 'color.ui=false', '-c', 'core.fsmonitor=false', ...args], options)
      .then(({ stdout }) => stdout);
    try {
      const [status, unstaged, staged] = await Promise.all([
        run(['status', '--short', '--branch', '--untracked-files=normal', '--', '.']),
        run(['diff', '--no-ext-diff', '--no-textconv', '--', '.']),
        run(['diff', '--cached', '--no-ext-diff', '--no-textconv', '--', '.'])
      ]);
      return { status, unstaged, staged };
    } catch (error) {
      if (error.code === 'ENOENT') throw new Error('找不到 Git，请确认 Git 已安装且项目可访问。');
      if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw new Error('项目差异超过 1 MiB。');
      if (error.stderr?.includes('not a git repository')) throw new Error('当前目录没有 Git 仓库。');
      throw new Error('无法读取当前项目的 Git 状态。');
    }
  });
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
  ipcMain.handle('jh:attachment', async (_, projectId, kind) => {
    const project = settings.projects.find(item => item.id === projectId);
    if (!project || !['file', 'folder', 'image'].includes(kind)) throw new Error('请选择项目和附件类型。');
    const result = await dialog.showOpenDialog(win, {
      title: { file: '添加文件', folder: '添加文件夹', image: '添加图片' }[kind],
      defaultPath: project.directory,
      properties: [kind === 'folder' ? 'openDirectory' : 'openFile', 'multiSelections'],
      ...(kind === 'image' && { filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg'] }] })
    });
    if (result.canceled) return [];
    if (result.filePaths.length > 8) throw new Error('每次最多选择 8 项。');
    const parts = await Promise.all(result.filePaths.map(target =>
      importAttachment(target, kind === 'image' ? 'file' : kind, project.directory)));
    if (kind === 'image' && parts.some(part => part.kind !== 'image')) throw new Error('请选择 PNG 或 JPEG 图片。');
    return parts.map(({ text, image, mime, ...part }) => {
      if (attachments.size >= 16) attachments.delete(attachments.keys().next().value);
      const id = randomUUID();
      attachments.set(id, { projectId, text, image, mime, ...part });
      return { id, label: label(part), ...part };
    });
  });
  ipcMain.handle('jh:project-parts', async (_, projectId) => {
    const project = settings.projects.find(item => item.id === projectId);
    if (!project) return [];
    return (await projectParts(project.directory)).map(({ text, ...part }) => ({ ...part, label: label(part) }));
  });
  ipcMain.handle('jh:test-model', (_, input) => call('testModel', modelInput(input)));
  ipcMain.handle('jh:save-model', (_, input) => {
    const { key, ...model } = modelInput(input);
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows 凭证保护不可用。');
    const index = settings.models.findIndex(item => item.id === input.id);
    const id = index < 0 ? randomUUID() : input.id;
    const profile = { id, ...model, encryptedKey: safeStorage.encryptString(key).toString('base64') };
    if (index < 0) settings.models.push(profile);
    else settings.models[index] = profile;
    if (!settings.defaultModelId || input.makeDefault) settings.defaultModelId = id;
    persist();
    return { ...publicSettings(), savedModelId: id };
  });
  ipcMain.handle('jh:chat', async (_, projectId, sessionId, message, runId, options = {}) => {
    if (activeRun) throw new Error('已有会话正在运行。');
    const selected = context(projectId, sessionId);
    const profile = settings.models.find(item => item.id === (options.modelId || settings.defaultModelId));
    if (!profile) throw new Error('请先在设置中添加模型。');
    const model = modelInput(profile);
    const effort = effortValues.includes(options.effort) ? options.effort : 'default';
    const permission = ['ask', 'assist', 'full'].includes(options.permission) ? options.permission : 'assist';
    if (typeof message !== 'string' || !message.trim() || message.length > 16000) {
      throw new Error('请输入 16,000 字符以内的消息。');
    }
    activeRun = runId;
    try {
      const requested = Array.isArray(options.parts) ? options.parts : [];
      if (requested.length > 8) throw new Error('每条消息最多附加 8 项。');
      const local = requested.some(part => part.source) ? await projectParts(selected.projectPath) : [];
      const parts = requested.map(part => {
        const attachment = attachments.get(part.id);
        const item = attachment?.projectId === projectId ? attachment
          : local.find(value => value.source === part.source && value.kind === part.kind);
        if (!item) throw new Error('附件已失效，请重新添加。');
        if (item.image && model.provider === 'deepseek' && model.model !== 'deepseek-flash') {
          throw new Error('当前 DeepSeek 官方模型不接受图片。请选择 DeepSeek Flash。');
        }
        return { label: label(item), text: item.text, image: item.image, mime: item.mime, kind: item.kind };
      });
      const session = settings.projects.find(item => item.id === projectId).sessions.find(item => item.id === sessionId);
      await call('chat', { ...selected, ...model, message, runId, parts, permission, effort });
      if (session.title === '新会话') session.title = message.trim().replace(/\s+/g, ' ').slice(0, 40);
      Object.assign(session, { modelId: options.modelId || '', effort, permission, updatedAt: Date.now() });
      persist();
      for (const part of requested) attachments.delete(part.id);
      return session.title;
    } catch (error) {
      if (activeRun === runId) activeRun = undefined;
      throw error;
    }
  });
  ipcMain.handle('jh:stop', (_, runId) => call('stop', { runId }));
  ipcMain.handle('jh:approve', (_, runId, approvalId, allow) =>
    call('approve', { runId, approvalId, allow: allow === true }));
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
      : { projects: [] };
    if (!Array.isArray(settings.models)) {
      const legacy = settings.model?.encryptedKey ? { id: randomUUID(), ...settings.model } : null;
      settings.models = legacy ? [legacy] : [];
      settings.defaultModelId = legacy?.id;
      delete settings.model;
      persist();
    }
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

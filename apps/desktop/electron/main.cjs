const { app, BrowserWindow, clipboard, dialog, ipcMain, safeStorage, shell } = require('electron');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const { randomUUID } = require('node:crypto');
const { createInterface } = require('node:readline');
const { existsSync, mkdirSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const { importAttachment, projectParts, label } = require('./context-parts.cjs');
const { createManager } = require('./worktree-manager.cjs');
const maintenance = require('./data-maintenance.cjs');
const { createStore: createAutomationStore } = require('./automation-store.cjs');
const { readSettings, updateSettings, findProject, legacyProject, addProject } = require(
  app.isPackaged ? '../shared/settings-store.cjs' : '../../shared/settings-store.cjs');
const git = promisify(execFile);

let win;
let backend;
const activeRuns = new Set();
let dataDirectory;
let quitting = false;
let bookmarkMigration;
let worktreeManager;
let automationStore;
let automationTimer;
let automationTicking = false;
const pending = new Map();
const attachments = new Map();
const effortValues = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const deepseekEfforts = ['none', 'low', 'high', 'max'];
const smokeMode = process.argv.includes('--jharness-smoke');

function managedWorktrees() {
  if (!worktreeManager) {
    worktreeManager = createManager(path.join(app.getPath('userData'), 'worktrees'));
  }
  return worktreeManager;
}

function fastTier(profile) {
  if (profile.provider !== 'compatible') return '';
  if (profile.fastTier !== undefined) return profile.fastTier;
  return new URL(profile.baseUrl).hostname === 'api.openai.com' ? 'fast' : '';
}

function effortLevels(profile) {
  if (profile.provider === 'deepseek') return deepseekEfforts;
  return profile.efforts || ['minimal', 'low', 'medium', 'high', 'xhigh'];
}

function resolveEffort(profile, selected) {
  const levels = effortLevels(profile);
  if (levels.includes(selected)) return selected;
  if (selected && selected !== 'default') throw new Error('当前模型未配置此推理强度。');
  return levels.includes('high') ? 'high' : levels[0];
}

function settings() {
  return readSettings(dataDirectory);
}

function changeSettings(change) {
  return updateSettings(dataDirectory, change);
}

function changeProject(id, change) {
  return changeSettings(state => {
    const project = state.projects.find(item => item.id === id);
    if (!project) throw new Error('找不到项目。');
    return change(project);
  });
}

function changeSession(projectId, sessionId, change) {
  return changeProject(projectId, project => {
    const session = project.sessions.find(item => item.id === sessionId);
    if (!session) throw new Error('找不到此会话。');
    return change(session);
  });
}

function startBackend(directory) {
  const root = app.isPackaged ? process.resourcesPath : path.join(__dirname, '..', '..', '..');
  const java = path.join(root, 'runtime', 'bin', 'java.exe');
  const jar = app.isPackaged ? path.join(root, 'backend.jar')
    : path.join(root, 'apps', 'backend', 'target', 'jharness-backend.jar');
  backend = spawn(existsSync(java) ? java : 'java', ['-Dfile.encoding=UTF-8', '-jar', jar, directory],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  createInterface({ input: backend.stdout }).on('line', line => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.event) {
      void observeAutomationEvent(message);
      if (message.event === 'done') activeRuns.delete(message.runId);
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
    for (const runId of activeRuns) {
      if (win && !win.isDestroyed()) {
        win.webContents.send('jh:event', { runId, event: 'error', data: { message: 'Java 后端已退出。' } });
        win.webContents.send('jh:event', { runId, event: 'done', data: {} });
      }
    }
    activeRuns.clear();
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
  const state = settings();
  const models = state.models.map(({ encryptedKey, ...model }) => ({
    ...model, fastTier: fastTier(model), effortLevels: effortLevels(model), initialEffort: resolveEffort(model),
    hasKey: Boolean(encryptedKey)
  }));
  return { projects: state.projects, models, defaultModelId: state.defaultModelId };
}

function migrateBookmarks() {
  if (!settings().bookmarks?.length) return Promise.resolve();
  if (!bookmarkMigration) {
    bookmarkMigration = call('importBookmarks', { bookmarks: settings().bookmarks }).then(() => {
      changeSettings(state => { delete state.bookmarks; });
    }).finally(() => { bookmarkMigration = undefined; });
  }
  return bookmarkMigration;
}

function modelInput(input) {
  const provider = input.provider === 'deepseek' ? 'deepseek' : 'compatible';
  const model = String(input.model || (provider === 'deepseek' ? 'deepseek-flash' : '')).trim();
  const baseUrl = provider === 'deepseek' ? 'https://api.deepseek.com' : String(input.baseUrl || '').trim();
  const saved = settings().models.find(item => item.id === input.id && item.provider === provider
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
  const profile = { provider, baseUrl, fastTier: input.fastTier };
  const tier = fastTier(profile);
  if (!['', 'fast', 'priority'].includes(tier)) throw new Error('无效的快速模式配置。');
  const efforts = Array.isArray(input.efforts) ? effortValues.filter(value => input.efforts.includes(value)) : undefined;
  return { provider, model, baseUrl, key, fastTier: tier, efforts };
}

function context(projectId, sessionId) {
  const project = settings().projects.find(item => item.id === projectId);
  if (!project || !project.sessions.some(item => item.id === sessionId)) throw new Error('找不到此会话。');
  return { projectId, sessionId, projectPath: project.directory };
}

function taskSessions() {
  return settings().projects.flatMap(project => project.sessions.map(session => ({
    projectId: project.id,
    sessionId: session.id,
    projectName: project.name,
    title: session.title
  })));
}

function conversationModel(options) {
  const state = settings();
  const profile = state.models.find(item => item.id === (options.modelId || state.defaultModelId));
  if (!profile) throw new Error('请先在设置中添加模型。');
  const model = modelInput(profile);
  const effort = resolveEffort(model, options.effort);
  const fast = options.fast === true;
  if (fast && !model.fastTier) throw new Error('当前模型未配置快速模式。');
  return { model, effort, fast };
}

function automationStatus(status) {
  if (status === 'ON_COMPLETE' || status === 'completed') return 'completed';
  if (status === 'suspended') return 'suspended';
  if (status === 'ON_ERROR' || status === 'failed') return 'failed';
  if (status === 'cancelled' || status === 'ON_CANCEL') return 'cancelled';
  if (status === 'interrupted') return 'interrupted';
  return 'completed';
}

async function observeAutomationEvent(message) {
  if (!automationStore) return;
  if (message.event === 'error') {
    await automationStore.finish(message.runId, 'failed', message.data?.message || '任务失败。');
  } else if (message.event === 'done') {
    await automationStore.finish(message.runId, automationStatus(message.data?.status));
  }
}

async function launchAutomationRun(run) {
  const project = settings().projects.find(item => item.id === run.projectId);
  const session = project?.sessions.find(item => item.id === run.sessionId);
  if (!project || !session) throw new Error('自动任务对应的项目或会话已被删除。');
  await automationStore.markRunning(run.runId);
  activeRuns.add(run.runId);
  try {
    const { model, effort, fast } = conversationModel({});
    await call('chat', {
      projectId: project.id,
      sessionId: session.id,
      projectPath: project.directory,
      ...model,
      message: run.prompt,
      runId: run.runId,
      parts: [],
      permission: 'durable',
      effort,
      autoMemory: project.autoMemory === true,
      serviceTier: fast ? model.fastTier : ''
    });
    changeSession(project.id, session.id, current => { current.updatedAt = Date.now(); });
    return true;
  } catch (error) {
    activeRuns.delete(run.runId);
    await automationStore.finish(run.runId, 'failed', error.message);
    throw error;
  }
}

async function tickAutomations() {
  if (automationTicking || !automationStore || !backend?.stdin.writable) return;
  automationTicking = true;
  try {
    const due = await automationStore.claimDue();
    for (const run of due) {
      try {
        await launchAutomationRun(run);
      } catch (error) {
        console.error('Automation failed:', run.automationName, error.message);
      }
    }
  } finally {
    automationTicking = false;
  }
}

async function initializeAutomations() {
  automationStore = createAutomationStore(path.join(app.getPath('userData'), 'automations.json'));
  await automationStore.recoverRunning();
  clearInterval(automationTimer);
  automationTimer = setInterval(() => { void tickAutomations(); }, 15000);
  void tickAutomations();
}

function register() {
  ipcMain.handle('jh:state', () => publicSettings());
  ipcMain.handle('jh:memory', (_, projectId, operation, input = {}) => {
    const project = settings().projects.find(item => item.id === projectId);
    if (!project) throw new Error('找不到项目。');
    if (operation === 'list') return call('memoryList', { projectId });
    if (operation === 'read') return call('memoryRead', { projectId, name: input.name, archive: input.archive === true });
    if (operation === 'search') return call('memorySearch', { projectId, query: input.query });
    if (activeRuns.size) throw new Error('请在当前任务结束后修改记忆设置。');
    if (operation === 'update') return call('memoryUpdate', { projectId, text: input.text, expected: input.expected });
    if (operation === 'auto') {
      return changeProject(projectId, current => {
        current.autoMemory = input.enabled === true;
        return current.autoMemory;
      });
    }
    throw new Error('未知的记忆操作。');
  });
  ipcMain.handle('jh:copy', (_, text) => {
    if (typeof text !== 'string') throw new Error('无法复制此内容。');
    clipboard.writeText(text);
  });
  ipcMain.handle('jh:bookmarks', async () => {
    await migrateBookmarks();
    return call('listBookmarks');
  });
  ipcMain.handle('jh:bookmark-add', async (_, { projectId, sessionId, messageId }) => {
    const selected = context(projectId, sessionId);
    await migrateBookmarks();
    return call('addBookmark', { ...selected, messageId });
  });
  ipcMain.handle('jh:bookmark-remove', async (_, id) => {
    await migrateBookmarks();
    return call('removeBookmark', { id });
  });
  ipcMain.handle('jh:search-sessions', (_, query) => {
    if (typeof query !== 'string' || !query.trim() || query.length > 160) return [];
    const sessions = settings().projects.flatMap(project => project.sessions.map(session => ({
      projectId: project.id, sessionId: session.id, projectName: project.name, title: session.title,
      updatedAt: session.updatedAt || 0
    }))).sort((a, b) => b.updatedAt - a.updatedAt);
    return call('searchSessions', { query, sessions });
  });
  ipcMain.handle('jh:git-review', async (_, projectId) => {
    const project = settings().projects.find(item => item.id === projectId);
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
  ipcMain.handle('jh:worktree-create', async (_, projectId, requestedName = '') => {
    const parent = settings().projects.find(item => item.id === projectId);
    if (!parent) throw new Error('找不到项目。');
    if (parent.worktree) throw new Error('不能从隔离工作树继续创建嵌套工作树。');
    const created = await managedWorktrees().create({
      projectRoot: parent.directory,
      label: typeof requestedName === 'string' ? requestedName : ''
    });
    const project = {
      id: randomUUID(),
      directory: created.path,
      name: parent.name + ' · ' + created.branch.replace(/^jharness\//, ''),
      sessions: [],
      worktree: {
        ...created,
        parentProjectId: parent.id,
        parentProjectName: parent.name
      }
    };
    try {
      changeSettings(state => state.projects.unshift(project));
    } catch (error) {
      await managedWorktrees().remove(created, { force: true }).catch(() => {});
      throw error;
    }
    return project;
  });
  ipcMain.handle('jh:worktree-status', async (_, projectId) => {
    const project = settings().projects.find(item => item.id === projectId);
    if (!project) throw new Error('找不到项目。');
    return project.worktree
      ? managedWorktrees().status(project.worktree)
      : managedWorktrees().source(project.directory);
  });
  ipcMain.handle('jh:worktree-review', async (_, projectId) => {
    const project = settings().projects.find(item => item.id === projectId);
    if (!project?.worktree) throw new Error('当前项目不是隔离工作树。');
    return managedWorktrees().review(project.worktree);
  });
  ipcMain.handle('jh:worktree-integrate', async (_, projectId) => {
    const project = settings().projects.find(item => item.id === projectId);
    if (!project?.worktree) throw new Error('当前项目不是隔离工作树。');
    const parent = settings().projects.find(item => item.id === project.worktree.parentProjectId);
    if (!parent || parent.worktree) throw new Error('找不到工作树的来源项目。');
    return managedWorktrees().integrate(project.worktree, parent.directory);
  });
  ipcMain.handle('jh:worktree-remove', async (_, projectId, force = false) => {
    const project = settings().projects.find(item => item.id === projectId);
    if (!project) throw new Error('找不到项目。');
    if (!project.worktree) throw new Error('当前项目不是隔离工作树。');
    await managedWorktrees().remove(project.worktree, { force: force === true });
    changeSettings(state => { state.projects = state.projects.filter(item => item.id !== projectId); });
    return true;
  });
  ipcMain.handle('jh:maintenance-status', () => maintenance.status(app.getPath('userData')));
  ipcMain.handle('jh:maintenance-create-backup', async () => {
    const selected = await dialog.showOpenDialog(win, {
      title: '选择备份保存位置',
      properties: ['openDirectory', 'createDirectory']
    });
    if (selected.canceled || !selected.filePaths[0]) return null;
    return maintenance.createBackup(app.getPath('userData'), selected.filePaths[0]);
  });
  ipcMain.handle('jh:maintenance-inspect-backup', async () => {
    const selected = await dialog.showOpenDialog(win, {
      title: '选择 JHarness 备份目录',
      properties: ['openDirectory']
    });
    if (selected.canceled || !selected.filePaths[0]) return null;
    return maintenance.inspectBackup(selected.filePaths[0]);
  });
  ipcMain.handle('jh:maintenance-restore', async (_, backupDirectory) => {
    if (activeRuns.size) throw new Error('请等待所有任务结束后再恢复数据。');
    const result = await maintenance.restoreBackup(app.getPath('userData'), backupDirectory);
    setTimeout(() => {
      app.relaunch();
      app.exit(0);
    }, 900);
    return result;
  });
  ipcMain.handle('jh:maintenance-open-data', () => shell.openPath(app.getPath('userData')));
  ipcMain.handle('jh:automations', async () => {
    if (!automationStore) throw new Error('自动任务调度尚未启动。');
    return automationStore.list();
  });
  ipcMain.handle('jh:automation-create', async (_, input = {}) => {
    if (!automationStore) throw new Error('自动任务调度尚未启动。');
    const project = settings().projects.find(item => item.id === input.projectId);
    if (!project) throw new Error('找不到自动任务项目。');
    const session = {
      id: randomUUID(),
      title: '自动任务 · ' + String(input.name || '未命名').slice(0, 40),
      permission: 'durable',
      automation: true,
      updatedAt: Date.now()
    };
    changeProject(project.id, current => current.sessions.unshift(session));
    try {
      return await automationStore.create({
        name: input.name,
        prompt: input.prompt,
        projectId: project.id,
        sessionId: session.id,
        scheduleType: input.scheduleType,
        intervalMinutes: input.intervalMinutes,
        runAt: Number(input.runAt)
      });
    } catch (error) {
      changeProject(project.id, current => {
        current.sessions = current.sessions.filter(item => item.id !== session.id);
      });
      throw error;
    }
  });
  ipcMain.handle('jh:automation-update', (_, id, patch = {}) => {
    if (!automationStore) throw new Error('自动任务调度尚未启动。');
    return automationStore.update(id, patch);
  });
  ipcMain.handle('jh:automation-remove', (_, id) => {
    if (!automationStore) throw new Error('自动任务调度尚未启动。');
    return automationStore.remove(id);
  });
  ipcMain.handle('jh:automation-run', async (_, id) => {
    if (!automationStore) throw new Error('自动任务调度尚未启动。');
    const run = await automationStore.runNow(id);
    await launchAutomationRun(run);
    return run;
  });
  ipcMain.handle('jh:automation-retry', async (_, runId) => {
    if (!automationStore) throw new Error('自动任务调度尚未启动。');
    const run = await automationStore.retry(runId);
    await launchAutomationRun(run);
    return run;
  });
  ipcMain.handle('jh:automation-cancel', async (_, runId) => {
    if (!automationStore) throw new Error('自动任务调度尚未启动。');
    await call('stop', { runId });
    activeRuns.delete(runId);
    return automationStore.finish(runId, 'cancelled');
  });
  ipcMain.handle('jh:project', async () => {
    const result = await dialog.showOpenDialog(win, { title: '打开项目', properties: ['openDirectory'] });
    if (result.canceled) return null;
    const directory = result.filePaths[0];
    return changeSettings(state => findProject(state, directory)
      || addProject(state, directory, legacyProject(dataDirectory, directory)));
  });
  ipcMain.handle('jh:session', (_, projectId) => {
    const project = settings().projects.find(item => item.id === projectId);
    if (!project) throw new Error('请先打开一个项目。');
    const session = { id: randomUUID(), title: '新会话' };
    changeProject(project.id, current => current.sessions.unshift(session));
    return session;
  });
  ipcMain.handle('jh:history', (_, project, session) => call('history', context(project, session)));
  ipcMain.handle('jh:context', (_, project, session) => call('context', context(project, session)));
  ipcMain.handle('jh:checkpoints', (_, projectId, sessionId = '') => {
    const project = settings().projects.find(item => item.id === projectId);
    if (!project) throw new Error('找不到项目。');
    return call('checkpoints', { projectId, projectPath: project.directory, sessionId });
  });
  ipcMain.handle('jh:checkpoint', (_, projectId, checkpointId) => {
    const project = settings().projects.find(item => item.id === projectId);
    if (!project) throw new Error('找不到项目。');
    return call('checkpoint', { projectId, projectPath: project.directory, checkpointId });
  });
  ipcMain.handle('jh:restore-checkpoint', (_, projectId, checkpointId) => {
    const project = settings().projects.find(item => item.id === projectId);
    if (!project) throw new Error('找不到项目。');
    return call('restoreCheckpoint', { projectId, projectPath: project.directory, checkpointId });
  });
  ipcMain.handle('jh:preview-change-set', (_, projectId, sessionId, runId) =>
    call('previewChangeSet', { ...context(projectId, sessionId), runId }));
  ipcMain.handle('jh:restore-change-set', (_, projectId, sessionId, runId) =>
    call('restoreChangeSet', { ...context(projectId, sessionId), runId }));
  ipcMain.handle('jh:change-sets', (_, projectId, sessionId, runId) =>
    call('changeSets', { ...context(projectId, sessionId), runId }));
  ipcMain.handle('jh:report', (_, projectId, sessionId) =>
    call('taskReport', context(projectId, sessionId)));
  ipcMain.handle('jh:verify-criterion', (_, projectId, sessionId, runId, criterionId, commandId, jsonSchema) => {
    const evidence = { ...context(projectId, sessionId), runId, criterionId, commandId };
    return jsonSchema == null
      ? call('verifyCriterion', { ...evidence, expectedExitCode: 0 })
      : call('verifyJsonCriterion', { ...evidence, jsonSchema });
  });
  ipcMain.handle('jh:open-artifact', async (_, projectId, sessionId, artifactId) => {
    const selected = context(projectId, sessionId);
    const artifact = await call('taskArtifact', { ...selected, artifactId });
    if (!existsSync(artifact.filePath)) throw new Error('交付物文件已被移动或删除。');
    const error = await shell.openPath(artifact.filePath);
    if (error) throw new Error('无法打开交付物：' + error);
    return true;
  });
  ipcMain.handle('jh:export-session', async (_, projectId, sessionId, format, title) => {
    const selected = context(projectId, sessionId);
    if (!['markdown', 'json'].includes(format)) throw new Error('不支持的导出格式。');
    const exported = await call('exportSession', {
      ...selected,
      format,
      title: typeof title === 'string' ? title.slice(0, 200) : ''
    });
    const result = await dialog.showSaveDialog(win, {
      title: '导出会话',
      defaultPath: path.join(app.getPath('documents'), exported.filename),
      filters: [format === 'markdown'
        ? { name: 'Markdown', extensions: ['md'] }
        : { name: 'JSON', extensions: ['json'] }]
    });
    if (result.canceled || !result.filePath) return null;
    writeFileSync(result.filePath, exported.content, 'utf8');
    return {
      path: result.filePath,
      format: exported.format,
      messages: exported.messages,
      events: exported.events
    };
  });
  ipcMain.handle('jh:fork-session', async (_, projectId, sessionId, messageId) => {
    const selected = context(projectId, sessionId);
    const project = settings().projects.find(item => item.id === projectId);
    const source = project.sessions.find(item => item.id === sessionId);
    const branchSessionId = randomUUID();
    await call('forkSession', { ...selected, branchSessionId, messageId });
    const branch = {
      id: branchSessionId,
      title: (source.title === '新会话' ? '会话' : source.title) + ' · 分叉',
      modelId: source.modelId || '',
      effort: source.effort || '',
      fast: source.fast === true,
      permission: source.permission || 'assist',
      branchOf: sessionId,
      updatedAt: Date.now()
    };
    changeProject(projectId, current => current.sessions.unshift(branch));
    return branch;
  });
  ipcMain.handle('jh:attachment', async (_, projectId, kind) => {
    const project = settings().projects.find(item => item.id === projectId);
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
    const project = settings().projects.find(item => item.id === projectId);
    if (!project) return [];
    return (await projectParts(project.directory)).map(({ text, ...part }) => ({ ...part, label: label(part) }));
  });
  ipcMain.handle('jh:external-plugins', () => call('listExternalPlugins'));
  ipcMain.handle('jh:install-external-plugin', async () => {
    const result = await dialog.showOpenDialog(win, {
      title: '安装工具插件',
      properties: ['openDirectory']
    });
    if (result.canceled || !result.filePaths[0]) return null;
    return call('installExternalPlugin', { directory: result.filePaths[0] });
  });
  ipcMain.handle('jh:set-external-plugin', (_, pluginId, enabled) =>
    call('setExternalPluginEnabled', { pluginId, enabled: enabled === true }));
  ipcMain.handle('jh:uninstall-external-plugin', (_, pluginId) =>
    call('uninstallExternalPlugin', { pluginId }));
  ipcMain.handle('jh:test-model', (_, input) => {
    const model = modelInput(input);
    const effort = resolveEffort(model, input.testEffort);
    return call('testModel', { ...model, effort, serviceTier: input.testFast ? model.fastTier : '' });
  });
  ipcMain.handle('jh:save-model', (_, input) => {
    const { key, ...model } = modelInput(input);
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows 凭证保护不可用。');
    const savedModelId = changeSettings(state => {
      const index = state.models.findIndex(item => item.id === input.id);
      const id = index < 0 ? randomUUID() : input.id;
      const profile = { id, ...model, encryptedKey: safeStorage.encryptString(key).toString('base64') };
      if (index < 0) state.models.push(profile);
      else state.models[index] = profile;
      if (!state.defaultModelId || input.makeDefault) state.defaultModelId = id;
      return id;
    });
    return { ...publicSettings(), savedModelId };
  });
  ipcMain.handle('jh:chat', async (_, projectId, sessionId, message, runId, options = {}) => {
    const selected = context(projectId, sessionId);
    const { model, effort, fast } = conversationModel(options);
    const permission = ['ask', 'assist', 'full', 'durable'].includes(options.permission) ? options.permission : 'assist';
    if (typeof message !== 'string' || !message.trim() || message.length > 16000) {
      throw new Error('请输入 16,000 字符以内的消息。');
    }
    activeRuns.add(runId);
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
      const autoMemory = settings().projects.find(item => item.id === projectId).autoMemory === true;
      await call('chat', { ...selected, ...model, message, runId, parts, permission, effort, autoMemory,
        serviceTier: fast ? model.fastTier : '' });
      const title = changeSession(projectId, sessionId, session => {
        if (session.title === '新会话') session.title = message.trim().replace(/\s+/g, ' ').slice(0, 40);
        Object.assign(session, { modelId: options.modelId || '', effort, fast, permission, updatedAt: Date.now() });
        return session.title;
      });
      for (const part of requested) attachments.delete(part.id);
      return title;
    } catch (error) {
      activeRuns.delete(runId);
      throw error;
    }
  });
  ipcMain.handle('jh:task', (_, projectId, sessionId) => call('task', context(projectId, sessionId)));
  ipcMain.handle('jh:tasks', () => call('tasks', { sessions: taskSessions() }));
  ipcMain.handle('jh:steer', (_, runId, message) => {
    if (typeof message !== 'string' || !message.trim() || message.length > 16000) {
      throw new Error('补充指令需要在 16,000 字符以内。');
    }
    return call('steer', { runId, message });
  });
  ipcMain.handle('jh:queue-task', async (_, projectId, sessionId, message, runId, options = {}) => {
    const selected = context(projectId, sessionId);
    const { model, effort, fast } = conversationModel(options);
    if (typeof message !== 'string' || !message.trim() || message.length > 16000) {
      throw new Error('请输入 16,000 字符以内的消息。');
    }
    const autoMemory = settings().projects.find(item => item.id === projectId).autoMemory === true;
    activeRuns.add(runId);
    try {
      await call('chat', { ...selected, ...model, message, runId, parts: [], permission: 'durable', effort,
        autoMemory, serviceTier: fast ? model.fastTier : '' });
      changeSession(projectId, sessionId, session => {
        if (session.title === '新会话') session.title = message.trim().replace(/\s+/g, ' ').slice(0, 40);
        Object.assign(session, { modelId: options.modelId || '', effort, fast, permission: 'durable', updatedAt: Date.now() });
      });
      return true;
    } catch (error) {
      activeRuns.delete(runId);
      throw error;
    }
  });
  ipcMain.handle('jh:resume-task', async (_, projectId, sessionId, turnId, runId, answers = {}, options = {}) => {
    const selected = context(projectId, sessionId);
    if (!answers || typeof answers !== 'object' || Array.isArray(answers)
      || Object.values(answers).some(answer => typeof answer !== 'boolean')) {
      throw new Error('审批选择无效。');
    }
    const { model, effort, fast } = conversationModel(options);
    const autoMemory = settings().projects.find(item => item.id === projectId).autoMemory === true;
    activeRuns.add(runId);
    try {
      return await call('resumeTask', { ...selected, ...model, turnId, runId, answers, effort, autoMemory,
        serviceTier: fast ? model.fastTier : '' });
    } catch (error) {
      activeRuns.delete(runId);
      throw error;
    }
  });
  ipcMain.handle('jh:reconcile-task', async (_, projectId, sessionId, turnId, runId,
    answers = {}, outcomes = {}, options = {}) => {
    const selected = context(projectId, sessionId);
    if (!answers || typeof answers !== 'object' || Array.isArray(answers)
      || Object.values(answers).some(answer => typeof answer !== 'boolean')) {
      throw new Error('审批选择无效。');
    }
    if (!outcomes || typeof outcomes !== 'object' || Array.isArray(outcomes)
      || Object.values(outcomes).some(outcome => !['success', 'error'].includes(outcome))) {
      throw new Error('请逐项确认工具操作的核对结果。');
    }
    const { model, effort, fast } = conversationModel(options);
    const autoMemory = settings().projects.find(item => item.id === projectId).autoMemory === true;
    activeRuns.add(runId);
    try {
      return await call('reconcileTask', { ...selected, ...model, turnId, runId, answers, outcomes,
        effort, autoMemory, serviceTier: fast ? model.fastTier : '' });
    } catch (error) {
      activeRuns.delete(runId);
      throw error;
    }
  });
  ipcMain.handle('jh:cancel-task', (_, projectId, sessionId, turnId) =>
    call('cancelTask', { ...context(projectId, sessionId), turnId }));
  ipcMain.handle('jh:stop', (_, runId) => call('stop', { runId }));
  ipcMain.handle('jh:approve', (_, runId, approvalId, allow) =>
    call('approve', { runId, approvalId, allow: allow === true }));
  ipcMain.handle('jh:list-interrupted-approvals', async (_, projectId) => {
    if (!settings().projects.some(item => item.id === projectId)) throw new Error('找不到项目。');
    const approvals = await call('approvals', { projectId });
    return approvals.filter(item => item.status === 'INTERRUPTED');
  });
  ipcMain.handle('jh:dismiss-interrupted-approval', (_, projectId, approvalId) => {
    if (!settings().projects.some(item => item.id === projectId)) throw new Error('找不到项目。');
    return call('dismissApproval', { projectId, approvalId });
  });
}

async function smokeInterruptedApproval() {
  async function waitFor(check, message) {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const value = check();
      if (value) return value;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(message);
  }

  const selector = 'details.interrupted-approvals';
  const details = await waitFor(() => document.querySelector(selector), 'Interrupted approval did not render');
  const summary = details.querySelector('summary');
  summary.click();
  const dismiss = [...details.querySelectorAll('button')].find(button => button.textContent.trim() === '清除记录');
  if (!details.open || !dismiss) throw new Error('Interrupted approval details could not be opened');
  const result = { heading: summary.innerText, text: details.innerText, url: location.href };
  dismiss.click();
  await waitFor(() => !document.querySelector(selector), 'Dismissed approval still renders');
  const contextButton = [...document.querySelectorAll('button')]
    .find(button => button.title === '上下文');
  if (!contextButton) throw new Error('Context entry missing');
  contextButton.click();
  const contextDialog = await waitFor(
    () => document.querySelector('dialog.nav-context'), 'Context dialog did not open');
  await waitFor(
    () => contextDialog.innerText.includes('当前会话还没有模型请求记录'),
    'Context empty state did not load');
  result.context = contextDialog.innerText;
  contextDialog.querySelector('.dialog-head button').click();
  const reportButton = [...document.querySelectorAll('button')]
    .find(button => button.title === '任务报告');
  if (!reportButton) throw new Error('Task report entry missing');
  reportButton.click();
  const reportDialog = await waitFor(
    () => document.querySelector('dialog.nav-reports'), 'Task report dialog did not open');
  await waitFor(
    () => reportDialog.innerText.includes('当前会话还没有任务报告'),
    'Task report empty state did not load');
  result.reports = reportDialog.innerText;
  reportDialog.querySelector('.dialog-head button').click();
  const worktreeButton = [...document.querySelectorAll('button')]
    .find(button => button.title === '隔离工作树');
  if (!worktreeButton) throw new Error('Worktree entry missing');
  worktreeButton.click();
  const worktreeDialog = await waitFor(
    () => document.querySelector('dialog.nav-worktrees'), 'Worktree dialog did not open');
  await waitFor(
    () => worktreeDialog.innerText.includes('隔离工作树'),
    'Worktree panel did not render');
  result.worktrees = worktreeDialog.innerText;
  worktreeDialog.querySelector('.dialog-head button').click();
  const automationButton = [...document.querySelectorAll('button')]
    .find(button => button.title === '自动任务');
  if (!automationButton) throw new Error('Automation entry missing');
  automationButton.click();
  const automationDialog = await waitFor(
    () => document.querySelector('dialog.nav-automations'), 'Automation dialog did not open');
  await waitFor(
    () => automationDialog.innerText.includes('当前项目还没有自动任务'),
    'Automation empty state did not load');
  result.automations = automationDialog.innerText;
  automationDialog.querySelector('.dialog-head button').click();
  const maintenanceButton = [...document.querySelectorAll('button')]
    .find(button => button.title === '数据与运维');
  if (!maintenanceButton) throw new Error('Maintenance entry missing');
  maintenanceButton.click();
  const maintenanceDialog = await waitFor(
    () => document.querySelector('dialog.nav-maintenance'), 'Maintenance dialog did not open');
  await waitFor(
    () => maintenanceDialog.innerText.includes('本地数据与恢复'),
    'Maintenance panel did not render');
  result.maintenance = maintenanceDialog.innerText;
  maintenanceDialog.querySelector('.dialog-head button').click();
  const checkpointButton = [...document.querySelectorAll('button')]
    .find(button => button.title === '检查点');
  if (!checkpointButton) throw new Error('Checkpoint entry missing');
  checkpointButton.click();
  const checkpointDialog = await waitFor(
    () => document.querySelector('dialog.nav-checkpoints'), 'Checkpoint dialog did not open');
  await waitFor(
    () => checkpointDialog.innerText.includes('当前会话还没有文件检查点'),
    'Checkpoint empty state did not load');
  result.checkpoints = checkpointDialog.innerText;
  return result;
}

async function smokeTaskCenter() {
  async function waitFor(check, message) {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const value = check();
      if (value) return value;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(message);
  }
  const button = await waitFor(() => document.querySelector('button[title="任务中心"]'), 'Task center entry missing');
  button.click();
  const dialog = await waitFor(() => document.querySelector('dialog.nav-tasks'), 'Task center did not open');
  await waitFor(() => dialog.innerText.includes('没有运行中或等待处理的任务'), 'Task center did not load');
  dialog.querySelector('.dialog-head button').click();
  const pluginButton = await waitFor(
    () => document.querySelector('button[title="Skills 与插件"]'), 'Plugin entry missing');
  pluginButton.click();
  const pluginDialog = await waitFor(
    () => document.querySelector('dialog.nav-plugins'), 'Plugin dialog did not open');
  await waitFor(
    () => pluginDialog.innerText.includes('尚未显式安装外部工具插件'),
    'External plugin empty state did not load');
  return {
    title: document.title,
    text: document.body.innerText,
    taskCenter: dialog.innerText,
    plugins: pluginDialog.innerText,
    url: location.href
  };
}

async function smokeRecoverableTask() {
  async function waitFor(check, message) {
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      const value = check();
      if (value) return value;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(message);
  }
  const task = await waitFor(
    () => document.querySelector('section.recoverable-task'),
    'Recoverable task did not render');
  await waitFor(
    () => task.innerText.includes('任务等待审批'),
    'Recoverable task did not expose suspended state');
  return {
    title: document.title,
    text: document.body.innerText,
    task: task.innerText,
    url: location.href
  };
}

async function smokeConversationStage(stage, fixture) {
  async function waitFor(check, message) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const value = check();
      if (value) return value;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const detail = document.querySelector('dialog[open] .error-text, .notice[role="alert"]');
    throw new Error(message + (detail ? ': ' + detail.innerText : ''));
  }

  function button(root, text) {
    return Array.from(root.querySelectorAll('button')).find(element => element.innerText.trim() === text);
  }

  function setValue(element, prototype, value, type = 'input') {
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value);
    element.dispatchEvent(new Event(type, { bubbles: true }));
  }

  const send = () => document.querySelector('.composer button[aria-label="发送"]');
  const reply = text => Array.from(document.querySelectorAll('.assistant-msg'))
    .find(message => message.innerText.trim() === text);
  const approval = () => Array.from(document.querySelectorAll('.approvals .approval-card'))
    .find(card => card.querySelector('code')?.innerText === fixture.file);

  if (stage === 'send') {
    const settingsButton = await waitFor(
      () => document.querySelector('button[aria-label="设置"]'), 'Model settings button missing');
    settingsButton.click();
    const dialog = await waitFor(
      () => document.querySelector('dialog[open]'), 'Model settings dialog did not open');
    setValue(dialog.querySelector('select'), HTMLSelectElement.prototype, 'compatible', 'change');
    const endpoint = await waitFor(
      () => dialog.querySelector('input[type="url"]'), 'Compatible provider did not expose its endpoint');
    setValue(endpoint, HTMLInputElement.prototype, fixture.endpoint);
    setValue(dialog.querySelector('input[required]:not([type])'), HTMLInputElement.prototype, fixture.model);
    setValue(dialog.querySelector('input[type="password"]'), HTMLInputElement.prototype, fixture.key);
    button(dialog, '测试连接').click();
    await waitFor(() => dialog.querySelector('.success-text')?.innerText.includes(fixture.model),
      'Connection test did not receive the mock model reply');
    button(dialog, '保存').click();
    await waitFor(() => !dialog.isConnected, 'Model settings did not save');

    const project = await waitFor(
      () => document.querySelector('.project-name'), 'Project picker did not load the fixture project');
    project.click();
    const permission = await waitFor(
      () => document.querySelector('.permission-button'), 'Permission picker missing');
    permission.click();
    const ask = await waitFor(
      () => document.querySelector('.permission-menu button.mode-ask'), 'Ask permission option missing');
    ask.click();
    const input = await waitFor(
      () => document.querySelector('.composer textarea:not(:disabled)'), 'Composer did not open the project');
    setValue(input, HTMLTextAreaElement.prototype, fixture.prompt);
    const submit = await waitFor(() => send() && !send().disabled && send(), 'Prompt could not be submitted');
    submit.click();
    await waitFor(() => reply(fixture.lead), 'The first stream chunk did not render');
    return;
  }

  if (stage === 'review') {
    const card = await waitFor(approval, 'The file creation approval did not render');
    card.querySelector('summary').click();
    await waitFor(() => card.querySelector('details[open] .after')?.innerText === fixture.content,
      'Approval did not display the proposed file contents');
    return;
  }

  if (stage === 'approve') {
    button(approval(), '批准这一次').click();
    await waitFor(() => reply(fixture.reply) && send() && !approval(),
      'The approved task did not finish in the conversation');
  }

  await waitFor(() => document.querySelector('.user-msg')?.innerText === fixture.prompt && reply(fixture.reply),
    'Chat history did not contain the saved prompt and reply');
  const saved = await waitFor(() => Array.from(document.querySelectorAll('.recent-session'))
    .find(session => session.innerText.trim() === fixture.prompt),
    'The completed conversation did not appear under recent sessions');
  return { prompt: document.querySelector('.user-msg').innerText, reply: reply(fixture.reply).innerText.trim(),
    session: saved.innerText.trim(), url: location.href };
}

async function smokeDesktopConversation(reopen) {
  const data = process.env.JHARNESS_SMOKE_DATA;
  if (!data) throw new Error('The conversation smoke test requires an isolated data directory');
  const fixture = JSON.parse(process.env.JHARNESS_SMOKE_CONVERSATION);
  async function runStage(stage) {
    try {
      return await win.webContents.executeJavaScript(
        `(${smokeConversationStage.toString()})(${JSON.stringify(stage)}, ${JSON.stringify(fixture)})`);
    } catch (error) {
      throw new Error(stage + ': ' + error.message);
    }
  }
  if (reopen) return runStage('reopen');

  await runStage('send');
  console.log('JHARNESS_SMOKE_STREAM_VISIBLE');
  await runStage('review');
  if (existsSync(path.join(data, 'project', fixture.file))) {
    throw new Error('The file was written while approval was pending');
  }
  return runStage('approve');
}

app.setName('JHarness');
if (smokeMode && process.env.JHARNESS_SMOKE_DATA) {
  app.setPath('userData', path.resolve(process.env.JHARNESS_SMOKE_DATA));
}
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
    dataDirectory = directory;
    changeSettings(state => {
      if (!Array.isArray(state.models)) {
        const legacy = state.model?.encryptedKey ? { id: randomUUID(), ...state.model } : null;
        state.models = legacy ? [legacy] : [];
        state.defaultModelId = legacy?.id;
        delete state.model;
      }
    });
    register();
    startBackend(path.join(directory, 'workspaces'));
    void initializeAutomations().catch(error => {
      console.error('Automation scheduler failed:', error.message);
    });
    win = new BrowserWindow({
      width: 1240, height: 830, minWidth: 780, minHeight: 570,
      backgroundColor: '#fcfcfb', autoHideMenuBar: true,
      show: !smokeMode,
      webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true,
        nodeIntegration: false, sandbox: true }
    });
    if (smokeMode) {
      win.webContents.on('did-fail-load', (_, code, description) => {
        console.error('JHARNESS_SMOKE_ERROR ' + code + ' ' + description);
        app.exit(1);
      });
      win.webContents.once('did-finish-load', () => {
        const testApproval = process.argv.includes('--jharness-smoke-approval');
        const testTask = process.argv.includes('--jharness-smoke-task');
        const testConversation = process.argv.includes('--jharness-smoke-conversation');
        const reopenConversation = process.argv.includes('--jharness-smoke-reopen');
        const script = testApproval
          ? `(${smokeInterruptedApproval.toString()})()`
          : testTask
            ? `(${smokeRecoverableTask.toString()})()`
            : `(${smokeTaskCenter.toString()})()`;
        setTimeout(() => {
          const verification = testConversation || reopenConversation
            ? smokeDesktopConversation(reopenConversation) : win.webContents.executeJavaScript(script);
          verification
            .then(result => {
              console.log('JHARNESS_SMOKE_OK ' + JSON.stringify(result));
              app.quit();
            })
            .catch(error => {
              console.error('JHARNESS_SMOKE_ERROR ' + error.message);
              app.exit(1);
            });
        }, testApproval || testConversation || reopenConversation ? 0 : 1200);
      });
    }
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', event => event.preventDefault());
    const ui = app.isPackaged
      ? path.join(__dirname, '..', 'dist', 'index.html')
      : path.join(__dirname, '..', '..', '..', 'dist', 'index.html');
    win.loadFile(ui);
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
  clearInterval(automationTimer);
  const child = backend;
  for (const runId of activeRuns) call('stop', { runId }).catch(() => {});
  child.stdin.end();
  const timer = setTimeout(() => { child.kill(); app.quit(); }, 1800);
  child.once('exit', () => { clearTimeout(timer); app.quit(); });
});

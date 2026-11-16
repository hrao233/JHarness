const { app, BrowserWindow, clipboard, dialog, ipcMain, safeStorage, shell } = require('electron');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const { randomUUID } = require('node:crypto');
const { createInterface } = require('node:readline');
const { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } = require('node:fs');
const path = require('node:path');
const { importAttachment, projectParts, label } = require('./context-parts.cjs');
const { createManager } = require('./worktree-manager.cjs');
const git = promisify(execFile);

let win;
let backend;
const activeRuns = new Set();
let settings;
let settingsFile;
let quitting = false;
let bookmarkMigration;
let worktreeManager;
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

function persist() {
  const temporary = settingsFile + '.tmp';
  writeFileSync(temporary, JSON.stringify(settings, null, 2), 'utf8');
  renameSync(temporary, settingsFile);
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
  const models = settings.models.map(({ encryptedKey, ...model }) => ({
    ...model, fastTier: fastTier(model), effortLevels: effortLevels(model), initialEffort: resolveEffort(model),
    hasKey: Boolean(encryptedKey)
  }));
  return { projects: settings.projects, models, defaultModelId: settings.defaultModelId };
}

function migrateBookmarks() {
  if (!settings.bookmarks?.length) return Promise.resolve();
  if (!bookmarkMigration) {
    bookmarkMigration = call('importBookmarks', { bookmarks: settings.bookmarks }).then(() => {
      const previous = settings.bookmarks;
      delete settings.bookmarks;
      try {
        persist();
      } catch (error) {
        settings.bookmarks = previous;
        throw error;
      }
    }).finally(() => { bookmarkMigration = undefined; });
  }
  return bookmarkMigration;
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
  const profile = { provider, baseUrl, fastTier: input.fastTier };
  const tier = fastTier(profile);
  if (!['', 'fast', 'priority'].includes(tier)) throw new Error('无效的快速模式配置。');
  const efforts = Array.isArray(input.efforts) ? effortValues.filter(value => input.efforts.includes(value)) : undefined;
  return { provider, model, baseUrl, key, fastTier: tier, efforts };
}

function context(projectId, sessionId) {
  const project = settings.projects.find(item => item.id === projectId);
  if (!project || !project.sessions.some(item => item.id === sessionId)) throw new Error('找不到此会话。');
  return { projectId, sessionId, projectPath: project.directory };
}

function taskSessions() {
  return settings.projects.flatMap(project => project.sessions.map(session => ({
    projectId: project.id,
    sessionId: session.id,
    projectName: project.name,
    title: session.title
  })));
}

function conversationModel(options) {
  const profile = settings.models.find(item => item.id === (options.modelId || settings.defaultModelId));
  if (!profile) throw new Error('请先在设置中添加模型。');
  const model = modelInput(profile);
  const effort = resolveEffort(model, options.effort);
  const fast = options.fast === true;
  if (fast && !model.fastTier) throw new Error('当前模型未配置快速模式。');
  return { model, effort, fast };
}

function register() {
  ipcMain.handle('jh:state', () => publicSettings());
  ipcMain.handle('jh:memory', (_, projectId, operation, input = {}) => {
    const project = settings.projects.find(item => item.id === projectId);
    if (!project) throw new Error('找不到项目。');
    if (operation === 'list') return call('memoryList', { projectId });
    if (operation === 'read') return call('memoryRead', { projectId, name: input.name, archive: input.archive === true });
    if (operation === 'search') return call('memorySearch', { projectId, query: input.query });
    if (activeRuns.size) throw new Error('请在当前任务结束后修改记忆设置。');
    if (operation === 'update') return call('memoryUpdate', { projectId, text: input.text, expected: input.expected });
    if (operation === 'auto') {
      project.autoMemory = input.enabled === true;
      persist();
      return project.autoMemory;
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
    const sessions = settings.projects.flatMap(project => project.sessions.map(session => ({
      projectId: project.id, sessionId: session.id, projectName: project.name, title: session.title,
      updatedAt: session.updatedAt || 0
    }))).sort((a, b) => b.updatedAt - a.updatedAt);
    return call('searchSessions', { query, sessions });
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
  ipcMain.handle('jh:worktree-create', async (_, projectId, requestedName = '') => {
    const parent = settings.projects.find(item => item.id === projectId);
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
    settings.projects.unshift(project);
    try {
      persist();
    } catch (error) {
      settings.projects.shift();
      await managedWorktrees().remove(created, { force: true }).catch(() => {});
      throw error;
    }
    return project;
  });
  ipcMain.handle('jh:worktree-status', async (_, projectId) => {
    const project = settings.projects.find(item => item.id === projectId);
    if (!project) throw new Error('找不到项目。');
    return project.worktree
      ? managedWorktrees().status(project.worktree)
      : managedWorktrees().source(project.directory);
  });
  ipcMain.handle('jh:worktree-remove', async (_, projectId, force = false) => {
    const index = settings.projects.findIndex(item => item.id === projectId);
    const project = settings.projects[index];
    if (!project) throw new Error('找不到项目。');
    if (!project.worktree) throw new Error('当前项目不是隔离工作树。');
    await managedWorktrees().remove(project.worktree, { force: force === true });
    settings.projects.splice(index, 1);
    try {
      persist();
    } catch (error) {
      settings.projects.splice(index, 0, project);
      throw error;
    }
    return true;
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
  ipcMain.handle('jh:context', (_, project, session) => call('context', context(project, session)));
  ipcMain.handle('jh:checkpoints', (_, projectId, sessionId = '') => {
    const project = settings.projects.find(item => item.id === projectId);
    if (!project) throw new Error('找不到项目。');
    return call('checkpoints', { projectId, projectPath: project.directory, sessionId });
  });
  ipcMain.handle('jh:checkpoint', (_, projectId, checkpointId) => {
    const project = settings.projects.find(item => item.id === projectId);
    if (!project) throw new Error('找不到项目。');
    return call('checkpoint', { projectId, projectPath: project.directory, checkpointId });
  });
  ipcMain.handle('jh:restore-checkpoint', (_, projectId, checkpointId) => {
    const project = settings.projects.find(item => item.id === projectId);
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
    const project = settings.projects.find(item => item.id === projectId);
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
    project.sessions.unshift(branch);
    persist();
    return branch;
  });
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
      const session = settings.projects.find(item => item.id === projectId).sessions.find(item => item.id === sessionId);
      const autoMemory = settings.projects.find(item => item.id === projectId).autoMemory === true;
      await call('chat', { ...selected, ...model, message, runId, parts, permission, effort, autoMemory,
        serviceTier: fast ? model.fastTier : '' });
      if (session.title === '新会话') session.title = message.trim().replace(/\s+/g, ' ').slice(0, 40);
      Object.assign(session, { modelId: options.modelId || '', effort, fast, permission, updatedAt: Date.now() });
      persist();
      for (const part of requested) attachments.delete(part.id);
      return session.title;
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
    const autoMemory = settings.projects.find(item => item.id === projectId).autoMemory === true;
    activeRuns.add(runId);
    try {
      await call('chat', { ...selected, ...model, message, runId, parts: [], permission: 'durable', effort,
        autoMemory, serviceTier: fast ? model.fastTier : '' });
      const session = settings.projects.find(item => item.id === projectId).sessions
        .find(item => item.id === sessionId);
      if (session.title === '新会话') session.title = message.trim().replace(/\s+/g, ' ').slice(0, 40);
      Object.assign(session, { modelId: options.modelId || '', effort, fast, permission: 'durable', updatedAt: Date.now() });
      persist();
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
    const autoMemory = settings.projects.find(item => item.id === projectId).autoMemory === true;
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
    const autoMemory = settings.projects.find(item => item.id === projectId).autoMemory === true;
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
    if (!settings.projects.some(item => item.id === projectId)) throw new Error('找不到项目。');
    const approvals = await call('approvals', { projectId });
    return approvals.filter(item => item.status === 'INTERRUPTED');
  });
  ipcMain.handle('jh:dismiss-interrupted-approval', (_, projectId, approvalId) => {
    if (!settings.projects.some(item => item.id === projectId)) throw new Error('找不到项目。');
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
        const script = testApproval
          ? `(${smokeInterruptedApproval.toString()})()`
          : testTask
            ? `(${smokeRecoverableTask.toString()})()`
            : `(${smokeTaskCenter.toString()})()`;
        setTimeout(() => {
          win.webContents.executeJavaScript(script)
            .then(result => {
              console.log('JHARNESS_SMOKE_OK ' + JSON.stringify(result));
              app.quit();
            })
            .catch(error => {
              console.error('JHARNESS_SMOKE_ERROR ' + error.message);
              app.exit(1);
            });
        }, testApproval ? 0 : 1200);
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
  const child = backend;
  for (const runId of activeRuns) call('stop', { runId }).catch(() => {});
  child.stdin.end();
  const timer = setTimeout(() => { child.kill(); app.quit(); }, 1800);
  child.once('exit', () => { clearTimeout(timer); app.quit(); });
});

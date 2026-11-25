const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('jharness', {
  state: () => ipcRenderer.invoke('jh:state'),
  openProject: () => ipcRenderer.invoke('jh:project'),
  newSession: (project, preferredId) => ipcRenderer.invoke('jh:session', project, preferredId),
  history: (project, session) => ipcRenderer.invoke('jh:history', project, session),
  context: (project, session) => ipcRenderer.invoke('jh:context', project, session),
  checkpoints: (project, session = '') => ipcRenderer.invoke('jh:checkpoints', project, session),
  checkpoint: (project, id) => ipcRenderer.invoke('jh:checkpoint', project, id),
  restoreCheckpoint: (project, id) => ipcRenderer.invoke('jh:restore-checkpoint', project, id),
  previewChangeSet: (project, session, runId) =>
    ipcRenderer.invoke('jh:preview-change-set', project, session, runId),
  restoreChangeSet: (project, session, runId) =>
    ipcRenderer.invoke('jh:restore-change-set', project, session, runId),
  changeSets: (project, session, runId) =>
    ipcRenderer.invoke('jh:change-sets', project, session, runId),
  createWorktree: (project, name = '') => ipcRenderer.invoke('jh:worktree-create', project, name),
  worktreeStatus: project => ipcRenderer.invoke('jh:worktree-status', project),
  reviewWorktree: project => ipcRenderer.invoke('jh:worktree-review', project),
  integrateWorktree: project => ipcRenderer.invoke('jh:worktree-integrate', project),
  removeWorktree: (project, force = false) => ipcRenderer.invoke('jh:worktree-remove', project, force),
  maintenanceStatus: () => ipcRenderer.invoke('jh:maintenance-status'),
  createBackup: () => ipcRenderer.invoke('jh:maintenance-create-backup'),
  inspectBackup: () => ipcRenderer.invoke('jh:maintenance-inspect-backup'),
  restoreBackup: directory => ipcRenderer.invoke('jh:maintenance-restore', directory),
  openDataDirectory: () => ipcRenderer.invoke('jh:maintenance-open-data'),
  automations: () => ipcRenderer.invoke('jh:automations'),
  createAutomation: input => ipcRenderer.invoke('jh:automation-create', input),
  updateAutomation: (id, patch = {}) => ipcRenderer.invoke('jh:automation-update', id, patch),
  removeAutomation: id => ipcRenderer.invoke('jh:automation-remove', id),
  runAutomation: id => ipcRenderer.invoke('jh:automation-run', id),
  retryAutomation: runId => ipcRenderer.invoke('jh:automation-retry', runId),
  cancelAutomationRun: runId => ipcRenderer.invoke('jh:automation-cancel', runId),
  report: (project, session) => ipcRenderer.invoke('jh:report', project, session),
  rerunCommand: (project, session, runId, commandId) =>
    ipcRenderer.invoke('jh:rerun-command', project, session, runId, commandId),
  verifyCriterion: (project, session, runId, criterionId, commandId, jsonSchema, expectedExitCode) =>
    ipcRenderer.invoke('jh:verify-criterion', project, session, runId, criterionId, commandId, jsonSchema, expectedExitCode),
  openCommandLog: (project, session, run, id) => ipcRenderer.invoke('jh:open-command-log', project, session, run, id),
  openArtifact: (project, session, id) => ipcRenderer.invoke('jh:open-artifact', project, session, id),
  exportSession: (project, session, format, title) =>
    ipcRenderer.invoke('jh:export-session', project, session, format, title),
  forkSession: (project, session, messageId) =>
    ipcRenderer.invoke('jh:fork-session', project, session, messageId),
  memory: (project, operation, input) => ipcRenderer.invoke('jh:memory', project, operation, input),
  copy: text => ipcRenderer.invoke('jh:copy', text),
  bookmarks: () => ipcRenderer.invoke('jh:bookmarks'),
  bookmark: value => ipcRenderer.invoke('jh:bookmark-add', value),
  removeBookmark: id => ipcRenderer.invoke('jh:bookmark-remove', id),
  searchSessions: query => ipcRenderer.invoke('jh:search-sessions', query),
  review: project => ipcRenderer.invoke('jh:git-review', project),
  testModel: input => ipcRenderer.invoke('jh:test-model', input),
  saveModel: input => ipcRenderer.invoke('jh:save-model', input),
  attach: (project, kind) => ipcRenderer.invoke('jh:attachment', project, kind),
  projectParts: project => ipcRenderer.invoke('jh:project-parts', project),
  externalPlugins: project => ipcRenderer.invoke('jh:external-plugins', project),
  installExternalPlugin: project => ipcRenderer.invoke('jh:install-external-plugin', project),
  setExternalPlugin: (id, enabled, project) => ipcRenderer.invoke('jh:set-external-plugin', id, enabled, project),
  upgradeExternalPlugin: (id, project) => ipcRenderer.invoke('jh:upgrade-external-plugin', id, project),
  uninstallExternalPlugin: (id, project) => ipcRenderer.invoke('jh:uninstall-external-plugin', id, project),
  chat: (project, session, text, run, options) => ipcRenderer.invoke('jh:chat', project, session, text, run, options),
  task: (project, session) => ipcRenderer.invoke('jh:task', project, session),
  tasks: () => ipcRenderer.invoke('jh:tasks'),
  steer: (run, message) => ipcRenderer.invoke('jh:steer', run, message),
  queueTask: (project, session, text, run, options) =>
    ipcRenderer.invoke('jh:queue-task', project, session, text, run, options),
  resumeTask: (project, session, turnId, run, answers, options) =>
    ipcRenderer.invoke('jh:resume-task', project, session, turnId, run, answers, options),
  reconcileTask: (project, session, turnId, run, answers, outcomes, options) =>
    ipcRenderer.invoke('jh:reconcile-task', project, session, turnId, run, answers, outcomes, options),
  cancelTask: (project, session, turnId) => ipcRenderer.invoke('jh:cancel-task', project, session, turnId),
  approve: (run, id, allow) => ipcRenderer.invoke('jh:approve', run, id, allow),
  listInterruptedApprovals: project => ipcRenderer.invoke('jh:list-interrupted-approvals', project),
  dismissInterruptedApproval: (project, id) => ipcRenderer.invoke('jh:dismiss-interrupted-approval', project, id),
  stop: run => ipcRenderer.invoke('jh:stop', run),
  onEvent: callback => {
    const listener = (_, message) => callback(message);
    ipcRenderer.on('jh:event', listener);
    return () => ipcRenderer.removeListener('jh:event', listener);
  }
});

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('jharness', {
  state: () => ipcRenderer.invoke('jh:state'),
  openProject: () => ipcRenderer.invoke('jh:project'),
  newSession: project => ipcRenderer.invoke('jh:session', project),
  history: (project, session) => ipcRenderer.invoke('jh:history', project, session),
  context: (project, session) => ipcRenderer.invoke('jh:context', project, session),
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

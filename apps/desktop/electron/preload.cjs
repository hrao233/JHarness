const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('jharness', {
  state: () => ipcRenderer.invoke('jh:state'),
  openProject: () => ipcRenderer.invoke('jh:project'),
  newSession: project => ipcRenderer.invoke('jh:session', project),
  history: (project, session) => ipcRenderer.invoke('jh:history', project, session),
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
  approve: (run, id, allow) => ipcRenderer.invoke('jh:approve', run, id, allow),
  stop: run => ipcRenderer.invoke('jh:stop', run),
  onEvent: callback => {
    const listener = (_, message) => callback(message);
    ipcRenderer.on('jh:event', listener);
    return () => ipcRenderer.removeListener('jh:event', listener);
  }
});

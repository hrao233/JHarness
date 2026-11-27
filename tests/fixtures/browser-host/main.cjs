// Exercise the production single-view bridge without loading a personal Electron profile.
const { app, BrowserWindow } = require('electron');
const { createBrowserPanes } = require('../../../apps/desktop/electron/browser-pane.cjs');
app.setPath('userData', process.argv.at(-1));
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false });
  const panes = createBrowserPanes(() => window, (_, url) => process.stdout.write(JSON.stringify({ url }) + '\n'));
  await panes.ensure('fixture');
  panes.event({ event: 'browser', data: { projectId: 'fixture', phase: 'start' } });
  const stop = require('node:path').join(process.argv.at(-1), 'stop-host');
  const timer = setInterval(() => {
    if (require('node:fs').existsSync(stop)) { clearInterval(timer); panes.close(); app.quit(); }
  }, 100);
}).catch(error => { console.error(error); app.exit(1); });

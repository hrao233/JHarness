const { copyFileSync, cpSync, existsSync, mkdirSync, rmSync, writeFileSync } = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');
const electron = path.dirname(require('electron'));
const backend = path.join(root, 'apps', 'backend', 'target', 'jharness-backend.jar');
const runtime = path.join(root, 'runtime');
const output = path.join(root, 'release', 'win-unpacked');
const desktop = path.join(root, 'apps', 'desktop', 'electron');
if (process.platform !== 'win32' || process.arch !== 'x64') {
  throw new Error('This packaging command requires Windows x64.');
}
for (const input of [backend, path.join(runtime, 'bin', 'java.exe'), path.join(root, 'dist', 'index.html')]) {
  if (!existsSync(input)) throw new Error('Build prerequisite missing: ' + input);
}
rmSync(output, { recursive: true, force: true });
cpSync(electron, output, { recursive: true, filter: file => path.basename(file) !== 'default_app.asar' });
const resources = path.join(output, 'resources');
const app = path.join(resources, 'app');
mkdirSync(path.join(app, 'desktop'), { recursive: true });
mkdirSync(path.join(app, 'cli'), { recursive: true });
for (const file of ['main.cjs', 'preload.cjs', 'context-parts.cjs',
  'worktree-manager.cjs', 'data-maintenance.cjs', 'automation-store.cjs']) {
  copyFileSync(path.join(desktop, file), path.join(app, 'desktop', file));
}
copyFileSync(path.join(root, 'apps', 'cli', 'jharness-cli.cjs'),
  path.join(app, 'cli', 'jharness-cli.cjs'));
const { name, productName, version } = require('../../package.json');
writeFileSync(path.join(app, 'package.json'), JSON.stringify({
  name, productName, version, main: 'desktop/main.cjs'
}));
cpSync(path.join(root, 'dist'), path.join(app, 'dist'), { recursive: true });
cpSync(runtime, path.join(resources, 'runtime'), { recursive: true });
copyFileSync(backend, path.join(resources, 'backend.jar'));
const executable = path.join(output, 'JHarness.exe');
require('node:fs').renameSync(path.join(output, 'electron.exe'), executable);
writeFileSync(path.join(output, 'jharness-cli.cmd'),
  '@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n'
    + '"%~dp0JHarness.exe" "%~dp0resources\\app\\cli\\jharness-cli.cjs" %*\r\n');
console.log(executable);

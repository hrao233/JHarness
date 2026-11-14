const { copyFileSync, cpSync, existsSync, mkdirSync, rmSync, writeFileSync } = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const electron = path.dirname(require('electron'));
const backend = path.join(root, 'backend', 'target', 'jharness-backend.jar');
const runtime = path.join(root, 'runtime');
const output = path.join(root, 'release', 'win-unpacked');
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
for (const file of ['main.cjs', 'preload.cjs', 'context-parts.cjs']) {
  copyFileSync(path.join(__dirname, file), path.join(app, 'desktop', file));
}
const { name, productName, version, main } = require('../package.json');
writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name, productName, version, main }));
cpSync(path.join(root, 'dist'), path.join(app, 'dist'), { recursive: true });
cpSync(runtime, path.join(resources, 'runtime'), { recursive: true });
copyFileSync(backend, path.join(resources, 'backend.jar'));
const executable = path.join(output, 'JHarness.exe');
require('node:fs').renameSync(path.join(output, 'electron.exe'), executable);
console.log(executable);

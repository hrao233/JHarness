const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');

const executable = path.resolve(__dirname, '..', '..', 'release', 'win-unpacked', 'JHarness.exe');

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

async function main() {
  const data = await mkdtemp(path.join(tmpdir(), 'jharness-gui-smoke-'));
  try {
    const result = await run(data);
    assert.equal(result.code, 0, result.stderr || result.stdout);
    const marker = result.stdout.split(/\r?\n/).find(line => line.startsWith('JHARNESS_SMOKE_OK '));
    assert.ok(marker, result.stdout + result.stderr);
    const smoke = JSON.parse(marker.slice('JHARNESS_SMOKE_OK '.length));
    assert.match(smoke.text, /JHarness/);
    assert.match(smoke.text, /打开一个项目/);
    assert.match(smoke.url, /resources\/app\/dist\/index\.html$/);
    console.log('PACKAGED_GUI_SMOKE_OK');
  } finally {
    await rm(data, { recursive: true, force: true, maxRetries: 5 });
  }
}

function run(data) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['--jharness-smoke', '--enable-logging'], {
      env: {
        ...process.env,
        ELECTRON_ENABLE_LOGGING: '1',
        JHARNESS_SMOKE_DATA: data
      },
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('packaged GUI smoke timed out\n' + stdout + stderr));
    }, 20000);
    child.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', code => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const { existsSync } = require('node:fs');
const { mkdtemp, rm, stat } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');
const jar = path.join(root, 'apps', 'backend', 'target', 'jharness-backend.jar');
const bundledJava = path.join(root, 'runtime', 'bin', 'java.exe');

test('backend jar and packaged directory stay within size budgets', async () => {
  assert.equal(existsSync(jar), true, 'build the Maven package before running budget checks');
  const jarBytes = (await stat(jar)).size;
  assert.ok(jarBytes <= 24 * 1024 * 1024, `backend jar is ${jarBytes} bytes`);

  const release = path.join(root, 'release', 'win-unpacked');
  if (existsSync(release)) {
    assert.equal(
      existsSync(path.join(release, 'resources', 'app', 'desktop', 'worktree-manager.cjs')),
      true,
      'packaged app must include the worktree manager module');
    assert.equal(
      existsSync(path.join(release, 'jharness-cli.cmd')),
      true,
      'packaged app must include the CLI launcher');
    assert.equal(
      existsSync(path.join(release, 'resources', 'app', 'desktop', 'data-maintenance.cjs')),
      true,
      'packaged app must include the data-maintenance module');
    assert.equal(
      existsSync(path.join(release, 'resources', 'app', 'desktop', 'automation-store.cjs')),
      true,
      'packaged app must include the automation store module');
    const releaseBytes = await directoryBytes(release);
    assert.ok(releaseBytes <= 450 * 1024 * 1024, `packaged directory is ${releaseBytes} bytes`);
  }
});

test('backend answers a protocol ping within the startup budget', { timeout: 15000 }, async () => {
  const data = await mkdtemp(path.join(tmpdir(), 'jharness-budget-'));
  const java = existsSync(bundledJava) ? bundledJava : 'java';
  const child = spawn(java, ['-jar', jar, data], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const pending = new Map();
  createInterface({ input: child.stdout }).on('line', line => {
    const message = JSON.parse(line);
    const resolve = pending.get(message.id);
    if (!resolve) return;
    pending.delete(message.id);
    resolve(message);
  });
  const started = Date.now();
  try {
    const response = await new Promise((resolve, reject) => {
      const id = 'budget-ping';
      const timer = setTimeout(() => reject(new Error(`startup ping timed out: ${stderr}`)), 10000);
      pending.set(id, message => { clearTimeout(timer); resolve(message); });
      child.stdin.write(JSON.stringify({ id, method: 'ping', params: {} }) + '\n');
    });
    assert.equal(response.result.version, '0.1.0');
    assert.ok(Date.now() - started < 8000, `backend did not answer within 8s: ${stderr}`);
  } finally {
    child.stdin.end();
    child.kill();
    await rm(data, { recursive: true, force: true, maxRetries: 5 });
  }
});

async function directoryBytes(directory) {
  const { readdir } = require('node:fs/promises');
  let total = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) total += await directoryBytes(target);
    else total += (await stat(target)).size;
  }
  return total;
}

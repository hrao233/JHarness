const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { mkdir, mkdtemp, readFile, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { createManager } = require('../electron/worktree-manager.cjs');

const execute = promisify(execFile);

async function git(cwd, args) {
  return (await execute('git', args, { cwd, windowsHide: true, encoding: 'utf8' })).stdout;
}

test('creates, inspects and safely removes isolated git worktrees', { timeout: 30000 }, async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'jharness-worktree-'));
  const repository = path.join(temporary, 'repository');
  const worktrees = path.join(temporary, 'worktrees');
  await mkdir(repository);
  try {
    await git(repository, ['init']);
    await git(repository, ['config', 'user.name', 'JHarness Test']);
    await git(repository, ['config', 'user.email', 'test@example.invalid']);
    await writeFile(path.join(repository, 'README.md'), 'BASE\n');
    await git(repository, ['add', 'README.md']);
    await git(repository, ['commit', '-m', 'base']);

    const manager = createManager(worktrees);
    const isolated = await manager.create({ projectRoot: repository, label: 'Feature Work' });
    assert.match(isolated.branch, /^jharness\/feature-work-[a-f0-9]{8}$/);
    assert.match(await readFile(path.join(isolated.path, 'README.md'), 'utf8'), /^BASE\r?\n$/);
    assert.equal((await manager.status(isolated)).dirty, false);
    assert.equal((await manager.list(repository)).some(item => item.path === isolated.path), true);

    await writeFile(path.join(isolated.path, 'dirty.txt'), 'DIRTY');
    const dirty = await manager.status(isolated);
    assert.equal(dirty.dirty, true);
    assert.equal(dirty.changedFiles, 1);
    await assert.rejects(manager.remove(isolated), /未提交/);
    await manager.remove(isolated, { force: true });
    assert.equal((await manager.status(isolated)).exists, false);

    const committed = await manager.create({ projectRoot: repository, label: 'Committed' });
    await writeFile(path.join(committed.path, 'change.txt'), 'CHANGE');
    await git(committed.path, ['add', 'change.txt']);
    await git(committed.path, ['commit', '-m', 'isolated change']);
    assert.equal((await manager.status(committed)).ahead, 1);
    await assert.rejects(manager.remove(committed), /尚未合并/);
    await manager.remove(committed, { force: true });

    await writeFile(path.join(repository, 'UNCOMMITTED.md'), 'SOURCE DIRTY');
    const fromDirty = await manager.create({ projectRoot: repository, label: 'Dirty Source' });
    assert.equal(fromDirty.sourceDirty, true);
    assert.equal(fromDirty.sourceChangedFiles, 1);
    await manager.remove(fromDirty, { force: true });
  } finally {
    await rm(temporary, { recursive: true, force: true, maxRetries: 5 });
  }
});

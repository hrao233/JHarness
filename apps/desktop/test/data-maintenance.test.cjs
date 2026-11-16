const { test } = require('node:test');
const assert = require('node:assert/strict');
const { existsSync } = require('node:fs');
const { mkdir, mkdtemp, readFile, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const maintenance = require('../electron/data-maintenance.cjs');

test('creates, verifies and restores a full desktop data backup', async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'jharness-maintenance-'));
  const data = path.join(temporary, 'data');
  const destination = path.join(temporary, 'backups');
  await mkdir(path.join(data, 'workspaces', 'project-a', 'session-a'), { recursive: true });
  await mkdir(path.join(data, 'worktrees'), { recursive: true });
  await mkdir(destination);
  const settings = {
    models: [],
    projects: [{ id: 'project-a', sessions: [{ id: 'session-a' }, { id: 'session-b' }] }]
  };
  await writeFile(path.join(data, 'settings.json'), JSON.stringify(settings));
  await writeFile(path.join(data, 'workspaces', 'project-a', 'session-a', 'history.jsonl'),
    '{"event":"original"}\n');
  await writeFile(path.join(data, 'worktrees', 'ignored.txt'), 'not backed up');
  await writeFile(path.join(data, 'session-search.sqlite'), 'derived');
  try {
    const status = await maintenance.status(data);
    assert.equal(status.projects, 1);
    assert.equal(status.sessions, 2);
    assert.ok(status.files >= 2);

    const backup = await maintenance.createBackup(data, destination);
    assert.equal(backup.entries.includes('settings.json'), true);
    assert.equal(backup.entries.includes('worktrees'), false);
    assert.equal(existsSync(path.join(backup.path, 'worktrees', 'ignored.txt')), false);
    const inspected = await maintenance.inspectBackup(backup.path);
    assert.equal(inspected.projects, undefined);
    assert.equal(inspected.entries.includes('workspaces'), true);
    assert.ok(inspected.files >= 2);

    await writeFile(path.join(data, 'settings.json'), JSON.stringify({ projects: [] }));
    await writeFile(path.join(data, 'workspaces', 'project-a', 'session-a', 'history.jsonl'),
      '{"event":"mutated"}\n');
    const restored = await maintenance.restoreBackup(data, backup.path);
    assert.equal(restored.restored, true);
    assert.equal(existsSync(restored.safetyBackup), true);
    assert.deepEqual(JSON.parse(await readFile(path.join(data, 'settings.json'), 'utf8')), settings);
    assert.equal(await readFile(
      path.join(data, 'workspaces', 'project-a', 'session-a', 'history.jsonl'), 'utf8'),
    '{"event":"original"}\n');
    assert.equal(existsSync(path.join(data, 'session-search.sqlite')), false);

    await writeFile(path.join(backup.path, 'settings.json'), '{"tampered":true}');
    await assert.rejects(maintenance.inspectBackup(backup.path), /校验失败/);
    await assert.rejects(maintenance.createBackup(data, data), /不能位于/);
  } finally {
    await rm(temporary, { recursive: true, force: true, maxRetries: 5 });
  }
});

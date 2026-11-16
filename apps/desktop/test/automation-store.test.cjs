const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { createStore } = require('../electron/automation-store.cjs');

test('persists automation definitions, deduplicates schedules and tracks runs', async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'jharness-automation-'));
  const file = path.join(temporary, 'automations.json');
  try {
    const store = createStore(file);
    const interval = await store.create({
      name: 'Periodic build',
      prompt: 'Run the build and summarize failures.',
      projectId: 'project-1',
      sessionId: 'session-1',
      scheduleType: 'interval',
      intervalMinutes: 30
    });
    assert.equal(interval.enabled, true);
    assert.equal(interval.scheduleType, 'interval');

    const firstDue = await store.claimDue(interval.nextRunAt + 1);
    assert.equal(firstDue.length, 1);
    assert.equal(firstDue[0].trigger, 'schedule');
    const active = await store.markRunning(firstDue[0].runId);
    assert.equal(active.status, 'running');

    const deduped = await store.claimDue(interval.nextRunAt + 31 * 60_000);
    assert.equal(deduped.length, 0);
    const after = await store.list();
    assert.equal(after.runs.length, 1);
    assert.ok(after.definitions[0].nextRunAt > interval.nextRunAt);

    const completed = await store.finish(firstDue[0].runId, 'completed');
    assert.equal(completed.status, 'completed');
    const manual = await store.runNow(interval.id);
    assert.equal(manual.trigger, 'manual');
    assert.equal((await store.list()).runs.length, 2);

    await store.update(interval.id, { enabled: false });
    assert.equal((await store.list()).definitions[0].enabled, false);
    await store.update(interval.id, { enabled: true });
    assert.equal((await store.list()).definitions[0].enabled, true);

    const onceAt = Date.now() + 5000;
    const once = await store.create({
      name: 'One shot',
      prompt: 'Inspect the repository.',
      projectId: 'project-1',
      sessionId: 'session-2',
      scheduleType: 'once',
      runAt: onceAt
    });
    const onceRuns = await store.claimDue(onceAt);
    assert.equal(onceRuns.length, 1);
    assert.equal((await store.list()).definitions
      .find(item => item.id === once.id).enabled, false);

    const failed = await store.finish(manual.runId, 'failed', 'provider failed');
    assert.equal(failed.status, 'failed');
    const retry = await store.retry(manual.runId);
    assert.equal(retry.trigger, 'retry');
    await assert.rejects(store.remove(once.id), /活动运行/);
    assert.ok(await store.recoverRunning() >= 1);
    assert.equal((await store.list()).runs.some(run =>
      ['queued', 'running'].includes(run.status)), false);
    await assert.rejects(store.remove('missing'), /找不到/);
  } finally {
    await rm(temporary, { recursive: true, force: true, maxRetries: 5 });
  }
});

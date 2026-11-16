const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const MAX_PROMPT = 16000;
const ACTIVE = new Set(['queued', 'running', 'suspended']);

function validatePrompt(value) {
  const prompt = String(value || '').trim();
  if (!prompt) throw new Error('自动任务内容不能为空。');
  if (prompt.length > MAX_PROMPT) throw new Error('自动任务内容不能超过 16,000 字符。');
  return prompt;
}

function validateName(value) {
  const name = String(value || '').trim();
  if (!name) throw new Error('自动任务名称不能为空。');
  if (name.length > 80) throw new Error('自动任务名称不能超过 80 字符。');
  return name;
}

function createStore(file) {
  let writing = Promise.resolve();
  let state = null;

  async function load() {
    if (state) return state;
    try {
      state = JSON.parse(await fs.readFile(file, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error('无法读取自动任务数据：' + error.message);
      state = { version: 1, definitions: [], runs: [] };
    }
    if (state.version !== 1 || !Array.isArray(state.definitions) || !Array.isArray(state.runs)) {
      throw new Error('自动任务数据格式无效。');
    }
    return state;
  }

  function save() {
    writing = writing.then(async () => {
      await fs.mkdir(path.dirname(file), { recursive: true });
      const temporary = file + '.' + process.pid + '.tmp';
      await fs.writeFile(temporary, JSON.stringify(state, null, 2) + '\n', 'utf8');
      await fs.rename(temporary, file);
    });
    return writing;
  }

  async function create(input) {
    const store = await load();
    const now = Date.now();
    const type = input.scheduleType === 'once' ? 'once' : 'interval';
    const intervalMinutes = Math.max(1, Math.min(Number(input.intervalMinutes) || 60, 10080));
    const runAt = type === 'once' ? Number(input.runAt) : 0;
    if (type === 'once' && (!Number.isFinite(runAt) || runAt <= now)) {
      throw new Error('一次性任务的执行时间必须晚于当前时间。');
    }
    const definition = {
      id: randomUUID(),
      name: validateName(input.name),
      prompt: validatePrompt(input.prompt),
      projectId: String(input.projectId || ''),
      sessionId: String(input.sessionId || ''),
      scheduleType: type,
      intervalMinutes: type === 'interval' ? intervalMinutes : 0,
      runAt: type === 'once' ? runAt : 0,
      nextRunAt: type === 'once' ? runAt : now + intervalMinutes * 60_000,
      enabled: true,
      createdAt: now,
      updatedAt: now
    };
    if (!definition.projectId || !definition.sessionId) throw new Error('自动任务缺少项目或会话。');
    store.definitions.unshift(definition);
    await save();
    return structuredClone(definition);
  }

  async function update(id, patch) {
    const store = await load();
    const definition = store.definitions.find(item => item.id === id);
    if (!definition) throw new Error('找不到自动任务。');
    if (typeof patch.enabled === 'boolean') {
      definition.enabled = patch.enabled;
      definition.updatedAt = Date.now();
      if (patch.enabled) {
        definition.nextRunAt = definition.scheduleType === 'once'
          ? Math.max(Date.now() + 1000, definition.runAt)
          : Date.now() + definition.intervalMinutes * 60_000;
      }
    }
    await save();
    return structuredClone(definition);
  }

  async function remove(id) {
    const store = await load();
    const index = store.definitions.findIndex(item => item.id === id);
    if (index < 0) throw new Error('找不到自动任务。');
    if (store.runs.some(run => run.automationId === id && ACTIVE.has(run.status))) {
      throw new Error('自动任务仍有活动运行，请先等待或取消。');
    }
    store.definitions.splice(index, 1);
    await save();
    return true;
  }

  function activeRun(store, id) {
    return store.runs.find(run => run.automationId === id && ACTIVE.has(run.status));
  }

  async function queueRun(definition, trigger, scheduledFor = Date.now()) {
    const store = await load();
    const current = store.definitions.find(item => item.id === definition.id);
    if (!current) throw new Error('找不到自动任务。');
    if (trigger !== 'manual' && activeRun(store, current.id)) {
      return null;
    }
    const now = Date.now();
    const run = {
      id: randomUUID(),
      automationId: current.id,
      automationName: current.name,
      projectId: current.projectId,
      sessionId: current.sessionId,
      prompt: current.prompt,
      trigger,
      scheduledFor,
      status: 'queued',
      runId: randomUUID(),
      startedAt: 0,
      finishedAt: 0,
      error: ''
    };
    store.runs.unshift(run);
    store.runs = store.runs.slice(0, 2000);
    await save();
    return structuredClone(run);
  }

  async function claimDue(now = Date.now()) {
    const store = await load();
    const due = [];
    for (const definition of store.definitions) {
      if (!definition.enabled || !definition.nextRunAt || definition.nextRunAt > now) continue;
      if (activeRun(store, definition.id)) {
        definition.nextRunAt = now + Math.min(
          definition.intervalMinutes * 60_000 || 60_000, 5 * 60_000);
        definition.updatedAt = now;
        continue;
      }
      const scheduledFor = definition.nextRunAt;
      if (definition.scheduleType === 'once') {
        definition.enabled = false;
        definition.nextRunAt = 0;
      } else {
        definition.nextRunAt = now + definition.intervalMinutes * 60_000;
      }
      definition.updatedAt = now;
      const run = await queueRun(definition, 'schedule', scheduledFor);
      if (run) due.push(run);
    }
    await save();
    return due;
  }

  async function markRunning(runId) {
    const store = await load();
    const run = store.runs.find(item => item.runId === runId);
    if (!run) return null;
    run.status = 'running';
    run.startedAt = Date.now();
    await save();
    return structuredClone(run);
  }

  async function finish(runId, status, error = '') {
    const store = await load();
    const run = store.runs.find(item => item.runId === runId);
    if (!run) return null;
    const normalized = ['completed', 'suspended', 'failed', 'cancelled', 'interrupted']
      .includes(status) ? status : status === 'running' ? 'running' : 'failed';
    run.status = normalized;
    run.finishedAt = normalized === 'running' ? 0 : Date.now();
    run.error = String(error || '').slice(0, 4000);
    await save();
    return structuredClone(run);
  }

  async function recoverRunning(error = '应用在运行完成前退出。') {
    const store = await load();
    let changed = 0;
    for (const run of store.runs) {
      if (run.status === 'queued' || run.status === 'running') {
        run.status = 'interrupted';
        run.finishedAt = Date.now();
        run.error = error;
        changed++;
      }
    }
    if (changed) await save();
    return changed;
  }

  async function list() {
    const store = await load();
    return {
      definitions: structuredClone(store.definitions),
      runs: structuredClone(store.runs.slice(0, 200))
    };
  }

  async function runNow(id) {
    const store = await load();
    const definition = store.definitions.find(item => item.id === id);
    if (!definition) throw new Error('找不到自动任务。');
    const run = await queueRun(definition, 'manual');
    if (!run) throw new Error('无法创建自动任务运行。');
    return run;
  }

  async function retry(runId) {
    const store = await load();
    const previous = store.runs.find(item => item.runId === runId || item.id === runId);
    if (!previous) throw new Error('找不到自动任务运行。');
    const definition = store.definitions.find(item => item.id === previous.automationId);
    if (!definition) throw new Error('自动任务定义已删除。');
    const run = await queueRun(definition, 'retry');
    if (!run) throw new Error('无法创建自动任务重试。');
    return run;
  }

  return {
    create, update, remove, claimDue, markRunning, finish, recoverRunning,
    list, runNow, retry
  };
}

module.exports = { createStore };

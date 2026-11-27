const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const MAX_PROMPT = 16000;
const ACTIVE = new Set(['queued', 'running', 'suspended']);
const TIME_OF_DAY = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

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

function normalizeDaysOfWeek(raw) {
  if (!Array.isArray(raw) || !raw.length) return [];
  const days = [];
  for (const item of raw) {
    const day = Number(item);
    if (!Number.isInteger(day) || day < 1 || day > 7) {
      throw new Error('星期范围必须为 1（周一）至 7（周日）。');
    }
    if (!days.includes(day)) days.push(day);
  }
  days.sort((a, b) => a - b);
  return days.length === 7 ? [] : days;
}

function nextDailyRun(fromMs, timeOfDay, daysOfWeek = []) {
  const text = String(timeOfDay || '').trim();
  if (!TIME_OF_DAY.test(text)) {
    throw new Error('每日执行时间格式必须为 HH:mm（例如 09:00）。');
  }
  const [hours, minutes] = text.split(':').map(Number);
  const allowed = normalizeDaysOfWeek(daysOfWeek);
  const base = new Date(fromMs);
  for (let offset = 0; offset <= 7; offset++) {
    const candidate = new Date(
      base.getFullYear(),
      base.getMonth(),
      base.getDate() + offset,
      hours,
      minutes,
      0,
      0
    );
    const isoDay = candidate.getDay() === 0 ? 7 : candidate.getDay();
    if (allowed.length && !allowed.includes(isoDay)) continue;
    const timestamp = candidate.getTime();
    if (timestamp > fromMs) return timestamp;
  }
  throw new Error('无法计算下一次每日定时执行时间。');
}

function createStore(file) {
  let queue = Promise.resolve();
  const directory = path.dirname(path.resolve(file));
  const lockFile = path.join(directory, 'settings-lock.sqlite');

  function readState() {
    let state;
    try {
      state = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error('无法读取自动任务数据：' + error.message);
      state = { version: 1, definitions: [], runs: [] };
    }
    if (state.version !== 1 || !Array.isArray(state.definitions) || !Array.isArray(state.runs)) {
      throw new Error('自动任务数据格式无效。');
    }
    return state;
  }

  function writeState(state) {
    fs.mkdirSync(directory, { recursive: true });
    const temporary = file + '.' + randomUUID() + '.tmp';
    try {
      fs.writeFileSync(temporary, JSON.stringify(state, null, 2) + '\n', 'utf8');
      fs.renameSync(temporary, file);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }

  function locked(action) {
    const run = () => {
      const { DatabaseSync } = require('node:sqlite');
      fs.mkdirSync(directory, { recursive: true });
      const lock = new DatabaseSync(lockFile);
      try {
        lock.exec('PRAGMA busy_timeout=5000');
        lock.exec('BEGIN IMMEDIATE');
        const state = readState();
        const result = action(state, writeState);
        lock.exec('COMMIT');
        return result;
      } finally {
        lock.close();
      }
    };
    const next = queue.then(run, run);
    queue = next.then(() => undefined, () => undefined);
    return next;
  }

  function computeSchedule(now, input) {
    const type = input.scheduleType === 'once'
      ? 'once'
      : input.scheduleType === 'daily' ? 'daily' : 'interval';
    if (type === 'once') {
      const runAt = Number(input.runAt);
      if (!Number.isFinite(runAt) || runAt <= now) {
        throw new Error('一次性任务的执行时间必须晚于当前时间。');
      }
      return {
        scheduleType: 'once',
        intervalMinutes: 0,
        timeOfDay: '',
        daysOfWeek: [],
        runAt,
        nextRunAt: runAt
      };
    }
    if (type === 'daily') {
      const timeOfDay = String(input.timeOfDay || '').trim();
      const daysOfWeek = normalizeDaysOfWeek(input.daysOfWeek);
      const nextRunAt = nextDailyRun(now, timeOfDay, daysOfWeek);
      return {
        scheduleType: 'daily',
        intervalMinutes: 0,
        timeOfDay,
        daysOfWeek,
        runAt: 0,
        nextRunAt
      };
    }
    const intervalMinutes = Math.max(1, Math.min(Number(input.intervalMinutes) || 60, 10080));
    const delayMinutes = input.delayMinutes != null
      ? Math.max(1, Math.min(Number(input.delayMinutes) || intervalMinutes, 10080))
      : intervalMinutes;
    return {
      scheduleType: 'interval',
      intervalMinutes,
      timeOfDay: '',
      daysOfWeek: [],
      runAt: 0,
      nextRunAt: now + delayMinutes * 60_000
    };
  }

  function nextScheduledAfter(now, definition) {
    if (definition.scheduleType === 'once') {
      return Math.max(now + 1000, Number(definition.runAt) || 0);
    }
    if (definition.scheduleType === 'daily') {
      return nextDailyRun(now, definition.timeOfDay, definition.daysOfWeek || []);
    }
    const interval = Math.max(1, Math.min(Number(definition.intervalMinutes) || 60, 10080));
    return now + interval * 60_000;
  }

  async function create(input) {
    return locked((store, save) => {
      const now = Date.now();
      const schedule = computeSchedule(now, input);
      const definition = {
        id: randomUUID(),
        name: validateName(input.name),
        prompt: validatePrompt(input.prompt),
        projectId: String(input.projectId || ''),
        sessionId: String(input.sessionId || ''),
        ...schedule,
        enabled: true,
        createdAt: now,
        updatedAt: now
      };
      if (!definition.projectId || !definition.sessionId) throw new Error('自动任务缺少项目或会话。');
      store.definitions.unshift(definition);
      save(store);
      return structuredClone(definition);
    });
  }

  async function update(id, patch) {
    return locked((store, save) => {
      const definition = store.definitions.find(item => item.id === id);
      if (!definition) throw new Error('找不到自动任务。');
      const now = Date.now();
      if (patch.name !== undefined) definition.name = validateName(patch.name);
      if (patch.prompt !== undefined) definition.prompt = validatePrompt(patch.prompt);
      if (patch.scheduleType !== undefined || patch.intervalMinutes !== undefined
          || patch.timeOfDay !== undefined || patch.daysOfWeek !== undefined || patch.runAt !== undefined) {
        const schedule = computeSchedule(now, {
          scheduleType: patch.scheduleType ?? definition.scheduleType,
          intervalMinutes: patch.intervalMinutes ?? definition.intervalMinutes,
          timeOfDay: patch.timeOfDay ?? definition.timeOfDay,
          daysOfWeek: patch.daysOfWeek ?? definition.daysOfWeek,
          runAt: patch.runAt ?? definition.runAt
        });
        Object.assign(definition, schedule);
      }
      if (typeof patch.enabled === 'boolean') {
        definition.enabled = patch.enabled;
        if (patch.enabled) {
          definition.nextRunAt = nextScheduledAfter(now, definition);
        }
      }
      definition.updatedAt = now;
      save(store);
      return structuredClone(definition);
    });
  }

  async function remove(id) {
    return locked((store, save) => {
      const index = store.definitions.findIndex(item => item.id === id);
      if (index < 0) throw new Error('找不到自动任务。');
      if (store.runs.some(run => run.automationId === id && ACTIVE.has(run.status))) {
        throw new Error('自动任务仍有活动运行，请先等待或取消。');
      }
      store.definitions.splice(index, 1);
      save(store);
      return true;
    });
  }

  function activeRun(store, id) {
    return store.runs.find(run => run.automationId === id && ACTIVE.has(run.status));
  }

  function appendRun(store, definition, trigger, scheduledFor) {
    if (trigger !== 'manual' && activeRun(store, definition.id)) {
      return null;
    }
    const run = {
      id: randomUUID(),
      automationId: definition.id,
      automationName: definition.name,
      projectId: definition.projectId,
      sessionId: definition.sessionId,
      prompt: definition.prompt,
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
    return structuredClone(run);
  }

  async function claimDue(now = Date.now()) {
    return locked((store, save) => {
      const due = [];
      let changed = false;
      for (const definition of store.definitions) {
        if (!definition.enabled || !definition.nextRunAt || definition.nextRunAt > now) continue;
        if (activeRun(store, definition.id)) {
          definition.nextRunAt = now + Math.min(
            (Number(definition.intervalMinutes) || 60) * 60_000, 5 * 60_000);
          definition.updatedAt = now;
          changed = true;
          continue;
        }
        const scheduledFor = definition.nextRunAt;
        if (definition.scheduleType === 'once') {
          definition.enabled = false;
          definition.nextRunAt = 0;
        } else {
          definition.nextRunAt = nextScheduledAfter(now, definition);
        }
        definition.updatedAt = now;
        changed = true;
        const run = appendRun(store, definition, 'schedule', scheduledFor);
        if (run) due.push(run);
      }
      if (changed || due.length) save(store);
      return due;
    });
  }

  async function markRunning(runId) {
    return locked((store, save) => {
      const run = store.runs.find(item => item.runId === runId);
      if (!run) return null;
      run.status = 'running';
      run.startedAt = Date.now();
      save(store);
      return structuredClone(run);
    });
  }

  async function finish(runId, status, error = '') {
    return locked((store, save) => {
      const run = store.runs.find(item => item.runId === runId);
      if (!run) return null;
      const normalized = ['completed', 'suspended', 'failed', 'cancelled', 'interrupted']
        .includes(status) ? status : status === 'running' ? 'running' : 'failed';
      run.status = normalized;
      run.finishedAt = normalized === 'running' ? 0 : Date.now();
      run.error = String(error || '').slice(0, 4000);
      save(store);
      return structuredClone(run);
    });
  }

  async function recoverRunning(error = '应用在运行完成前退出。') {
    return locked((store, save) => {
      let changed = 0;
      for (const run of store.runs) {
        if (run.status === 'queued' || run.status === 'running') {
          run.status = 'interrupted';
          run.finishedAt = Date.now();
          run.error = error;
          changed++;
        }
      }
      if (changed) save(store);
      return changed;
    });
  }

  async function list() {
    return locked(store => ({
      definitions: structuredClone(store.definitions),
      runs: structuredClone(store.runs.slice(0, 200))
    }));
  }

  async function runNow(id) {
    return locked((store, save) => {
      const definition = store.definitions.find(item => item.id === id);
      if (!definition) throw new Error('找不到自动任务。');
      const run = appendRun(store, definition, 'manual', Date.now());
      if (!run) throw new Error('无法创建自动任务运行。');
      save(store);
      return run;
    });
  }

  async function retry(runId) {
    return locked((store, save) => {
      const previous = store.runs.find(item => item.runId === runId || item.id === runId);
      if (!previous) throw new Error('找不到自动任务运行。');
      const definition = store.definitions.find(item => item.id === previous.automationId);
      if (!definition) throw new Error('自动任务定义已删除。');
      const run = appendRun(store, definition, 'retry', Date.now());
      if (!run) throw new Error('无法创建自动任务重试。');
      save(store);
      return run;
    });
  }

  return {
    create, update, remove, claimDue, markRunning, finish, recoverRunning,
    list, runNow, retry
  };
}

module.exports = { createStore, nextDailyRun };

#!/usr/bin/env node
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { existsSync } = require('node:fs');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const readlinePromises = require('node:readline/promises');

const { readSettings, updateSettings, findProject, legacyProject, addProject } = require('../shared/settings-store.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const VERSION = '0.1.0';
const ID = /^[a-f0-9-]{36}$/;

function usage() {
  console.log(`JHarness CLI ${VERSION}

Usage:
  jharness run [message...] [options]
  jharness doctor [options]

Options:
  --project <path>       Project root (default: current directory)
  --session <uuid>       Reuse an explicit session
  --new-session          Create a new session for this project
  --permission <mode>    ask | assist | full | durable (default: ask)
  --json                 Emit backend events as JSON lines
  --effort <level>       Reasoning effort (default: JHARNESS_EFFORT or high)
  --fast                 Request the provider fast tier
  --help                 Show this help

Model environment:
  JHARNESS_API_KEY, JHARNESS_MODEL, JHARNESS_BASE_URL
  JHARNESS_PROVIDER=compatible|deepseek

Runtime environment:
  JHARNESS_DATA_DIR       Desktop-compatible userData directory
  JHARNESS_BACKEND_JAR    Override backend JAR
  JHARNESS_JAVA           Override Java executable`);
}

function defaultDataDirectory() {
  if (process.env.JHARNESS_DATA_DIR) return path.resolve(process.env.JHARNESS_DATA_DIR);
  if (process.platform === 'win32' && process.env.APPDATA) {
    return path.join(process.env.APPDATA, 'JHarness');
  }
  return path.join(os.homedir(), '.config', 'JHarness');
}

function parse(argv) {
  const command = argv[0] && !argv[0].startsWith('-') ? argv.shift() : 'run';
  const options = {
    command,
    project: process.cwd(),
    session: '',
    newSession: false,
    permission: 'ask',
    json: false,
    effort: process.env.JHARNESS_EFFORT || 'high',
    fast: false,
    message: []
  };
  const value = (index, name) => {
    if (index + 1 >= argv.length) throw new Error(name + ' 需要参数。');
    return argv[index + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--project') { options.project = value(i, arg); i++; }
    else if (arg === '--session') { options.session = value(i, arg); i++; }
    else if (arg === '--new-session') options.newSession = true;
    else if (arg === '--permission') { options.permission = value(i, arg); i++; }
    else if (arg === '--json') options.json = true;
    else if (arg === '--effort') { options.effort = value(i, arg); i++; }
    else if (arg === '--fast') options.fast = true;
    else if (arg.startsWith('--')) throw new Error('未知参数：' + arg);
    else options.message.push(arg);
  }
  if (!['run', 'doctor'].includes(options.command)) {
    throw new Error('未知命令：' + options.command);
  }
  if (!['ask', 'assist', 'full', 'durable'].includes(options.permission)) {
    throw new Error('审批模式必须是 ask、assist、full 或 durable。');
  }
  if (options.session && !ID.test(options.session)) throw new Error('会话 ID 无效。');
  return options;
}

async function identity(options, dataDirectory, readOnly = false) {
  const project = await fs.realpath(path.resolve(options.project));
  if (!(await fs.stat(project)).isDirectory()) throw new Error('项目路径不是目录。');
  function select(settings) {
    let entry = findProject(settings, project);
    const source = entry ? 'desktop' : 'cli';
    const legacy = !entry || options.session ? legacyProject(dataDirectory, project) : null;
    if (!entry && readOnly) {
      return { project, projectId: legacy?.projectId || null,
        sessionId: legacy && options.session ? options.session : (options.newSession ? null : legacy?.sessionId) || null, source };
    }
    if (!entry) {
      entry = addProject(settings, project, legacy);
      entry.cliCreated = true;
    }
    const sessions = entry.sessions || [];
    const selected = options.session ? sessions.find(item => item.id === options.session)
      : options.newSession ? null : sessions.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
    if (options.session && !selected && !entry.cliCreated && legacy?.projectId !== entry.id) {
      throw new Error('桌面项目中没有这个会话。');
    }
    let sessionId = selected?.id || null;
    if (!sessionId && !readOnly) {
      sessionId = options.session || randomUUID();
      entry.sessions = sessions;
      sessions.unshift({ id: sessionId, title: 'CLI 会话', permission: options.permission, updatedAt: Date.now() });
    }
    return { project, projectId: entry.id, sessionId, source };
  }
  return readOnly ? select(readSettings(dataDirectory)) : updateSettings(dataDirectory, select);
}

function runtime(options, dataDirectory) {
  const bundledJava = path.join(ROOT, 'runtime', 'bin', 'java.exe');
  const packagedJar = path.join(ROOT, 'backend.jar');
  const jar = process.env.JHARNESS_BACKEND_JAR
    ? path.resolve(process.env.JHARNESS_BACKEND_JAR)
    : existsSync(packagedJar)
      ? packagedJar
      : path.join(ROOT, 'apps', 'backend', 'target', 'jharness-backend.jar');
  const java = process.env.JHARNESS_JAVA
    ? path.resolve(process.env.JHARNESS_JAVA)
    : existsSync(bundledJava) ? bundledJava : 'java';
  if (!existsSync(jar)) throw new Error('找不到后端 JAR：' + jar);
  const workspace = path.join(dataDirectory, 'workspaces');
  return { java, jar, workspace };
}

function modelOptions(options) {
  const provider = process.env.JHARNESS_PROVIDER === 'deepseek' ? 'deepseek' : 'compatible';
  const key = process.env.JHARNESS_API_KEY;
  const model = process.env.JHARNESS_MODEL;
  const baseUrl = process.env.JHARNESS_BASE_URL
    || (provider === 'deepseek' ? 'https://api.deepseek.com' : 'https://api.openai.com/v1');
  if (!key) throw new Error('请设置 JHARNESS_API_KEY。');
  if (!model) throw new Error('请设置 JHARNESS_MODEL。');
  return {
    provider,
    key,
    model,
    baseUrl,
    effort: options.effort,
    serviceTier: options.fast && provider === 'compatible' ? 'fast' : ''
  };
}

class Backend {
  constructor(runtimeConfig) {
    this.child = spawn(runtimeConfig.java,
      ['-Dfile.encoding=UTF-8', '-jar', runtimeConfig.jar, runtimeConfig.workspace],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.child.stdin.on('error', error => this.fail(error.message));
    this.stopped = new Promise(resolve => this.child.once('close', resolve));
    this.pending = new Map();
    this.events = [];
    this.listeners = new Set();
    this.stderr = '';
    this.child.stderr.on('data', chunk => {
      this.stderr = (this.stderr + chunk.toString('utf8')).slice(-16000);
    });
    readline.createInterface({ input: this.child.stdout }).on('line', line => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.event) {
        this.events.push(message);
        for (const listener of this.listeners) listener(message);
        return;
      }
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) request.reject(new Error(message.error));
      else request.resolve(message.result);
    });
    this.child.once('error', error => this.fail(error.message));
    this.child.once('exit', code => {
      if (this.closed) return;
      this.fail('后端已退出' + (code == null ? '' : '（' + code + '）')
        + (this.stderr ? '：' + this.stderr : ''));
    });
  }

  call(method, params = {}) {
    if (!this.child.stdin.writable) return Promise.reject(new Error('后端未运行。'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('后端请求超时。'));
      }, 35000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }

  listen(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  fail(message) {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error(message));
    }
    this.pending.clear();
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill(), 1800);
    try { await this.stopped; } finally { clearTimeout(timer); }
  }
}

async function run(options, dataDirectory) {
  const message = options.message.join(' ').trim();
  if (!message) throw new Error('请提供任务内容。');
  const model = modelOptions(options);
  const selected = await identity(options, dataDirectory);
  const backend = new Backend(runtime(options, dataDirectory));
  const runId = randomUUID();
  let text = '';
  let resultText = '';
  let finished;
  let finishError;
  const completed = new Promise((resolve, reject) => {
    finished = resolve;
    finishError = reject;
  });
  const prompts = options.json ? null : readlinePromises.createInterface({
    input: process.stdin,
    output: process.stderr
  });

  backend.listen(messageEvent => {
    const { event, data } = messageEvent;
    if (options.json) {
      process.stdout.write(JSON.stringify(messageEvent) + '\n');
    } else if (event === 'text') {
      text += data.delta || '';
      process.stdout.write(data.delta || '');
    } else if (event === 'result') {
      resultText = data.text || '';
    } else if (event === 'tool-start') {
      process.stderr.write('[tool] ' + data.name + '\n');
    } else if (event === 'tool-end') {
      process.stderr.write('[tool] ' + data.status + '\n');
    } else if (event === 'error') {
      process.stderr.write(errorLine(data.message) + '\n');
    }
    if (event === 'error') finishError(new Error(data.message || '任务失败。'));
    if (event === 'done') finished({ status: data.status || 'done', selected, runId });
    if (event === 'approval') {
      if (prompts) {
        void prompts.question(
          '批准 ' + data.operation + (data.path ? ' ' + data.path : '') + '？[y/N] ')
          .then(answer => backend.call('approve', {
            runId, approvalId: data.id, allow: /^y(es)?$/i.test(answer.trim())
          }))
          .catch(() => backend.call('approve', {
            runId, approvalId: data.id, allow: false
          }).catch(() => {}));
      } else {
        backend.call('approve', {
          runId, approvalId: data.id, allow: false
        }).catch(() => {});
      }
    }
  });

  try {
    const autoMemory = process.env.JHARNESS_AUTO_MEMORY === '1';
    await backend.call('chat', {
      projectId: selected.projectId,
      sessionId: selected.sessionId,
      projectPath: selected.project,
      ...model,
      runId,
      permission: options.permission,
      message,
      autoMemory
    });
    const outcome = await completed;
    if (!options.json && !text && resultText) process.stdout.write(resultText);
    if (!options.json && text && !text.endsWith('\n')) process.stdout.write('\n');
    if (outcome.status === 'suspended') {
      const task = await backend.call('task', {
        projectId: selected.projectId,
        sessionId: selected.sessionId
      });
      if (!options.json) {
        process.stderr.write('任务等待审批。使用桌面应用继续，或在 TTY 中重新运行并批准。\n');
        for (const approval of task.approvals || []) {
          process.stderr.write('- ' + approval.operation + ' ' + (approval.path || '') + '\n');
        }
      }
      return 3;
    }
    return 0;
  } finally {
    prompts?.close();
    await backend.close();
  }
}

function errorLine(message) {
  return '[error] ' + String(message || '任务失败。');
}

async function doctor(options, dataDirectory) {
  const selected = await identity(options, dataDirectory, true);
  const runtimeOptions = runtime(options, dataDirectory);
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'jharness-doctor-'));
  let backend;
  let ping;
  try {
    backend = new Backend({ ...runtimeOptions, workspace });
    ping = await backend.call('ping');
    if (!ping?.version) throw new Error('后端 ping 回复缺少版本。');
  } finally {
    await backend?.close();
    await fs.rm(workspace, { recursive: true, force: true, maxRetries: 5 });
  }
  console.log(JSON.stringify({
    backendVersion: ping.version,
    version: VERSION,
    project: selected.project,
    projectId: selected.projectId,
    sessionId: selected.sessionId,
    identitySource: selected.source,
    dataDirectory,
    backendJar: runtimeOptions.jar,
    java: runtimeOptions.java,
    modelConfigured: Boolean(process.env.JHARNESS_API_KEY && process.env.JHARNESS_MODEL)
  }, null, 2));
  return 0;
}

async function main() {
  const options = parse(process.argv.slice(2));
  if (options.help) {
    usage();
    return 0;
  }
  const dataDirectory = defaultDataDirectory();
  return options.command === 'doctor'
    ? doctor(options, dataDirectory)
    : run(options, dataDirectory);
}

main().then(code => {
  process.exitCode = code;
}).catch(error => {
  console.error(errorLine(error.message || error));
  process.exitCode = 1;
});

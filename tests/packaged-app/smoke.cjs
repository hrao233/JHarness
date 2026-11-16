const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { once } = require('node:events');
const { createServer } = require('node:http');
const { mkdir, mkdtemp, readFile, rm, stat, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { createInterface } = require('node:readline');

const executable = path.resolve(__dirname, '..', '..', 'release', 'win-unpacked', 'JHarness.exe');

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

async function main() {
  const data = await mkdtemp(path.join(tmpdir(), 'jharness-gui-smoke-'));
  try {
    const emptyData = path.join(data, 'empty');
    await mkdir(emptyData);
    const smoke = await run(emptyData);
    assert.match(smoke.text, /JHarness/);
    assert.match(smoke.taskCenter, /任务中心/);
    assert.match(smoke.taskCenter, /没有运行中或等待处理的任务/);
    assert.match(smoke.plugins, /尚未显式安装外部工具插件/);
    await verifyInterruptedApproval(path.join(data, 'approval'));
    await verifyRecoverableTask(path.join(data, 'task'));
    console.log('PACKAGED_GUI_SMOKE_OK');
  } finally {
    await rm(data, { recursive: true, force: true, maxRetries: 5 });
  }
}

async function verifyInterruptedApproval(data) {
  const projectId = randomUUID();
  const directory = path.join(data, 'project');
  const workspace = path.join(data, 'workspaces', projectId);
  const approvalsFile = path.join(workspace, 'approvals.json');
  const record = {
    id: randomUUID(), runId: randomUUID(), operation: 'create_file', path: 'Interrupted.txt',
    before: '', after: 'must not be written', createdAt: Date.now(), status: 'PENDING'
  };
  await mkdir(directory, { recursive: true });
  await mkdir(workspace, { recursive: true });
  await writeFile(approvalsFile, JSON.stringify([record]));
  await writeFile(path.join(data, 'settings.json'), JSON.stringify({
    models: [], projects: [{ id: projectId, directory, name: 'Smoke project',
      sessions: [{ id: randomUUID(), title: 'Smoke session' }] }]
  }));

  const smoke = await run(data, 'approval');
  assert.match(smoke.heading, /中断的审批/);
  assert.ok(smoke.text.includes(record.path), smoke.text);
  assert.match(smoke.text, /等待批准时中断/);
  assert.doesNotMatch(smoke.text, /批准这一次/);
  assert.match(smoke.context, /当前会话还没有模型请求记录/);
  assert.match(smoke.reports, /当前会话还没有任务报告/);
  assert.match(smoke.worktrees, /隔离工作树/);
  assert.match(smoke.checkpoints, /当前会话还没有文件检查点/);
  const records = JSON.parse(await readFile(approvalsFile, 'utf8'));
  assert.deepEqual(records, [{ ...record, status: 'DISMISSED', interruptedFrom: 'PENDING' }]);
  await assert.rejects(stat(path.join(directory, record.path)), { code: 'ENOENT' });
}

async function verifyRecoverableTask(data) {
  const projectId = randomUUID();
  const sessionId = randomUUID();
  const directory = path.join(data, 'project');
  const workspaceRoot = path.join(data, 'workspaces');
  await mkdir(directory, { recursive: true });
  await mkdir(workspaceRoot, { recursive: true });
  const server = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    const results = body.messages.filter(message => message.role === 'tool');
    const delta = results.length
      ? { role: 'assistant', content: '恢复任务完成' }
      : { role: 'assistant', tool_calls: [{ index: 0, id: 'smoke-call-1', type: 'function',
          function: { name: 'create_file', arguments: JSON.stringify({
            path: 'Recovery.txt', content: 'recovered task output'
          }) } }] };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end('data: ' + JSON.stringify({ id: 'chatcmpl-' + randomUUID(),
      object: 'chat.completion.chunk', created: 1, model: 'fixture',
      choices: [{ index: 0, delta, finish_reason: delta.tool_calls ? 'tool_calls' : 'stop' }] })
      + '\n\ndata: [DONE]\n\n');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  let backend;
  try {
    backend = await launchPackagedBackend(workspaceRoot);
    const runId = randomUUID();
    await backend.call('chat', {
      projectId,
      sessionId,
      projectPath: directory,
      provider: 'compatible',
      model: 'fixture',
      key: 'fixture-key',
      baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1',
      runId,
      permission: 'durable',
      message: '创建一个待审批文件'
    });
    await backend.waitEvent(runId, 'done', event => event.data.status === 'suspended');
    const task = await backend.call('task', { projectId, sessionId });
    assert.equal(task.status, 'suspended');
    assert.equal(task.approvals.length, 1);
    await backend.close();
    backend = null;

    await writeFile(path.join(data, 'settings.json'), JSON.stringify({
      models: [],
      projects: [{ id: projectId, directory, name: 'Task project',
        sessions: [{ id: sessionId, title: 'Recoverable task' }] }]
    }));
    const smoke = await run(data, 'task');
    assert.match(smoke.task, /任务等待审批/);
    assert.match(smoke.task, /Recovery\.txt/);
    assert.match(smoke.task, /批准/);
    await assert.rejects(stat(path.join(directory, 'Recovery.txt')), { code: 'ENOENT' });
  } finally {
    if (backend) await backend.close();
    server.closeAllConnections();
    server.close();
  }
}

async function launchPackagedBackend(data) {
  const resources = path.resolve(__dirname, '..', '..', 'release', 'win-unpacked', 'resources');
  const child = spawn(path.join(resources, 'runtime', 'bin', 'java.exe'),
    ['-Dfile.encoding=UTF-8', '-jar', path.join(resources, 'backend.jar'), data],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-14000); });
  const pending = new Map();
  const events = [];
  createInterface({ input: child.stdout }).on('line', line => {
    const message = JSON.parse(line);
    if (message.event) {
      events.push(message);
      return;
    }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error + '\n' + stderr));
    else request.resolve(message.result);
  });
  child.once('exit', () => {
    for (const request of pending.values()) request.reject(new Error(stderr || 'Java backend exited'));
  });
  return {
    call(method, params) {
      return new Promise((resolve, reject) => {
        const id = randomUUID();
        pending.set(id, { resolve, reject });
        child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
      });
    },
    async waitEvent(runId, type, predicate = () => true) {
      for (let i = 0; i < 150; i++) {
        const event = events.find(item => item.runId === runId
          && item.event === type && predicate(item));
        if (event) return event;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error('Backend event did not arrive: ' + type + '\n' + stderr);
    },
    async close() {
      if (child.exitCode !== null) return;
      const exited = once(child, 'exit');
      child.stdin.end();
      await exited;
    }
  };
}

async function run(data, mode = 'base') {
  const args = ['--jharness-smoke', '--enable-logging'];
  if (mode === 'approval') args.push('--jharness-smoke-approval');
  if (mode === 'task') args.push('--jharness-smoke-task');
  const result = await launch(data, args, mode === 'base' ? 20000 : 30000);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const prefix = 'JHARNESS_SMOKE_OK ';
  const marker = result.stdout.split(/\r?\n/).find(line => line.startsWith(prefix));
  assert.ok(marker, result.stdout + result.stderr);
  const smoke = JSON.parse(marker.slice(prefix.length));
  assert.match(smoke.url, /resources\/app\/dist\/index\.html$/);
  return smoke;
}

function launch(data, args, timeout) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
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
    }, timeout);
    child.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', code => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

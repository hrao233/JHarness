const assert = require('node:assert/strict');
const { execFile, spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { once } = require('node:events');
const { createServer } = require('node:http');
const { mkdir, mkdtemp, readFile, rm, stat, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { createInterface } = require('node:readline');
const { setTimeout: delay } = require('node:timers/promises');
const { promisify } = require('node:util');
const { verifyManifest } = require('../../apps/desktop/electron/release-manifest.cjs');

const executable = path.resolve(__dirname, '..', '..', 'release', 'win-unpacked', 'JHarness.exe');

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

async function main() {
  const data = await mkdtemp(path.join(tmpdir(), 'jharness-gui-smoke-'));
  try {
    if (process.argv.includes('--recovery')) {
      await verifyUncertainCommand(data);
      console.log('PACKAGED_UNCERTAIN_RECOVERY_OK');
      return;
    }
    const verified = await verifyManifest(path.join(__dirname, '..', '..', 'release', 'win-unpacked'));
    assert.equal(verified.version, require('../../package.json').version);
    const cliHelp = await command(path.join(__dirname, '..', '..', 'release', 'win-unpacked',
      'jharness-cli.cmd'), ['--help']);
    assert.match(cliHelp, /JHarness CLI/);
    assert.match(cliHelp, /jharness run/);
    const emptyData = path.join(data, 'empty');
    await mkdir(emptyData);
    const smoke = await run(emptyData);
    assert.match(smoke.text, /JHarness/);
    assert.match(smoke.taskCenter, /任务中心/);
    assert.match(smoke.taskCenter, /没有运行中或等待处理的任务/);
    assert.match(smoke.plugins, /尚未显式安装外部工具插件/);
    await verifyInterruptedApproval(path.join(data, 'approval'));
    await verifyRecoverableTask(path.join(data, 'task'));
    await verifyDesktopConversation(path.join(data, 'conversation'));
    console.log('PACKAGED_GUI_SMOKE_OK');
  } finally {
    await rm(data, { recursive: true, force: true, maxRetries: 5 });
  }
}

function command(file, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.ComSpec || 'cmd.exe',
      ['/d', '/s', '/c', 'call', file, ...args], { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('packaged CLI timed out\n' + stdout + stderr));
    }, 10000);
    child.once('error', reject);
    child.once('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error('packaged CLI failed\n' + stdout + stderr));
    });
  });
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
  assert.match(smoke.automations, /当前项目还没有自动任务/);
  assert.match(smoke.maintenance, /本地数据与恢复/);
  assert.equal(smoke.browser, '网页地址');
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

async function verifyDesktopConversation(data) {
  const directory = path.join(data, 'project');
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(data, 'settings.json'), JSON.stringify({
    models: [],
    projects: [{ id: randomUUID(), name: 'Conversation smoke project', directory, sessions: [] }]
  }));
  const fixture = {
    model: 'desktop-smoke-fixture',
    key: 'fixture-key',
    prompt: '创建一个需要我批准的文件',
    lead: '正在准备写入预览。',
    file: 'ConversationSmoke.txt',
    content: 'Verified from the packaged desktop.',
    reply: '已按批准内容创建文件。'
  };
  const target = path.join(directory, fixture.file);
  let releaseStream;
  const streamVisible = new Promise(resolve => { releaseStream = resolve; });
  const stages = [];
  let fixtureError;
  const server = createServer(async (request, response) => {
    try {
      if (request.method === 'GET' && request.url === '/paper') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end('<!doctype html><title>Paper Inspiration</title><p>angle-core paper</p>');
        return;
      }
      let raw = '';
      for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw);
      assert.equal(request.url, '/v1/chat/completions');
      assert.equal(request.headers.authorization, 'Bearer ' + fixture.key);
      assert.equal(body.model, fixture.model);
      assert.equal(body.stream, true);
      const messages = body.messages;
      const id = 'chatcmpl-' + randomUUID();
      const stream = (delta, finish_reason = null) => response.write('data: ' + JSON.stringify({
        id, object: 'chat.completion.chunk', created: 1, model: fixture.model,
        choices: [{ index: 0, delta, finish_reason }]
      }) + '\n\n');
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      if (stages.length === 0) {
        assert.ok(messages.some(message => message.role === 'user'
          && JSON.stringify(message.content).includes('Reply with OK.')));
        stages.push('connection');
        stream({ role: 'assistant', content: 'OK' }, 'stop');
      } else if (stages.length === 1) {
        assert.ok(messages.some(message => message.role === 'user'
          && JSON.stringify(message.content).includes(fixture.prompt)));
        assert.ok(body.tools.some(tool => tool.function.name === 'create_file'));
        stages.push('preview');
        stream({ role: 'assistant', content: fixture.lead });
        // Release the tool call only after the first chunk is visible in the renderer.
        await streamVisible;
        stream({ tool_calls: [{ index: 0, id: 'desktop-smoke-file', type: 'function',
          function: { name: 'create_file', arguments: JSON.stringify({
            path: fixture.file, content: fixture.content
          }) } }] }, 'tool_calls');
      } else {
        assert.deepEqual(stages, ['connection', 'preview']);
        const result = messages.find(message => message.role === 'tool');
        assert.equal(result?.tool_call_id, 'desktop-smoke-file');
        assert.equal(await readFile(target, 'utf8'), fixture.content);
        stages.push('approved');
        stream({ role: 'assistant', content: fixture.replyMarkdown || fixture.reply }, 'stop');
      }
      response.end('data: [DONE]\n\n');
    } catch (error) {
      fixtureError ??= error;
      if (!response.headersSent) response.writeHead(500);
      response.end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  fixture.endpoint = 'http://127.0.0.1:' + server.address().port + '/v1';
  fixture.paperUrl = 'http://127.0.0.1:' + server.address().port + '/paper';
  fixture.replyMarkdown = '已按批准内容创建文件。[参考论文](' + fixture.paperUrl + ')';
  fixture.reply = '已按批准内容创建文件。参考论文';

  try {
    const live = await run(data, 'conversation', { fixture, releaseStream });
    assert.deepEqual(stages, ['connection', 'preview', 'approved']);
    assert.equal(await readFile(target, 'utf8'), fixture.content);
    const reopened = await run(data, 'reopen', { fixture });
    const expected = { prompt: fixture.prompt, reply: fixture.reply, session: fixture.prompt, url: live.url };
    assert.deepEqual(live, expected);
    assert.deepEqual(reopened, expected);
    assert.deepEqual(stages, ['connection', 'preview', 'approved']);
    assert.ifError(fixtureError);
    console.log('PACKAGED_DESKTOP_CONVERSATION_OK');
  } catch (error) {
    if (fixtureError) throw new AggregateError([fixtureError, error], 'Packaged desktop conversation failed');
    throw error;
  } finally {
    releaseStream();
    server.closeAllConnections();
    server.close();
  }
}

async function verifyUncertainCommand(data) {
  const projectPath = path.join(data, 'project');
  const workspaceRoot = path.join(data, 'workspaces');
  await mkdir(projectPath);
  await mkdir(workspaceRoot);

  const context = { projectId: randomUUID(), sessionId: randomUUID(), projectPath };
  const callId = 'smoke-uncertain-command';
  const marker = randomUUID();
  const markerFile = path.join(projectPath, 'effect.txt');
  const command = "Add-Content -LiteralPath 'effect.txt' -Value '" + marker + "'; Start-Sleep -Seconds 90";
  const prompt = '执行一次等待人工核对的命令';
  const finalReply = '已核对并恢复任务';
  const requests = [];
  const server = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const { messages } = JSON.parse(raw);
    requests.push(messages);
    const delta = messages.some(message => message.role === 'tool')
      ? { role: 'assistant', content: finalReply }
      : { role: 'assistant', tool_calls: [{ index: 0, id: callId, type: 'function',
          function: { name: 'run_command', arguments: JSON.stringify({ command }) } }] };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end('data: ' + JSON.stringify({ id: 'chatcmpl-' + randomUUID(),
      object: 'chat.completion.chunk', created: 1, model: 'fixture',
      choices: [{ index: 0, delta, finish_reason: delta.tool_calls ? 'tool_calls' : 'stop' }] })
      + '\n\ndata: [DONE]\n\n');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const model = {
    provider: 'compatible', model: 'fixture', key: 'fixture-key',
    baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1'
  };

  let backend;
  const effects = async () => (await readFile(markerFile, 'utf8')).trim().split(/\r?\n/);
  try {
    backend = await launchPackagedBackend(workspaceRoot);
    const runId = randomUUID();
    await backend.call('chat', { ...context, ...model, runId, permission: 'durable', message: prompt });
    await backend.waitEvent(runId, 'done', event => event.data.status === 'suspended');
    const awaitingApproval = await backend.call('task', context);
    assert.equal(awaitingApproval.status, 'suspended');
    assert.equal(awaitingApproval.approvals.length, 1);
    assert.equal(awaitingApproval.approvals[0].id, callId);
    assert.equal(awaitingApproval.approvals[0].after, command);
    await assert.rejects(stat(markerFile), { code: 'ENOENT' });

    const resume = { ...context, ...model, turnId: awaitingApproval.turnId };
    await backend.call('resumeTask', { ...resume, runId: randomUUID(), answers: { [callId]: true } });
    await poll(async () => {
      try {
        const observed = await effects();
        if (observed[0] === '') return false;
        assert.deepEqual(observed, [marker]);
        return true;
      } catch (error) {
        if (error.code === 'ENOENT') return false;
        throw error;
      }
    }, 15000, 100, 'The approved command never wrote its marker');
    await backend.killTree();

    backend = await launchPackagedBackend(workspaceRoot);
    // The dead process's real writer lease lasts up to two minutes.
    console.log('Waiting for the interrupted session writer lease to expire...');
    const interrupted = await poll(async () => {
      const task = await backend.call('task', context);
      return task.status === 'interrupted' && task;
    }, 135000, 1000, 'The interrupted task did not become available after its writer lease');
    assert.equal(interrupted.turnId, awaitingApproval.turnId);
    assert.equal(interrupted.uncertain, true);
    assert.deepEqual(interrupted.uncertainCalls, [{ id: callId, name: 'run_command' }]);
    assert.deepEqual(interrupted.approvals, []);
    assert.equal(requests.length, 1);
    assert.deepEqual(await effects(), [marker]);
    await assert.rejects(backend.call('resumeTask', { ...resume, runId: randomUUID(), answers: {} }),
      /结果待核对/);

    const reconciliationId = randomUUID();
    await backend.call('reconcileTask', {
      ...resume, runId: reconciliationId, answers: {}, outcomes: { [callId]: 'success' }
    });
    const done = await backend.waitEvent(reconciliationId, 'done');
    assert.equal(done.data.status, 'completed');
    assert.equal(requests.length, 2);
    const toolResults = requests[1].filter(message => message.role === 'tool');
    assert.equal(toolResults.length, 1);
    assert.equal(toolResults[0].tool_call_id, callId);
    assert.match(toolResults[0].content, /用户核对.+重启前完成/);
    assert.deepEqual(await effects(), [marker]);
    await backend.close();

    backend = await launchPackagedBackend(workspaceRoot);
    assert.deepEqual(await backend.call('task', context), {});
    const history = await backend.call('history', context);
    assert.ok(history.some(message => message.role === 'assistant' && message.text === finalReply));
    assert.deepEqual(await effects(), [marker]);
    assert.equal(requests.length, 2);
  } finally {
    try {
      if (backend) await backend.killTree();
    } finally {
      server.closeAllConnections();
      server.close();
    }
  }
}

async function poll(check, timeout, interval, message) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await delay(interval);
  }
  throw new Error(message);
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
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error(message.error + '\n' + stderr));
    else request.resolve(message.result);
  });
  function failPending(error) {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
  }
  child.once('error', failPending);
  child.once('exit', () => {
    failPending(new Error(stderr || 'Java backend exited'));
  });
  child.stdin.on('error', failPending);
  return {
    call(method, params) {
      return new Promise((resolve, reject) => {
        const id = randomUUID();
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error('Backend request timed out: ' + method + '\n' + stderr));
        }, 15000);
        pending.set(id, { resolve, reject, timer });
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
    },
    async killTree() {
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
      const taskkill = path.join(process.env.SystemRoot, 'System32', 'taskkill.exe');
      await Promise.all([
        once(child, 'exit'),
        promisify(execFile)(taskkill, ['/PID', String(child.pid), '/T', '/F'],
          { windowsHide: true, timeout: 10000 })
      ]);
    }
  };
}

async function run(data, mode = 'base', options) {
  const args = ['--jharness-smoke', '--enable-logging'];
  if (mode !== 'base') args.push('--jharness-smoke-' + mode);
  const timeout = mode === 'conversation' ? 65000 : mode === 'base' ? 20000 : 30000;
  const result = await launch(data, args, timeout, options);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const prefix = 'JHARNESS_SMOKE_OK ';
  const marker = result.stdout.split(/\r?\n/).find(line => line.startsWith(prefix));
  assert.ok(marker, result.stdout + result.stderr);
  const smoke = JSON.parse(marker.slice(prefix.length));
  assert.match(smoke.url, /resources\/app\/dist\/index\.html$/);
  return smoke;
}

function launch(data, args, timeout, { fixture, releaseStream } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      env: {
        ...process.env,
        ELECTRON_ENABLE_LOGGING: '1',
        JHARNESS_SMOKE_DATA: data,
        ...(fixture ? { JHARNESS_SMOKE_CONVERSATION: JSON.stringify(fixture) } : {})
      },
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => {
      stdout += chunk;
      if (releaseStream && stdout.includes('JHARNESS_SMOKE_STREAM_VISIBLE')) {
        releaseStream();
        releaseStream = null;
      }
    });
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

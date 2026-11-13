const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { randomUUID } = require('node:crypto');
const { createInterface } = require('node:readline');
const { mkdtemp, mkdir, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');

test('stream a tool-assisted reply and reopen the session', { timeout: 45000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'jharness-test-'));
  const projectPath = path.join(root, 'project');
  const data = path.join(root, 'data');
  await mkdir(projectPath);
  await writeFile(path.join(projectPath, 'README.md'), '# Fixture\nProject fact: ORCHID-27.');
  const requests = [];
  const server = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    requests.push({ path: request.url, auth: request.headers.authorization, body });
    const toolOutput = body.messages.some(message => message.role === 'tool' && JSON.stringify(message).includes('ORCHID-27'));
    const toolAvailable = body.tools?.some(tool => tool.function?.name === 'read_file');
    const delta = toolAvailable && !toolOutput
      ? { role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function',
          function: { name: 'read_file', arguments: '{"path":"README.md"}' } }] }
      : { role: 'assistant', content: toolOutput ? '**ORCHID-27**' : 'OK' };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end('data: ' + JSON.stringify({ id: 'chatcmpl-test', object: 'chat.completion.chunk',
      created: 1, model: 'fixture', choices: [{ index: 0, delta,
        finish_reason: delta.tool_calls ? 'tool_calls' : 'stop' }] }) + '\n\ndata: [DONE]\n\n');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const model = { provider: 'compatible', model: 'fixture', key: 'fixture-key',
    baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1' };
  const context = { projectId: randomUUID(), sessionId: randomUUID(), projectPath };
  const events = [];
  let child;
  function launch() {
    child = spawn(path.join('runtime', 'bin', 'java.exe'),
      ['-jar', 'backend/target/jharness-backend.jar', data], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-7000); });
    const pending = new Map();
    createInterface({ input: child.stdout }).on('line', line => {
      const message = JSON.parse(line);
      if (message.event) events.push(message);
      else {
        const request = pending.get(message.id);
        if (request) {
          pending.delete(message.id);
          if (message.error) request.reject(new Error(message.error + '\n' + stderr));
          else request.resolve(message.result);
        }
      }
    });
    child.on('exit', () => {
      for (const request of pending.values()) request.reject(new Error(stderr || 'Java exited'));
    });
    return (method, params) => new Promise((resolve, reject) => {
      const id = randomUUID();
      pending.set(id, { resolve, reject });
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }
  try {
    let call = launch();
    assert.equal((await call('testModel', model)).model, 'fixture');
    await call('chat', { ...context, ...model, runId: randomUUID(), message: '读 README' });
    for (let i = 0; i < 200 && !events.some(event => event.event === 'done'); i++) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(events.some(event => event.event === 'tool-start' && event.data.name === 'read_file'),
      JSON.stringify(events));
    assert.ok(events.some(event => event.event === 'result' && event.data.text.includes('ORCHID-27')),
      JSON.stringify(events));
    assert.ok(requests.every(request => request.path === '/v1/chat/completions' && request.auth === 'Bearer fixture-key'));
    assert.ok(requests.filter(request => request.body.tools?.length).every(request =>
      request.body.tools.every(tool => ['read_file', 'list_files', 'search_files'].includes(tool.function.name))));
    const exited = once(child, 'exit');
    child.stdin.end();
    await exited;
    call = launch();
    const history = await call('history', context);
    assert.deepEqual(history.map(message => message.role), ['user', 'assistant']);
    assert.match(history[1].text, /ORCHID-27/);
  } finally {
    if (child && child.exitCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
    server.closeAllConnections();
    server.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  }
});

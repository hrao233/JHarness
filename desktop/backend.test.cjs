const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { randomUUID } = require('node:crypto');
const { createInterface } = require('node:readline');
const { mkdtemp, mkdir, readFile, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');

test('read and edit project files, stream a reply, and reopen the session', { timeout: 45000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'jharness-test-'));
  const projectPath = path.join(root, 'project');
  const data = path.join(root, 'data');
  await mkdir(projectPath);
  await writeFile(path.join(projectPath, 'README.md'), '# Fixture\r\nProject fact: ORCHID-27.\r\n');
  await writeFile(path.join(root, 'outside.txt'), 'untouched');
  const steps = [
    ['read_file', { path: 'README.md' }, 'ORCHID-27'],
    ['edit_file', { path: 'README.md', old_text: '# Fixture\nProject fact: ORCHID-27.',
      new_text: '# Fixture\nProject fact: ORCHID-28.' }, '已编辑 README.md'],
    ['create_file', { path: 'Note.java', content: 'class Note {}\n' }, '已创建 Note.java'],
    ['create_file', { path: 'Note.java', content: 'must not overwrite' }, '无法创建文件'],
    ['edit_file', { path: '../outside.txt', old_text: 'untouched', new_text: 'changed' }, '无法编辑此文件'],
    ['edit_file', { path: 'README.md', old_text: 'ORCHID-27', new_text: 'changed' }, '原文必须'],
  ];
  const requests = [];
  const server = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    requests.push({ path: request.url, auth: request.headers.authorization, body });
    const results = body.messages.filter(message => message.role === 'tool');
    const toolAvailable = body.tools?.some(tool => tool.function?.name === 'read_file');
    const step = steps[results.length];
    const delta = toolAvailable && step
      ? { role: 'assistant', tool_calls: [{ index: 0, id: 'call_' + results.length, type: 'function',
          function: { name: step[0], arguments: JSON.stringify(step[1]) } }] }
      : { role: 'assistant', content: toolAvailable ? '**ORCHID-28**' : 'OK' };
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
    await call('chat', { ...context, ...model, runId: randomUUID(), message: '读并修改 README，然后创建 Note.java' });
    for (let i = 0; i < 200 && !events.some(event => event.event === 'done'); i++) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(events.some(event => event.event === 'tool-start' && event.data.name === 'read_file'),
      JSON.stringify(events));
    assert.ok(events.some(event => event.event === 'result' && event.data.text.includes('ORCHID-28')),
      JSON.stringify(events));
    const results = requests.at(-1).body.messages.filter(message => message.role === 'tool');
    assert.equal(results.length, steps.length);
    for (const [index, step] of steps.entries()) assert.ok(JSON.stringify(results[index]).includes(step[2]));
    assert.equal(await readFile(path.join(projectPath, 'README.md'), 'utf8'),
      '# Fixture\r\nProject fact: ORCHID-28.\r\n');
    assert.equal(await readFile(path.join(projectPath, 'Note.java'), 'utf8'), 'class Note {}\n');
    assert.equal(await readFile(path.join(root, 'outside.txt'), 'utf8'), 'untouched');
    assert.ok(requests.every(request => request.path === '/v1/chat/completions' && request.auth === 'Bearer fixture-key'));
    assert.ok(requests.filter(request => request.body.tools?.length).every(request =>
      request.body.tools.every(tool => ['read_file', 'list_files', 'search_files', 'edit_file', 'create_file']
        .includes(tool.function.name))));
    const exited = once(child, 'exit');
    child.stdin.end();
    await exited;
    call = launch();
    const history = await call('history', context);
    assert.deepEqual(history.map(message => message.role), ['user', 'assistant']);
    assert.match(history[1].text, /ORCHID-28/);
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

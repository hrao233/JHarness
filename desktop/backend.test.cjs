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
  let steps = [
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
    async function waitEvent(runId, type) {
      for (let i = 0; i < 150; i++) {
        const event = events.find(event => event.runId === runId && event.event === type);
        if (event) return event;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      assert.fail(JSON.stringify(events));
    }
    assert.equal((await call('testModel', model)).model, 'fixture');
    const full = randomUUID();
    await call('chat', { ...context, ...model, runId: full, permission: 'full', effort: 'high',
      message: '读并修改 README，然后创建 Note.java',
      parts: [{ label: '文件 · info.txt', kind: 'file', text: 'FILE-CONTEXT' },
        { label: '插件 Skill · formatter', kind: 'plugin', text: 'SKILL-CONTEXT' },
        { label: '图片 · fixture.png', kind: 'image', mime: 'image/png', image: 'iVBORw0KGgo=' }] });
    await waitEvent(full, 'done');
    assert.equal(events.some(event => event.runId === full && event.event === 'approval'), false);
    const firstChat = requests.find(request => request.body.tools?.length).body;
    assert.equal(firstChat.reasoning_effort, 'high');
    assert.match(JSON.stringify(firstChat.messages), /FILE-CONTEXT/);
    assert.match(JSON.stringify(firstChat.messages), /SKILL-CONTEXT/);
    assert.match(JSON.stringify(firstChat.messages), /data:image\/png;base64,iVBORw0KGgo=/);
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
    assert.match(history[0].text, /info.txt/);
    assert.match(history[0].text, /fixture.png/);
    assert.doesNotMatch(history[0].text, /FILE-CONTEXT/);
    assert.match(history[1].text, /ORCHID-28/);

    const ask = randomUUID();
    steps = [['edit_file', { path: 'README.md', old_text: 'ORCHID-28', new_text: 'NOT-APPROVED' }]];
    await call('chat', { ...context, sessionId: randomUUID(), ...model, runId: ask, permission: 'ask', message: '编辑' });
    const edit = await waitEvent(ask, 'approval');
    assert.equal(edit.data.path, 'README.md');
    assert.equal(edit.data.after, 'NOT-APPROVED');
    assert.equal(await call('approve', { runId: full, approvalId: edit.data.id, allow: true }), false);
    assert.equal(await call('approve', { runId: ask, approvalId: edit.data.id, allow: false }), true);
    await waitEvent(ask, 'done');
    assert.match(await readFile(path.join(projectPath, 'README.md'), 'utf8'), /ORCHID-28/);

    const assist = randomUUID();
    steps = [
      ['edit_file', { path: 'README.md', old_text: 'ORCHID-28', new_text: 'ORCHID-29' }],
      ['create_file', { path: 'Approved.txt', content: 'approved' }],
    ];
    await call('chat', { ...context, sessionId: randomUUID(), ...model, runId: assist,
      permission: 'assist', message: '修改并创建' });
    const create = await waitEvent(assist, 'approval');
    assert.equal(create.data.operation, 'create_file');
    assert.match(await readFile(path.join(projectPath, 'README.md'), 'utf8'), /ORCHID-29/);
    await assert.rejects(readFile(path.join(projectPath, 'Approved.txt')), { code: 'ENOENT' });
    assert.equal(await call('approve', { runId: assist, approvalId: create.data.id, allow: true }), true);
    await waitEvent(assist, 'done');
    assert.equal(await readFile(path.join(projectPath, 'Approved.txt'), 'utf8'), 'approved');

    const stopped = randomUUID();
    steps = [['create_file', { path: 'Cancelled.txt', content: 'cancelled' }]];
    await call('chat', { ...context, sessionId: randomUUID(), ...model, runId: stopped, permission: 'ask', message: '创建' });
    const cancelled = await waitEvent(stopped, 'approval');
    await call('stop', { runId: stopped });
    await waitEvent(stopped, 'done');
    assert.equal(await call('approve', { runId: stopped, approvalId: cancelled.data.id, allow: true }), false);
    await assert.rejects(readFile(path.join(projectPath, 'Cancelled.txt')), { code: 'ENOENT' });
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

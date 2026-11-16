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
  const skillFolder = path.join(projectPath, '.agents', 'skills', 'fixture');
  await mkdir(skillFolder, { recursive: true });
  await writeFile(path.join(skillFolder, 'SKILL.md'), '---\nname: fixture\ndescription: Fixture project procedure\n---\nSKILL-BODY-18');
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
  let backendLog = '';
  let websiteReads = 0;
  let endless = false;
  let reviewResponses = [];
  const server = createServer(async (request, response) => {
    if (request.url === '/fixture-page') {
      websiteReads++;
      return response.end('TEST-WEB-PAGE');
    }
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    requests.push({ path: request.url, auth: request.headers.authorization, body });
    const reviewing = body.messages.some(message => JSON.stringify(message.content).includes('review one proposed project file write'));
    const extracting = body.messages.some(message => JSON.stringify(message.content).includes('memory extraction assistant'));
    const consolidating = body.messages.some(message => JSON.stringify(message.content).includes('New daily ledger entries to merge'));
    const results = body.messages.filter(message => message.role === 'tool');
    const toolAvailable = body.tools?.some(tool => tool.function?.name === 'read_file');
    const step = endless ? ['list_files', { path: '.' }] : steps[results.length];
    const delta = toolAvailable && step
      ? { role: 'assistant', tool_calls: [{ index: 0, id: 'call_' + results.length, type: 'function',
          function: { name: step[0], arguments: JSON.stringify(step[1]) } }] }
      : { role: 'assistant', content: reviewing ? reviewResponses.shift()
        : extracting ? '- AUTO-FACT-198' : consolidating ? '- AUTO-FACT-198（已整理）'
        : toolAvailable ? '**ORCHID-28**' : endless ? 'FIXTURE-LIMIT-SUMMARY' : 'OK' };
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
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-14000); backendLog = stderr; });
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
    await call('chat', { ...context, ...model, runId: full, permission: 'full', effort: 'high', serviceTier: 'fast',
      message: '读并修改 README，然后创建 Note.java',
      parts: [{ label: '文件 · info.txt', kind: 'file', text: 'FILE-CONTEXT' },
        { label: '插件 Skill · formatter', kind: 'plugin', text: 'SKILL-CONTEXT' },
        { label: '图片 · fixture.png', kind: 'image', mime: 'image/png', image: 'iVBORw0KGgo=' }] });
    await waitEvent(full, 'done');
    assert.deepEqual(events.filter(event => event.runId === full && event.event === 'loop-phase')
      .map(event => [event.data.step, event.data.phase]),
      [...steps.flatMap((_, index) => [[index + 1, 'reasoning'], [index + 1, 'acting']]), [steps.length + 1, 'reasoning']]);
    assert.equal(events.some(event => event.runId === full && event.event === 'approval'), false);
    const firstChat = requests.find(request => request.body.tools?.length).body;
    assert.equal(firstChat.reasoning_effort, 'high');
    assert.equal(firstChat.service_tier, 'fast');
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
      request.body.tools.every(tool => ['read_file', 'list_files', 'search_files', 'search_text', 'edit_file',
        'create_file', 'run_command', 'todo_write', 'memory_save', 'memory_get', 'memory_search',
        'session_search', 'session_list', 'session_history', 'load_skill_through_path', 'web_fetch',
        'web_search'].includes(tool.function.name))));
    assert.ok(['todo_write', 'memory_save', 'memory_search', 'memory_get', 'session_search',
      'session_list', 'session_history', 'search_text', 'load_skill_through_path'].every(name =>
      firstChat.tools.some(tool => tool.function.name === name)), JSON.stringify(firstChat.tools.map(tool => tool.function.name)));
    const exited = once(child, 'exit');
    child.stdin.end();
    await exited;
    call = launch();
    const history = await call('history', context);
    assert.deepEqual(history.map(message => message.role), ['user', 'assistant']);
    assert.deepEqual(history.map(message => message.turn), [1, 1]);
    assert.equal(history[0].id, full);
    assert.equal(history[1].id, (await waitEvent(full, 'result')).data.id);
    assert.match(history[0].text, /info.txt/);
    assert.match(history[0].text, /fixture.png/);
    assert.doesNotMatch(history[0].text, /FILE-CONTEXT/);
    assert.match(history[1].text, /ORCHID-28/);
    const search = await call('searchSessions', { query: 'orchid-28', sessions: [{ ...context, title: 'Fixture' }] });
    assert.equal(search[0].messageId, history[1].id);
    assert.match(search[0].excerpt, /ORCHID-28/);
    assert.deepEqual(await call('searchSessions', {
      query: 'FILE-CONTEXT', sessions: [{ ...context, title: 'Fixture' }]
    }), []);
    await assert.rejects(call('addBookmark', { ...context, messageId: randomUUID(), text: 'forged' }));
    const saved = await call('addBookmark', { ...context, messageId: history[1].id, text: 'ignored' });
    assert.equal(saved[0].messageId, history[1].id);
    assert.equal(saved[0].text, history[1].text);
    assert.deepEqual(await call('addBookmark', { ...context, messageId: history[1].id }), saved);
    const legacy = { ...context, id: randomUUID(), turn: 1, role: 'user', text: history[0].text };
    assert.equal(await call('importBookmarks', { bookmarks: [legacy, legacy] }), true);
    const afterImport = await call('listBookmarks');
    assert.equal(afterImport.length, 2);
    assert.equal(afterImport.find(item => item.id === legacy.id).messageId, history[0].id);
    const afterSave = once(child, 'exit');
    child.stdin.end();
    await afterSave;
    call = launch();
    assert.deepEqual(await call('listBookmarks'), afterImport);
    assert.equal((await call('removeBookmark', { id: saved[0].id })).length, 1);

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
      ['create_file', { path: 'Blocked.txt', content: 'deny this change' }],
      ['create_file', { path: 'Approved.txt', content: 'approved' }],
    ];
    reviewResponses = ['APPROVE', 'DENY', 'unrecognized response'];
    await call('chat', { ...context, sessionId: randomUUID(), ...model, runId: assist,
      permission: 'assist', effort: 'low', serviceTier: 'priority', message: '修改并创建' });
    const create = await waitEvent(assist, 'approval');
    assert.equal(create.data.operation, 'create_file');
    assert.match(await readFile(path.join(projectPath, 'README.md'), 'utf8'), /ORCHID-29/);
    await assert.rejects(readFile(path.join(projectPath, 'Approved.txt')), { code: 'ENOENT' });
    assert.equal(await call('approve', { runId: assist, approvalId: create.data.id, allow: true }), true);
    await waitEvent(assist, 'done');
    assert.equal(await readFile(path.join(projectPath, 'Approved.txt'), 'utf8'), 'approved');
    await assert.rejects(readFile(path.join(projectPath, 'Blocked.txt')), { code: 'ENOENT' });
    assert.deepEqual(events.filter(event => event.runId === assist && event.event === 'review')
      .map(event => event.data.decision), ['PENDING', 'APPROVE', 'PENDING', 'DENY', 'PENDING', 'ASK']);
    const reviews = requests.filter(({ body }) => body.messages
      .some(message => JSON.stringify(message.content).includes('review one proposed project file write')));
    assert.equal(reviews.length, 3);
    assert.ok(reviews.every(({ body }) => !body.tools?.length && !body.service_tier && !body.reasoning_effort));
    assert.ok(requests.some(({ body }) => body.tools?.length && body.service_tier === 'priority'
      && body.reasoning_effort === 'low'));

    const stopped = randomUUID();
    steps = [['create_file', { path: 'Cancelled.txt', content: 'cancelled' }]];
    await call('chat', { ...context, sessionId: randomUUID(), ...model, runId: stopped, permission: 'ask', message: '创建' });
    const cancelled = await waitEvent(stopped, 'approval');
    await call('stop', { runId: stopped });
    await waitEvent(stopped, 'done');
    assert.equal(await call('approve', { runId: stopped, approvalId: cancelled.data.id, allow: true }), false);
    await assert.rejects(readFile(path.join(projectPath, 'Cancelled.txt')), { code: 'ENOENT' });

    const terminal = randomUUID();
    const command = "[IO.File]::WriteAllText([IO.Path]::Combine((Get-Location).Path, 'command.txt'), 'approved'); Write-Output '完成'; exit 7";
    steps = [
      ['run_command', { command: "[IO.File]::WriteAllText([IO.Path]::Combine((Get-Location).Path, 'denied.txt'), 'unexpected')" }],
      ['run_command', { command }],
    ];
    await call('chat', { ...context, sessionId: randomUUID(), ...model, runId: terminal,
      permission: 'full', message: '运行项目命令' });
    const denied = await waitEvent(terminal, 'approval');
    assert.equal(denied.data.operation, 'run_command');
    await call('approve', { runId: terminal, approvalId: denied.data.id, allow: false });
    let commandApproval;
    for (let i = 0; i < 150 && !commandApproval; i++) {
      commandApproval = events.find(event => event.runId === terminal && event.event === 'approval'
        && event.data.id !== denied.data.id);
      if (!commandApproval) await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(commandApproval?.data.after, command);
    assert.equal(path.normalize(commandApproval.data.path), projectPath);
    await assert.rejects(readFile(path.join(projectPath, 'denied.txt')), { code: 'ENOENT' });
    await assert.rejects(readFile(path.join(projectPath, 'command.txt')), { code: 'ENOENT' });
    await call('approve', { runId: terminal, approvalId: commandApproval.data.id, allow: true });
    await waitEvent(terminal, 'done');
    assert.equal(await readFile(path.join(projectPath, 'command.txt'), 'utf8'), 'approved');
    const commandResults = JSON.stringify(requests.at(-1).body.messages.filter(message => message.role === 'tool'));
    assert.match(commandResults, /命令未获批准/);
    assert.match(commandResults, /退出码 7/);
    assert.match(commandResults, /完成/);

    const memory = randomUUID();
    await writeFile(path.join(projectPath, 'MEMORY.md'), 'UNTRUSTED-PROJECT-MEMORY');
    steps = [
      ['memory_save', { content: '- Prefer build profile LOCAL-ORCHID.' }],
      ['search_text', { query: 'ORCHID-29' }],
      ['todo_write', { todos: [{ content: 'Check the fixture', status: 'in_progress', priority: 'medium' }] }],
      ['load_skill_through_path', { skillId: 'fixture_agents', path: 'SKILL.md' }],
    ];
    await call('chat', { ...context, sessionId: randomUUID(), ...model, runId: memory,
      permission: 'full', message: '记住构建约定并搜索项目' });
    await waitEvent(memory, 'done');
    assert.match(JSON.stringify(requests.at(-1).body.messages), /README\.md:2/);
    assert.match(JSON.stringify(requests.at(-1).body.messages.filter(message => message.role === 'tool')), /SKILL-BODY-18/);
    assert.doesNotMatch(JSON.stringify(requests.at(-1).body.messages), /UNTRUSTED-PROJECT-MEMORY/);
    const savedMemory = await call('memoryList', context);
    assert.match(savedMemory.summary, /LOCAL-ORCHID/);
    assert.match(await call('memorySearch', { ...context, query: 'local-orchid' }), /MEMORY\.md/);
    assert.equal(savedMemory.daily.length, 1);
    assert.match(await call('memoryRead', { ...context, name: savedMemory.daily[0] }), /LOCAL-ORCHID/);
    await assert.rejects(call('memoryRead', { ...context, name: '../README.md' }));
    assert.equal((await call('memoryList', { projectId: randomUUID() })).summary, '');
    await assert.rejects(call('memoryUpdate', { ...context, expected: 'stale', text: 'overwrite' }));
    assert.equal(await call('memoryUpdate', { ...context, expected: savedMemory.summary, text: '- LOCAL-ORCHID reviewed.' }), true);
    const memoryExit = once(child, 'exit');
    child.stdin.end();
    await memoryExit;
    call = launch();
    assert.match((await call('memoryList', context)).summary, /LOCAL-ORCHID reviewed/);

    const recall = randomUUID();
    steps = [['memory_search', { query: 'LOCAL-ORCHID' }],
      ['memory_get', { path: 'MEMORY.md', startLine: 1, endLine: 10 }],
      ['session_search', { query: 'ORCHID-28', maxResults: 1 }]];
    const recallStart = requests.length;
    await call('chat', { ...context, sessionId: randomUUID(), ...model, runId: recall,
      permission: 'full', message: '回顾以前的构建约定' });
    await waitEvent(recall, 'done');
    assert.match(JSON.stringify(requests[recallStart].body.messages), /LOCAL-ORCHID reviewed/);
    const recallResults = requests.at(-1).body.messages.filter(message => message.role === 'tool');
    assert.equal(recallResults.length, 3);
    assert.match(JSON.stringify(recallResults[0]), /MEMORY\.md/);
    assert.match(JSON.stringify(recallResults[1]), /LOCAL-ORCHID reviewed/);
    assert.match(JSON.stringify(recallResults[2]), /ORCHID-28/);

    const automatic = randomUUID();
    steps = [];
    const ledgers = path.join(data, context.projectId, 'memory');
    await writeFile(path.join(ledgers, '2000-01-01.md'), 'OLD-LEDGER-18');
    await call('chat', { ...context, sessionId: randomUUID(), ...model, runId: automatic,
      permission: 'full', autoMemory: true, message: '记下新的项目约定' });
    await waitEvent(automatic, 'done');
    for (let i = 0; i < 60; i++) {
      if ((await call('memoryList', context)).summary.includes('AUTO-FACT-198（已整理）')) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const maintained = await call('memoryList', context);
    assert.match(await call('memoryRead', { ...context, name: maintained.daily[0] }), /AUTO-FACT-198/, backendLog);
    assert.match(maintained.summary, /已整理/);
    assert.deepEqual(maintained.archive, ['2000-01-01.md']);
    assert.match(await call('memoryRead', { ...context, name: '2000-01-01.md', archive: true }), /OLD-LEDGER-18/);
    const web = randomUUID();
    const url = 'http://127.0.0.1:' + server.address().port + '/fixture-page';
    steps = [['web_fetch', { url }]];
    await call('chat', { ...context, sessionId: randomUUID(), ...model, runId: web,
      permission: 'full', message: '读取测试网页' });
    const approval = await waitEvent(web, 'approval');
    assert.equal(approval.data.operation, 'web_fetch');
    assert.equal(approval.data.after, url);
    assert.equal(websiteReads, 0);
    await call('approve', { runId: web, approvalId: approval.data.id, allow: true });
    await waitEvent(web, 'done');
    assert.equal(websiteReads, 1);
    assert.match(JSON.stringify(requests.at(-1).body.messages.filter(message => message.role === 'tool')), /TEST-WEB-PAGE/);

    const limited = randomUUID();
    endless = true;
    await call('chat', { ...context, sessionId: randomUUID(), ...model, runId: limited,
      permission: 'full', message: '测试循环上限' });
    await waitEvent(limited, 'done');
    assert.equal(events.filter(event => event.runId === limited && event.event === 'tool-start').length, 18);
    const limitResult = await waitEvent(limited, 'result');
    assert.equal(limitResult.data.reason, 'MAX_ITERATIONS');
    assert.match(limitResult.data.text, /FIXTURE-LIMIT-SUMMARY/);
    assert.ok(events.some(event => event.runId === limited && event.event === 'loop-phase'
      && event.data.phase === 'summary'));
    endless = false;

    for (const effort of ['default', 'none', 'low', 'high', 'max']) {
      await call('testModel', { ...model, provider: 'deepseek', model: 'deepseek-flash', effort });
      const payload = requests.at(-1).body;
      assert.equal(payload.thinking?.type, effort === 'default' ? undefined : effort === 'none' ? 'disabled' : 'enabled');
      assert.equal(payload.reasoning_effort, ['low', 'high', 'max'].includes(effort) ? effort : undefined);
      assert.equal(payload.service_tier, undefined);
    }
    await assert.rejects(call('testModel', { ...model, provider: 'deepseek', effort: 'medium' }));
    await assert.rejects(call('testModel', { ...model, provider: 'deepseek', serviceTier: 'fast' }));
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

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { randomUUID } = require('node:crypto');
const { createInterface } = require('node:readline');
const { existsSync } = require('node:fs');
const { copyFile, mkdtemp, mkdir, readFile, realpath, writeFile, rm } = require('node:fs/promises');
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
  let stalledReads = 0;
  let endless = false;
  let holdForSteer = false;
  let releaseHeldModel;
  let reviewResponses = [];
  const server = createServer(async (request, response) => {
    if (request.url === '/fixture-page') {
      websiteReads++;
      return response.end('TEST-WEB-PAGE');
    }
    if (request.url === '/in-flight-page') {
      stalledReads++;
      server.emit('in-flight-read');
      return;
    }
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    requests.push({ path: request.url, auth: request.headers.authorization, body });
    if (holdForSteer) {
      holdForSteer = false;
      server.emit('model-held');
      await new Promise(resolve => { releaseHeldModel = resolve; });
    }
    const reviewing = body.messages.some(message => JSON.stringify(message.content).includes('review one proposed project file write'));
    const extracting = body.messages.some(message => JSON.stringify(message.content).includes('memory extraction assistant'));
    const consolidating = body.messages.some(message => JSON.stringify(message.content).includes('New daily ledger entries to merge'));
    const results = body.messages.filter(message => message.role === 'tool');
    const toolAvailable = body.tools?.some(tool => tool.function?.name === 'read_file');
    const step = endless ? ['list_files', { path: '.' }] : steps[results.length];
    const delta = toolAvailable && step
      ? { role: 'assistant', tool_calls: [{ index: 0, id: 'call_' + results.length, type: 'function',
          function: { name: step[0], arguments: step[3] ?? JSON.stringify(step[1]) } }] }
      : { role: 'assistant', content: reviewing ? reviewResponses.shift()
        : extracting ? '- AUTO-FACT-198' : consolidating ? '- AUTO-FACT-198（已整理）'
        : toolAvailable ? '**ORCHID-28**' : endless ? 'FIXTURE-LIMIT-SUMMARY' : 'OK' };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end('data: ' + JSON.stringify({ id: 'chatcmpl-' + randomUUID(), object: 'chat.completion.chunk',
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
    const bundledJava = path.join('runtime', 'bin', 'java.exe');
    child = spawn(existsSync(bundledJava) ? bundledJava : 'java',
      ['-jar', 'apps/backend/target/jharness-backend.jar', data], { stdio: ['pipe', 'pipe', 'pipe'] });
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
    async function approvalRecord(approvalId) {
      const records = await call('approvals', { projectId: context.projectId });
      return records.find(item => item.id === approvalId);
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
    assert.deepEqual(events.filter(event => event.runId === full && event.event === 'tool-execution')
      .map(event => event.data.name), steps.map(step => step[0]));
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
        'create_file', 'run_command', 'deliver_artifact', 'acceptance_write', 'todo_write',
        'memory_save', 'memory_get', 'memory_search',
        'session_search', 'session_list', 'session_history', 'load_skill_through_path', 'web_fetch',
        'web_search'].includes(tool.function.name))));
    assert.ok(['todo_write', 'acceptance_write', 'memory_save', 'memory_search', 'memory_get', 'session_search',
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
    const contextSnapshot = await call('context', context);
    assert.ok(contextSnapshot.asOfSeq >= history.length);
    assert.ok(contextSnapshot.transcriptMessages >= 2);
    assert.equal(contextSnapshot.uncertainToolCalls, 0);
    assert.ok(contextSnapshot.lastRequest?.messageCount > 0);
    assert.ok(contextSnapshot.lastRequest.tools.includes('read_file'));
    assert.equal(contextSnapshot.branch, null);
    const markdownExport = await call('exportSession', { ...context, format: 'markdown', title: 'Fixture history' });
    assert.equal(markdownExport.format, 'markdown');
    assert.match(markdownExport.content, /# Fixture history/);
    assert.match(markdownExport.content, /ORCHID-28/);
    const jsonExport = await call('exportSession', { ...context, format: 'json', title: 'Fixture history' });
    const exportedDocument = JSON.parse(jsonExport.content);
    assert.equal(exportedDocument.sessionId, context.sessionId);
    assert.ok(exportedDocument.events.length >= contextSnapshot.asOfSeq);
    assert.ok(exportedDocument.events.some(event => event.type === 'request/prepared'));
    await assert.rejects(call('exportSession', { ...context, format: 'zip', title: 'Fixture history' }));
    const branchSessionId = randomUUID();
    const branchContext = { ...context, sessionId: branchSessionId };
    const fork = await call('forkSession', { ...context, branchSessionId, messageId: history[1].id });
    assert.equal(fork.branchSessionId, branchSessionId);
    assert.equal(fork.sourceSessionId, context.sessionId);
    assert.equal(fork.sourceMessageId, history[1].id);
    assert.ok(fork.events >= 2);
    assert.deepEqual((await call('history', branchContext)).map(message => [message.role, message.text]),
      [['user', history[0].text], ['assistant', history[1].text]]);
    assert.equal((await call('context', branchContext)).branch.sourceSessionId, context.sessionId);
    const originalSteps = steps;
    steps = [];
    const branchRun = randomUUID();
    await call('chat', { ...branchContext, ...model, runId: branchRun,
      permission: 'full', message: '继续分叉会话' });
    assert.ok((await waitEvent(branchRun, 'done')).data.status);
    const continuedBranch = await call('history', branchContext);
    assert.ok(continuedBranch.length > 2);
    assert.equal(continuedBranch.at(-1).role, 'assistant');
    steps = originalSteps;
    const pluginSource = path.resolve(__dirname, '..', 'fixtures', 'plugin-echo');
    const pluginDirectory = path.join(root, 'plugin-echo');
    await mkdir(pluginDirectory);
    await copyFile(path.join(pluginSource, 'plugin.cjs'), path.join(pluginDirectory, 'plugin.cjs'));
    const pluginManifest = JSON.parse(await readFile(path.join(pluginSource, 'jharness-plugin.json'), 'utf8'));
    pluginManifest.executable = process.execPath;
    pluginManifest.arguments = [path.join(pluginDirectory, 'plugin.cjs')];
    await writeFile(path.join(pluginDirectory, 'jharness-plugin.json'), JSON.stringify(pluginManifest));
    assert.deepEqual(await call('listExternalPlugins'), []);
    const installedPlugin = await call('installExternalPlugin', { directory: pluginDirectory });
    assert.equal(installedPlugin.id, 'fixture.echo');
    assert.equal(installedPlugin.enabled, false);
    assert.equal(installedPlugin.tools[0].name, 'plugin_echo');
    assert.equal((await call('setExternalPluginEnabled', {
      pluginId: 'fixture.echo', enabled: true
    })).enabled, true);
    const pluginSteps = steps;
    steps = [['plugin_echo', { text: 'PLUGIN-ECHO-42' }, 'PLUGIN-ECHO-42']];
    const pluginRun = randomUUID();
    const pluginContext = { ...context, sessionId: randomUUID() };
    const pluginRequestStart = requests.length;
    await call('chat', { ...pluginContext, ...model, runId: pluginRun,
      permission: 'full', message: '调用外部工具插件' });
    await waitEvent(pluginRun, 'done');
    assert.ok(requests[pluginRequestStart].body.tools.some(tool => tool.function.name === 'plugin_echo'));
    assert.match(JSON.stringify(requests.at(-1).body.messages.filter(message => message.role === 'tool')),
      /PLUGIN-ECHO-42/);
    assert.equal(await call('uninstallExternalPlugin', { pluginId: 'fixture.echo' }), true);
    assert.deepEqual(await call('listExternalPlugins'), []);
    steps = pluginSteps;
    const search = await call('searchSessions', { query: 'orchid-28', sessions: [{ ...context, title: 'Fixture' }] });
    assert.equal(search[0].messageId, history[1].id);
    assert.match(search[0].excerpt, /ORCHID-28/);
    const chineseSearch = await call('searchSessions', {
      query: '读并修改', sessions: [{ ...context, title: 'Fixture' }]
    });
    assert.equal(chineseSearch[0].messageId, history[0].id);
    const attachmentSearch = await call('searchSessions', {
      query: 'fixture.png', sessions: [{ ...context, title: 'Fixture' }]
    });
    assert.equal(attachmentSearch[0].messageId, history[0].id);
    const branchSearch = await call('searchSessions', {
      query: 'orchid-28',
      sessions: [{ ...context, title: 'Fixture' }, { ...branchContext, title: 'Fixture branch' }]
    });
    assert.ok(branchSearch.some(match => match.sessionId === branchSessionId));
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
    assert.equal((await approvalRecord(edit.data.id)).status, 'PENDING');
    assert.equal(await call('dismissApproval', { projectId: context.projectId, approvalId: edit.data.id }), false);
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

    const interrupted = randomUUID();
    steps = [['create_file', { path: 'Interrupted.txt', content: 'must not execute' }]];
    await call('chat', { ...context, sessionId: randomUUID(), ...model, runId: interrupted,
      permission: 'ask', message: '创建一个文件' });
    const interruptedApproval = await waitEvent(interrupted, 'approval');
    const interruptedExit = once(child, 'exit');
    child.kill();
    await interruptedExit;
    call = launch();
    const recoveredApprovals = await call('approvals', { projectId: context.projectId });
    const recovered = recoveredApprovals.find(item => item.id === interruptedApproval.data.id);
    assert.equal(recovered.status, 'INTERRUPTED');
    assert.equal(recovered.interruptedFrom, 'PENDING');
    assert.equal(recoveredApprovals.find(item => item.id === create.data.id).status, 'COMPLETED');
    assert.equal(await call('approve', { runId: interrupted,
      approvalId: interruptedApproval.data.id, allow: true }), false);
    assert.equal(await call('dismissApproval', {
      projectId: context.projectId, approvalId: interruptedApproval.data.id
    }), true);
    assert.equal((await call('approvals', { projectId: context.projectId }))
      .find(item => item.id === interruptedApproval.data.id).status, 'DISMISSED');
    await assert.rejects(readFile(path.join(projectPath, 'Interrupted.txt')), { code: 'ENOENT' });

    const terminal = randomUUID();
    const command = "[IO.File]::WriteAllText([IO.Path]::Combine((Get-Location).Path, 'command.txt'), 'approved'); Write-Output '完成'; exit 7";
    steps = [
      ['run_command', { command: "[IO.File]::WriteAllText([IO.Path]::Combine((Get-Location).Path, 'denied.txt'), 'unexpected')" }],
      ['run_command', { command }],
      ['acceptance_write', { criteria: ['命令以退出码 0 完成'] }],
    ];
    const commandContext = { ...context, sessionId: randomUUID() };
    await call('chat', { ...commandContext, ...model, runId: terminal,
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
    assert.equal(path.normalize(commandApproval.data.path), await realpath(projectPath));
    await assert.rejects(readFile(path.join(projectPath, 'denied.txt')), { code: 'ENOENT' });
    await assert.rejects(readFile(path.join(projectPath, 'command.txt')), { code: 'ENOENT' });
    await call('approve', { runId: terminal, approvalId: commandApproval.data.id, allow: true });
    await waitEvent(terminal, 'done');
    assert.equal(await readFile(path.join(projectPath, 'command.txt'), 'utf8'), 'approved');
    const commandReport = (await call('taskReport', commandContext))
      .find(item => item.runId === terminal);
    assert.equal(commandReport.commands.length, 1);
    assert.equal(commandReport.commands[0].exitCode, 7);
    assert.equal(commandReport.commands[0].outcome, 'FAILED');
    assert.match(commandReport.commands[0].output, /完成/);
    assert.equal(commandReport.acceptance.criteria.length, 1);
    assert.equal(commandReport.acceptance.criteria[0].status, 'PENDING');
    const verifiedCriterion = await call('verifyCriterion', {
      ...commandContext,
      runId: terminal,
      criterionId: commandReport.acceptance.criteria[0].id,
      commandId: commandReport.commands[0].id,
      expectedExitCode: 0
    });
    assert.equal(verifiedCriterion.status, 'FAILED');
    assert.match(verifiedCriterion.reason, /退出码/);
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

    const stalled = randomUUID();
    steps = [['web_fetch', { url: new URL('/in-flight-page', url).href }]];
    await call('chat', { ...context, sessionId: randomUUID(), ...model, runId: stalled,
      permission: 'full', message: '读取一个尚未返回的网页' });
    const stalledApproval = await waitEvent(stalled, 'approval');
    const requestReceived = once(server, 'in-flight-read', { signal: AbortSignal.timeout(10000) });
    const [allowed] = await Promise.all([
      call('approve', { runId: stalled, approvalId: stalledApproval.data.id, allow: true }),
      requestReceived
    ]);
    assert.equal(allowed, true);
    assert.equal((await approvalRecord(stalledApproval.data.id)).status, 'APPROVED');
    assert.equal(await call('dismissApproval', { projectId: context.projectId, approvalId: stalledApproval.data.id }), false);
    const stalledExit = once(child, 'exit');
    child.kill();
    await stalledExit;
    call = launch();
    const stalledRecord = await approvalRecord(stalledApproval.data.id);
    assert.equal(stalledRecord.status, 'INTERRUPTED');
    assert.equal(stalledRecord.interruptedFrom, 'APPROVED');
    assert.equal(await call('approve', { runId: stalled, approvalId: stalledApproval.data.id, allow: true }), false);
    assert.equal(stalledReads, 1);
    assert.equal((await approvalRecord(approval.data.id)).status, 'COMPLETED');

    const durable = { ...context, sessionId: randomUUID() };
    const durableRun = randomUUID();
    const durableMessage = '测试重启后继续同一个任务';
    const durablePath = path.join(projectPath, 'Durable.txt');
    await writeFile(durablePath, 'DURABLE-STEP');
    steps = [['edit_file', { path: 'Durable.txt', old_text: 'DURABLE-STEP', new_text: 'DURABLE-STEP approved' }]];
    await call('chat', { ...durable, ...model, runId: durableRun, permission: 'durable', message: durableMessage });
    assert.equal((await waitEvent(durableRun, 'done')).data.status, 'suspended');
    const suspendedTask = await call('task', durable);
    assert.equal(suspendedTask.status, 'suspended');
    assert.equal(suspendedTask.uncertain, false);
    assert.ok(suspendedTask.turnId);
    assert.equal(suspendedTask.approvals.length, 1);
    const [resumableApproval] = suspendedTask.approvals;
    assert.equal(resumableApproval.operation, 'edit_file');
    assert.equal(resumableApproval.path, 'Durable.txt');
    assert.equal(resumableApproval.before, 'DURABLE-STEP');
    assert.equal(resumableApproval.after, 'DURABLE-STEP approved');
    assert.equal(await readFile(durablePath, 'utf8'), 'DURABLE-STEP');
    const taskCenter = await call('tasks', { sessions: [{ ...durable, projectName: 'Fixture', title: 'Durable' }] });
    assert.equal(taskCenter.length, 1);
    assert.equal(taskCenter[0].projectId, durable.projectId);
    assert.equal(taskCenter[0].status, 'suspended');
    assert.equal(taskCenter[0].title, durableMessage);
    assert.equal(taskCenter[0].approvals.length, 1);

    const durableExit = once(child, 'exit');
    child.kill();
    await durableExit;
    call = launch();
    assert.deepEqual(await call('task', durable), suspendedTask);
    assert.equal((await call('tasks', {
      sessions: [{ ...durable, projectName: 'Fixture', title: 'Durable' }]
    }))[0].status, 'suspended');
    assert.equal(await readFile(durablePath, 'utf8'), 'DURABLE-STEP');
    const resumedRun = randomUUID();
    const resumeRequestStart = requests.length;
    await call('resumeTask', { ...durable, ...model, turnId: suspendedTask.turnId, runId: resumedRun,
      answers: { [resumableApproval.id]: true } });
    assert.equal((await waitEvent(resumedRun, 'done')).data.status, 'completed');
    assert.equal(await readFile(durablePath, 'utf8'), 'DURABLE-STEP approved');
    assert.deepEqual(await call('task', durable), {});
    assert.equal(requests.length, resumeRequestStart + 1);
    const durableCheckpoint = (await call('checkpoints', durable))
      .find(item => item.path === 'Durable.txt');
    assert.equal(durableCheckpoint.beforeExists, true);
    assert.equal(durableCheckpoint.afterExists, true);
    const durableCheckpointDetail = await call('checkpoint', {
      ...durable, checkpointId: durableCheckpoint.id
    });
    assert.equal(durableCheckpointDetail.before.text, 'DURABLE-STEP');
    assert.equal(durableCheckpointDetail.after.text, 'DURABLE-STEP approved');
    const resumedMessages = requests[resumeRequestStart].body.messages;
    assert.equal(resumedMessages.filter(message => message.role === 'user'
      && !String(message.content).includes('<HARNESS_CONTEXT>')).length, 1);
    assert.match(JSON.stringify(resumedMessages.filter(message => message.role === 'tool')), /已编辑 Durable\.txt/);
    assert.deepEqual((await call('history', durable)).map(message => [message.role, message.turn, message.text]),
      [['user', 1, durableMessage], ['assistant', 1, '**ORCHID-28**']]);

    const durableCommandContext = { ...context, sessionId: randomUUID() };
    const durableCommandSteps = steps;
    steps = [
      ['run_command', { command: 'Write-Output \'{"check":"DURABLE-COMMAND-9","passed":true}\'' }],
      ['acceptance_write', { criteria: ['检查结果的 passed 字段为 true'] }],
    ];
    const durableCommandRun = randomUUID();
    await call('chat', { ...durableCommandContext, ...model, runId: durableCommandRun,
      permission: 'durable', message: '在可续跑任务中运行命令' });
    assert.equal((await waitEvent(durableCommandRun, 'done')).data.status, 'suspended');
    const durableCommandTask = await call('task', durableCommandContext);
    assert.equal(durableCommandTask.approvals.length, 1);
    assert.equal(durableCommandTask.approvals[0].operation, 'run_command');
    assert.match(durableCommandTask.approvals[0].after, /DURABLE-COMMAND-9/);
    const durableCommandResume = randomUUID();
    await call('resumeTask', { ...durableCommandContext, ...model,
      turnId: durableCommandTask.turnId, runId: durableCommandResume,
      answers: { [durableCommandTask.approvals[0].id]: true } });
    assert.equal((await waitEvent(durableCommandResume, 'done')).data.status, 'completed');
    const durableCommandReport = (await call('taskReport', durableCommandContext))
      .find(item => item.runId === durableCommandResume);
    assert.equal(durableCommandReport.commands.length, 1);
    assert.equal(durableCommandReport.commands[0].exitCode, 0);
    assert.match(durableCommandReport.commands[0].output, /DURABLE-COMMAND-9/);
    const jsonSchema = '{"type":"object","required":["passed"],"properties":{"passed":{"const":true}}}';
    const jsonVerified = await call('verifyJsonCriterion', {
      ...durableCommandContext, runId: durableCommandResume, jsonSchema,
      criterionId: durableCommandReport.acceptance.criteria[0].id, commandId: durableCommandReport.commands[0].id,
    });
    assert.equal(jsonVerified.status, 'PASSED');
    const refreshed = (await call('taskReport', durableCommandContext)).find(item => item.runId === durableCommandResume);
    assert.deepEqual(refreshed.acceptance.criteria[0], jsonVerified);
    steps = durableCommandSteps;

    const cancelContext = { ...context, sessionId: randomUUID() };
    const cancelRun = randomUUID();
    steps = [['create_file', { path: 'DurableCancelled.txt', content: 'must not execute' }]];
    await call('chat', { ...cancelContext, ...model, runId: cancelRun, permission: 'durable', message: '测试取消待审批任务' });
    assert.equal((await waitEvent(cancelRun, 'done')).data.status, 'suspended');
    const cancelTask = await call('task', cancelContext);
    assert.equal(cancelTask.approvals.length, 1);
    assert.equal(await call('cancelTask', { ...cancelContext, turnId: cancelTask.turnId }), true);
    assert.deepEqual(await call('task', cancelContext), {});
    await assert.rejects(readFile(path.join(projectPath, 'DurableCancelled.txt')), { code: 'ENOENT' });

    const queueContext = { ...context, sessionId: randomUUID() };
    const queuePath = path.join(projectPath, 'Queued.txt');
    await writeFile(queuePath, 'QUEUE-STEP');
    steps = [['edit_file', { path: 'Queued.txt', old_text: 'QUEUE-STEP', new_text: 'QUEUE-STEP approved' }]];
    const queueFirstRun = randomUUID();
    await call('chat', { ...queueContext, ...model, runId: queueFirstRun,
      permission: 'durable', message: '先完成待审批任务' });
    assert.equal((await waitEvent(queueFirstRun, 'done')).data.status, 'suspended');
    const queueFirstTask = await call('task', queueContext);
    const queueRun = randomUUID();
    await call('chat', { ...queueContext, ...model, runId: queueRun,
      permission: 'durable', message: '排队处理后续任务' });
    const queuedTasks = await call('tasks', {
      sessions: [{ ...queueContext, projectName: 'Fixture', title: 'Queued' }]
    });
    assert.deepEqual(queuedTasks.map(item => item.status).sort(), ['queued', 'suspended']);
    assert.equal((await call('task', queueContext)).turnId, queueFirstTask.turnId);
    await call('resumeTask', { ...queueContext, ...model, turnId: queueFirstTask.turnId,
      runId: randomUUID(), answers: { [queueFirstTask.approvals[0].id]: true } });
    assert.equal((await waitEvent(queueRun, 'done')).data.status, 'completed');
    assert.equal(await readFile(queuePath, 'utf8'), 'QUEUE-STEP approved');
    assert.deepEqual(await call('tasks', {
      sessions: [{ ...queueContext, projectName: 'Fixture', title: 'Queued' }]
    }), []);

    const steerContext = { ...context, sessionId: randomUUID() };
    steps = [['read_file', { path: 'README.md' }, 'ORCHID-28']];
    const steerRun = randomUUID();
    const steerRequestStart = requests.length;
    holdForSteer = true;
    const modelHeld = once(server, 'model-held', { signal: AbortSignal.timeout(10000) });
    await call('chat', { ...steerContext, ...model, runId: steerRun,
      permission: 'durable', message: '读取 README 并继续' });
    await modelHeld;
    assert.equal(await call('steer', { runId: steerRun, message: 'STEER-TOKEN-77' }), true);
    releaseHeldModel();
    assert.equal((await waitEvent(steerRun, 'done')).data.status, 'completed');
    assert.ok(requests.slice(steerRequestStart).some(request =>
      JSON.stringify(request.body.messages).includes('STEER-TOKEN-77')));

    const checkpointContext = { ...context, sessionId: randomUUID() };
    const checkpointPath = path.join(projectPath, 'Checkpoint.txt');
    await writeFile(checkpointPath, 'CHECKPOINT-BEFORE');
    const checkpointOriginalSteps = steps;
    steps = [['edit_file', {
      path: 'Checkpoint.txt', old_text: 'CHECKPOINT-BEFORE', new_text: 'CHECKPOINT-AFTER'
    }]];
    const checkpointRun = randomUUID();
    await call('chat', { ...checkpointContext, ...model, runId: checkpointRun,
      permission: 'full', message: '修改检查点文件' });
    await waitEvent(checkpointRun, 'done');
    const checkpointSummary = (await call('checkpoints', checkpointContext))
      .find(item => item.path === 'Checkpoint.txt');
    const checkpoint = await call('checkpoint', {
      ...checkpointContext, checkpointId: checkpointSummary.id
    });
    assert.equal(checkpoint.status, 'SUCCESS');
    assert.equal(checkpoint.before.text, 'CHECKPOINT-BEFORE');
    assert.equal(checkpoint.after.text, 'CHECKPOINT-AFTER');
    await writeFile(checkpointPath, 'USER-LATER-EDIT');
    await assert.rejects(call('restoreCheckpoint', {
      ...checkpointContext, checkpointId: checkpoint.id
    }), /避免覆盖后续编辑/);
    await writeFile(checkpointPath, 'CHECKPOINT-AFTER');
    assert.equal((await call('restoreCheckpoint', {
      ...checkpointContext, checkpointId: checkpoint.id
    })).status, 'RESTORED');
    assert.equal(await readFile(checkpointPath, 'utf8'), 'CHECKPOINT-BEFORE');
    steps = checkpointOriginalSteps;

    const changeSetContext = { ...context, sessionId: randomUUID() };
    const changeSetOriginalSteps = steps;
    const changeA = path.join(projectPath, 'ChangeA.txt');
    const changeB = path.join(projectPath, 'ChangeB.txt');
    const changeC = path.join(projectPath, 'ChangeC.txt');
    await writeFile(changeA, 'CHANGE-A-BEFORE');
    await writeFile(changeB, 'CHANGE-B-BEFORE');
    steps = [
      ['edit_file', {
        path: 'ChangeA.txt', old_text: 'CHANGE-A-BEFORE', new_text: 'CHANGE-A-AFTER'
      }],
      ['edit_file', {
        path: 'ChangeB.txt', old_text: 'CHANGE-B-BEFORE', new_text: 'CHANGE-B-AFTER'
      }],
      ['create_file', { path: 'ChangeC.txt', content: 'CHANGE-C-CREATED' }]
    ];
    const changeSetRun = randomUUID();
    await call('chat', { ...changeSetContext, ...model, runId: changeSetRun,
      permission: 'full', message: '修改多个文件并验证整组恢复' });
    await waitEvent(changeSetRun, 'done');
    const changePreview = await call('previewChangeSet', {
      ...changeSetContext, runId: changeSetRun
    });
    assert.equal(changePreview.files.length, 3);
    assert.equal(changePreview.canRestore, true);
    assert.deepEqual(changePreview.files.map(item => item.path).sort(),
      ['ChangeA.txt', 'ChangeB.txt', 'ChangeC.txt']);
    await writeFile(changeB, 'CHANGE-B-USER');
    const conflictedPreview = await call('previewChangeSet', {
      ...changeSetContext, runId: changeSetRun
    });
    assert.equal(conflictedPreview.canRestore, false);
    assert.deepEqual(conflictedPreview.conflicts, ['ChangeB.txt']);
    await assert.rejects(call('restoreChangeSet', {
      ...changeSetContext, runId: changeSetRun
    }), /整组恢复已取消/);
    assert.equal(await readFile(changeA, 'utf8'), 'CHANGE-A-AFTER');
    assert.equal(await readFile(changeC, 'utf8'), 'CHANGE-C-CREATED');
    await writeFile(changeB, 'CHANGE-B-AFTER');
    const changeSet = await call('restoreChangeSet', {
      ...changeSetContext, runId: changeSetRun
    });
    assert.equal(changeSet.status, 'RESTORED');
    assert.equal(await readFile(changeA, 'utf8'), 'CHANGE-A-BEFORE');
    assert.equal(await readFile(changeB, 'utf8'), 'CHANGE-B-BEFORE');
    await assert.rejects(readFile(changeC, 'utf8'), { code: 'ENOENT' });
    assert.equal((await call('changeSets', {
      ...changeSetContext, runId: changeSetRun
    }))[0].status, 'RESTORED');
    steps = changeSetOriginalSteps;

    const reportContext = { ...context, sessionId: randomUUID() };
    const reportRun = randomUUID();
    const reportOriginalSteps = steps;
    steps = [
      ['todo_write', { todos: [
        { content: '创建交付物', status: 'completed', priority: 'high' },
        { content: '验证命令结果', status: 'in_progress', priority: 'medium' }
      ] }, '1 open todo(s):'],
      ['create_file', { path: 'Report.md', content: '# REPORT-EVIDENCE' }, '已创建 Report.md'],
      ['deliver_artifact', {
        filePath: 'Report.md', fileName: 'report.md', description: 'Evidence report'
      }, 'Delivered Report.md']
    ];
    await call('chat', { ...reportContext, ...model, runId: reportRun,
      permission: 'full', message: '生成并验证任务交付物' });
    await waitEvent(reportRun, 'done');
    const report = (await call('taskReport', reportContext))
      .find(item => item.runId === reportRun);
    assert.equal(report.plan.revision, 1);
    assert.deepEqual(report.plan.steps.map(step => [step.content, step.status]), [
      ['创建交付物', 'completed'], ['验证命令结果', 'in_progress']
    ]);
    assert.equal(report.commands.length, 0);
    assert.equal(report.artifacts.length, 1);
    assert.equal(report.artifacts[0].fileName, 'report.md');
    assert.equal(report.artifacts[0].description, 'Evidence report');
    assert.ok(report.checkpoints.some(item => item.path === 'Report.md'));
    const artifact = await call('taskArtifact', {
      ...reportContext, artifactId: report.artifacts[0].id
    });
    assert.equal(await readFile(artifact.filePath, 'utf8'), '# REPORT-EVIDENCE');
    steps = reportOriginalSteps;

    const malformed = randomUUID();
    steps = [['create_file', {}, '', '{"path":"Malformed.txt","content":']];
    await call('chat', { ...context, sessionId: randomUUID(), ...model, runId: malformed,
      permission: 'full', message: '测试损坏的工具参数' });
    await waitEvent(malformed, 'done');
    assert.equal((await waitEvent(malformed, 'tool-end')).data.status, 'ERROR');
    assert.match((await waitEvent(malformed, 'tool-output')).data.delta, /valid JSON object/);
    assert.match((await waitEvent(malformed, 'result')).data.text, /ORCHID-28/);
    await assert.rejects(readFile(path.join(projectPath, 'Malformed.txt')), { code: 'ENOENT' });

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

const { before, test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const { once } = require('node:events');
const { createServer } = require('node:http');
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

let searchForm;
before(async () => {
  const { build } = await import('vite');
  const [bundle] = await build({ configFile: false, logLevel: 'error', define: { 'process.env.NODE_ENV': '"production"' },
    build: { write: false, lib: { entry: path.resolve(__dirname,'../fixtures/browser-host/search-form.jsx'),
      name: 'SearchForm', formats: ['iife'] } } });
  searchForm = bundle.output[0].code;
});

for (const scenario of ['ask', 'durable', 'crash', 'cli']) test('browser workflow with ' + scenario,
  { timeout: scenario === 'crash' ? 165000 : 90000 }, async t => {
    const cli = scenario === 'cli';
    const installed = ['ProgramFiles(x86)', 'ProgramFiles', 'LOCALAPPDATA'].some(key =>
      process.env[key] && ['Microsoft/Edge/Application/msedge.exe','Google/Chrome/Application/chrome.exe']
        .some(file => require('node:fs').existsSync(path.join(process.env[key],file))));
    if (cli && !installed) return t.skip('CLI fallback requires an installed Edge or Chrome');
    const permission = scenario === 'crash' ? 'durable' : scenario;
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'jharness-browser-'));
    const projectId = randomUUID(), sessionId = randomUUID(), runId = randomUUID();
    const requests = [], approvals = [], steps = [];
    const server = createServer(async (req, res) => {
      if (req.url === '/fixture') {
        res.writeHead(200, { 'content-type': 'text/html;charset=utf-8' });
        return res.end('<title>Form fixture</title><main></main><script src="/search-form.js"></script>'
          + '<script>console.error("fixture-console")</script>'
          + '<iframe src="http://127.0.0.3:' + server.address().port + '/embed"></iframe>');
      }
      if (req.url === '/search-form.js') {
        res.writeHead(200, { 'content-type': 'application/javascript' });
        return res.end(searchForm);
      }
      if (req.url === '/results?q=Orchid+verification') {
        // Hold the outgoing document, then keep the result document in "loading" while parsing.
        await new Promise(resolve => setTimeout(resolve, 200));
        res.writeHead(200, { 'content-type': 'text/html;charset=utf-8' });
        res.write('<title>Loading</title><body>');
        await new Promise(resolve => setTimeout(resolve, 200));
        return res.end('<script>setTimeout(() => {document.title="Submitted";document.body.textContent="Orchid verification result"},60)</script>');
      }
      if (req.method !== 'POST') { res.writeHead(404); return res.end(); }
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      requests.push(body);
      const names = body.tools?.map(tool => tool.function.name) || [];
      const results = body.messages.filter(m => m.role === 'tool');
      const child = names.includes('browser_snapshot');
      const plan = child ? [
        ['browser_snapshot', {}], ['browser_fill', { ref: 1, value: 'Orchid verification' }],
        scenario === 'durable' || cli ? ['browser_press_key', { key: 'Enter', ref: 1 }] : ['browser_click', { ref: 2 }],
        ['browser_snapshot', {}], ['browser_screenshot', {}],
        ['browser_request_user_takeover', { reason: '请核对结果' }],
        ['browser_navigate', { url: 'https://denied.invalid/test' }],
        ['browser_navigate', { url: 'https://denied.invalid/retry' }]
      ] : [['browser_task', { task: 'Submit the fixture form and verify it', start_url: origin + '/fixture' }]];
      const step = plan[results.length];
      const delta = step && names.length ? { role: 'assistant', tool_calls: [{ index: 0, type: 'function',
        id: (child ? 'child' : 'main') + results.length, function: { name: step[0], arguments: JSON.stringify(step[1]) } }] }
        : { role: 'assistant', content: child ? 'Finished fixture' : 'Main finished' };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: ' + JSON.stringify({ id: randomUUID(), model: 'fixture', object: 'chat.completion.chunk',
        choices: [{ index: 0, delta, finish_reason: delta.tool_calls ? 'tool_calls' : 'stop' }] }) + '\n\ndata: [DONE]\n\n');
    });
    // A second loopback address exercises the external-origin gate without a public network request.
    const address = cli ? '127.0.0.1' : '127.0.0.2';
    await new Promise((resolve, reject) => server.once('error',reject).listen(0,address,resolve));
    const origin = 'http://' + address + ':' + server.address().port;
    if (cli) {
      const data = path.join(temp,'data');
      const child = spawn(process.execPath, ['apps/cli/jharness-cli.cjs','run','Verify local form','--json','--project',temp], {
        windowsHide: true, env: { ...process.env, JHARNESS_PROVIDER:'compatible', JHARNESS_MODEL:'fixture',
          JHARNESS_API_KEY:'fixture', JHARNESS_BASE_URL:origin + '/v1', JHARNESS_DATA_DIR:data,
          JHARNESS_BROWSER_WS_URL:'', JHARNESS_BROWSER_PORT:'' }
      });
      let errors = '';
      child.stderr.on('data', b => { errors += b; });
      child.stdout.resume();
      try {
        assert.equal((await once(child,'exit',{signal:t.signal}))[0], 0, errors);
        const main = requests.findLast(r => r.tools?.some(t => t.function.name === 'browser_task'));
        const output = main.messages.findLast(m => m.role === 'tool').content;
        assert.match(output, /需要人工介入/, output);
        const facts = JSON.parse(output.split('[BROWSER_HOST_FACTS]').at(-1));
        assert.equal(facts.finalTitle,'Submitted');
        assert.equal(facts.screenshotArtifacts.length,1);
        const profiles = path.join(data,'workspaces','browser-profiles');
        const [project] = await fs.readdir(profiles);
        const marker = await fs.readFile(path.join(profiles,project,'DevToolsActivePort'),'utf8');
        await assert.rejects(fetch('http://127.0.0.1:' + marker.split(/\s/)[0] + '/json/version'));
      } finally {
        child.kill(); server.closeAllConnections(); server.close();
        await fs.rm(temp,{recursive:true,force:true,maxRetries:10,retryDelay:150});
      }
      return;
    }
    const host = spawn(require('electron'), ['tests/fixtures/browser-host/main.cjs', path.join(temp, 'electron')], { windowsHide: true });
    const launch = () => spawn('runtime/bin/java.exe', ['-jar','apps/backend/target/jharness-backend.jar',path.join(temp,'data')], { windowsHide: true });
    let java = launch();
    let stderr = '';
    for (const child of [java, host]) child.stderr.on('data', data => { stderr = (stderr + data).slice(-6000); });
    const exits = [java, host].map(child => once(child, 'exit'));
    t.after(async () => {
      java.stdin.end(); await fs.writeFile(path.join(temp, 'electron', 'stop-host'), '');
      const kill = setTimeout(() => { java.kill(); host.kill(); }, 3000);
      await Promise.all(exits); clearTimeout(kill);
      server.closeAllConnections(); server.close();
      await fs.rm(temp, { recursive:true, force:true, maxRetries:8, retryDelay:150 });
    });
    const pending = new Map();
    function call(method, params) {
      const id = randomUUID();
      return new Promise((resolve, reject) => {
        pending.set(id, response => response.error ? reject(Error(response.error)) : resolve(response.result));
        java.stdin.write(JSON.stringify({ id, method, params }) + '\n');
      });
    }
    function watch() {
      const lines = createInterface({ input: java.stdout });
      return new Promise((resolve,reject) => {
      lines.on('line', line => {
        const m = JSON.parse(line);
        if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
        if (m.event === 'browser') steps.push(m.data);
        if (m.event === 'error') reject(Error(m.data.message));
        if (m.event === 'approval') {
          approvals.push(m.data);
          if (scenario === 'crash' && m.data.operation === 'browser_takeover') {
            java.kill();
            resolve();
            return;
          }
          (async () => {
            if (permission === 'durable') {
              const live = await call('task', { projectId,sessionId });
              assert.equal(live.liveRunId,runId);
              assert.equal(live.approvals[0].operation,m.data.operation);
            }
            await call('approve', { runId: m.runId, approvalId:m.data.id, allow: m.data.path !== 'https://denied.invalid' });
          })().catch(reject);
        }
        if (m.event === 'done') resolve();
      });
      });
    }
    const done = watch();
    const hostLines = createInterface({ input:host.stdout });
    const endpoint = await new Promise((resolve,reject) => {
      host.once('exit', () => reject(Error(stderr)));
      hostLines.on('line', line => { if (line.startsWith('{"url":')) resolve(JSON.parse(line).url); });
    });
    await call('configureBrowserBridge', { projectId, url:endpoint });
    await call('chat', { projectId, sessionId, projectPath:temp, runId, permission, provider:'compatible',
      model:'fixture', key:'fixture', baseUrl:origin + '/v1', message:'Verify form in browser' });
    await done;
    if (scenario === 'crash') {
      await exits[0];
      java = launch();
      java.stderr.on('data', () => {});
      exits.push(once(java, 'exit'));
      const resumed = watch();
      const ctx = { projectId, sessionId, projectPath:temp };
      // The old writer's durable lease can remain valid for two minutes after a crash.
      let task;
      const deadline = Date.now() + 135000;
      do {
        task = await call('task',ctx);
        if (task.status === 'interrupted') break;
        await new Promise(resolve => setTimeout(resolve,1000));
      } while (Date.now() < deadline);
      assert.equal(task.uncertain, true);
      assert.equal(task.uncertainCalls.length, 1);
      assert.equal(task.uncertainCalls[0].name, 'browser_task');
      await call('reconcileTask', { ...ctx, runId:randomUUID(), turnId:task.turnId,
        provider:'compatible', model:'fixture', key:'fixture', baseUrl:origin + '/v1',
        outcomes:{ [task.uncertainCalls[0].id]: 'error' } });
      await resumed;
      assert.ok(!(await call('task',ctx)).uncertain);
      return;
    }
    const main = requests.filter(r => r.tools?.some(tool => tool.function.name === 'browser_task'));
    const output = main.at(-1)?.messages.findLast(m => m.role === 'tool')?.content;
    assert.equal(typeof output, 'string', JSON.stringify(main.at(-1)?.messages).slice(-1000));
    assert.ok(output.includes('[BROWSER_HOST_FACTS]'), output + stderr);
    const facts = JSON.parse(output.split('[BROWSER_HOST_FACTS]').at(-1));
    assert.deepEqual(facts.visitedOrigins, [origin]);
    assert.ok(facts.blockedOrigins.includes('http://127.0.0.3:' + server.address().port));
    assert.deepEqual(facts.declinedOrigins, ['https://denied.invalid']);
    assert.equal(facts.finalTitle, 'Submitted', JSON.stringify(requests.filter(r => r.tools?.some(t => t.function.name === 'browser_snapshot'))
      .at(-1)?.messages.filter(m => m.role === 'tool')).slice(0,8000));
    assert.ok(facts.consoleErrors.some(line => line.includes('fixture-console')));
    assert.ok(steps.some(step => step.takeover));
    assert.deepEqual(approvals.map(a => a.operation), ['browser_origin','browser_takeover','browser_origin']);
    assert.ok(requests.some(r => r.messages.some(m => JSON.stringify(m.content).includes('Orchid verification') && m.role === 'tool')));
    const firstResult = requests.find(r => r.tools?.some(t => t.function.name === 'browser_snapshot')
      && r.messages.filter(m => m.role === 'tool').length === 4);
    assert.match(firstResult.messages.findLast(m => m.role === 'tool').content, /Orchid verification result/);
    assert.equal(facts.screenshotArtifacts.length, 2, JSON.stringify({output, tools: requests
      .filter(r => r.tools?.some(t => t.function.name === 'browser_snapshot')).at(-1).messages
      .filter(m => m.role === 'tool').map(m => m.content.slice(0,150)) }));
    assert.ok(requests.some(r => JSON.stringify(r.messages).includes('data:image/png;base64,')));
    assert.ok(main.every(r => !JSON.stringify(r.messages).includes('data:image/png;base64,')));
    const reports = await call('taskReport', { projectId, sessionId, projectPath:temp });
    const artifacts = reports.find(report => report.runId === runId).artifacts;
    assert.equal(facts.screenshotArtifacts.length, 2);
    for (const entry of facts.screenshotArtifacts) {
      assert.ok(artifacts.some(a => a.id === entry.artifactId));
      const stored = await call('taskArtifact', { projectId, sessionId, artifactId: entry.artifactId });
      const png = await fs.readFile(stored.filePath);
      assert.equal(png.readUInt32BE(0), 0x89504e47);
      assert.equal(createHash('sha256').update(png).digest('hex'), entry.sha256);
    }
  });

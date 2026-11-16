const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { createServer } = require('node:http');
const { createInterface } = require('node:readline');
const path = require('node:path');

test('browser plugin talks to a Chrome DevTools HTTP endpoint', { timeout: 15000 }, async () => {
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/json/version') {
      response.end(JSON.stringify({ Browser: 'Mock/1.0' }));
    } else if (request.url === '/json/list') {
      response.end(JSON.stringify([{
        id: 'page-1', type: 'page', title: 'Fixture', url: 'https://example.com/',
        webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/page/page-1'
      }]));
    } else if (request.url.startsWith('/json/new?')) {
      response.end(JSON.stringify({
        id: 'page-2', type: 'page', title: '', url: decodeURIComponent(request.url.slice(10)),
        webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/page/page-2'
      }));
    } else {
      response.statusCode = 404;
      response.end('{}');
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const child = spawn(process.execPath, [path.resolve(__dirname, '..', '..', 'examples', 'plugins', 'browser-cdp', 'plugin.cjs')], {
    env: { ...process.env, JHARNESS_BROWSER_PORT: String(server.address().port) },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  });
  const lines = createInterface({ input: child.stdout });
  const responses = [];
  lines.on('line', line => responses.push(JSON.parse(line)));
  function call(id, tool, input = {}) {
    child.stdin.write(JSON.stringify({
      id, method: 'tool_call', params: { tool, input }
    }) + '\n');
  }
  async function wait(id) {
    for (let i = 0; i < 100; i++) {
      const value = responses.find(item => item.id === id);
      if (value) return value.result;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('Browser plugin response timeout');
  }
  try {
    call('status', 'browser_status');
    assert.deepEqual(await wait('status'), { available: true, port: server.address().port, Browser: 'Mock/1.0' });
    call('tabs', 'browser_tabs');
    assert.equal((await wait('tabs')).tabs[0].title, 'Fixture');
    call('open', 'browser_open', { url: 'https://example.org/path' });
    assert.equal((await wait('open')).url, 'https://example.org/path');
  } finally {
    child.stdin.write(JSON.stringify({ id: 'shutdown', method: 'shutdown' }) + '\n');
    if (child.exitCode === null) {
      const exited = once(child, 'exit');
      const timer = setTimeout(() => child.kill(), 2000);
      await exited;
      clearTimeout(timer);
    }
    server.closeAllConnections();
    server.close();
  }
});

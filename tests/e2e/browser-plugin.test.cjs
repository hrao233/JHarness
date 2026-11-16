const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { createServer } = require('node:http');
const { createHash } = require('node:crypto');
const { readFile } = require('node:fs/promises');
const { createInterface } = require('node:readline');
const path = require('node:path');

function websocketFrame(value) {
  const payload = Buffer.from(JSON.stringify(value));
  if (payload.length < 126) {
    return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  }
  const header = Buffer.alloc(4);
  header[0] = 0x81;
  header[1] = 126;
  header.writeUInt16BE(payload.length, 2);
  return Buffer.concat([header, payload]);
}

function websocketMessages(onMessage) {
  return socket => {
    let buffered = Buffer.alloc(0);
    socket.on('data', chunk => {
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= 2) {
        const opcode = buffered[0] & 0x0f;
        let length = buffered[1] & 0x7f;
        let offset = 2;
        if (length === 126) {
          if (buffered.length < 4) return;
          length = buffered.readUInt16BE(2);
          offset = 4;
        } else if (length === 127) {
          if (buffered.length < 10) return;
          length = Number(buffered.readBigUInt64BE(2));
          offset = 10;
        }
        const masked = (buffered[1] & 0x80) !== 0;
        const maskBytes = masked ? 4 : 0;
        if (buffered.length < offset + maskBytes + length) return;
        let payload = buffered.subarray(offset + maskBytes, offset + maskBytes + length);
        if (masked) {
          const mask = buffered.subarray(offset, offset + 4);
          payload = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]));
        }
        buffered = buffered.subarray(offset + maskBytes + length);
        if (opcode === 0x8) {
          socket.end();
          return;
        }
        if (opcode === 0x1) onMessage(payload.toString('utf8'), socket);
      }
    });
  };
}

test('browser plugin talks to a Chrome DevTools HTTP endpoint', { timeout: 15000 }, async () => {
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/json/version') {
      response.end(JSON.stringify({ Browser: 'Mock/1.0' }));
    } else if (request.url === '/json/list') {
      response.end(JSON.stringify([{
        id: 'page-1', type: 'page', title: 'Fixture', url: 'https://example.com/',
        webSocketDebuggerUrl: `ws://127.0.0.1:${server.address().port}/devtools/page/page-1`
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
  server.on('upgrade', (request, socket) => {
    const key = request.headers['sec-websocket-key'];
    const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\n'
      + 'Upgrade: websocket\r\nConnection: Upgrade\r\n'
      + 'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n');
    websocketMessages((raw, client) => {
      const message = JSON.parse(raw);
      let value;
      if (message.method === 'Runtime.evaluate') {
        const expression = message.params.expression;
        if (expression.includes('element.click()')) value = { found: true, tag: 'button', text: 'Fixture' };
        else if (expression.includes('dispatchEvent')) value = { found: true, tag: 'input', length: 5 };
        else if (expression.includes('Boolean(document.querySelector')) value = true;
      }
      client.write(websocketFrame({ id: message.id, result: { result: { value } } }));
    })(socket);
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
    call('click', 'browser_click', { selector: '#submit' });
    assert.equal((await wait('click')).found, true);
    call('fill', 'browser_fill', { selector: 'input[name=q]', value: 'hello' });
    assert.equal((await wait('fill')).length, 5);
    call('wait', 'browser_wait_for', { selector: '#result', timeoutMs: 500 });
    assert.equal((await wait('wait')).found, true);
    call('reload', 'browser_reload');
    assert.equal((await wait('reload')).reloaded, true);
    call('back', 'browser_back');
    assert.equal((await wait('back')).direction, 'back');
    call('forward', 'browser_forward');
    assert.equal((await wait('forward')).direction, 'forward');
    const manifest = JSON.parse(await readFile(path.resolve(__dirname, '..', '..',
      'examples', 'plugins', 'browser-cdp', 'jharness-plugin.json'), 'utf8'));
    assert.ok(manifest.tools.some(tool => tool.name === 'browser_click'));
    assert.ok(manifest.tools.some(tool => tool.name === 'browser_wait_for'));
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

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { spawn, execFileSync } = require('node:child_process');
const { createServer } = require('node:http');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const WebSocket = require('ws');

async function until(read, message) {
  const end = Date.now() + 8000;
  do {
    const value = await read();
    if (value) return value;
    await delay(80);
  } while (Date.now() < end);
  throw Error(message);
}

async function connect(url) {
  const ws = new WebSocket(url);
  await once(ws, 'open');
  let sequence = 0;
  const pending = new Map();
  ws.on('message', data => {
    const { id, result, error } = JSON.parse(data);
    const request = pending.get(id);
    if (request) {
      pending.delete(id);
      if (error) request.reject(Error(error.message));
      else request.resolve(result);
    }
  });
  function send(method, params = {}) {
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async function evaluate(expression) {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }
  return { send, evaluate, close: () => ws.close() };
}

// Move or send key to the actual Win32 window.
function win32Window(pid, title, action) {
  const script = `
    $ProgressPreference = 'SilentlyContinue'
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class WindowTest {
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string cls, string title);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr hwnd,int x,int y,int width,int height,bool repaint);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hwnd, uint cmd);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam);
}
'@
    $handle = [IntPtr]::Zero
    do {
      $handle = [WindowTest]::FindWindowEx([IntPtr]::Zero,$handle,'Chrome_WidgetWin_1',$env:JH_TEST_TITLE)
      if ($handle -eq [IntPtr]::Zero) { throw 'Fixture window not found' }
      [uint32]$owner = 0
      $null = [WindowTest]::GetWindowThreadProcessId($handle,[ref]$owner)
    } until ($owner -eq ${pid})
    ${action}
  `;
  execFileSync('powershell.exe', ['-NoProfile', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { windowsHide: true, env: { ...process.env, JH_TEST_TITLE: title } });
}

function moveWindow(pid, title, x, y, width, height) {
  win32Window(pid, title, `if (![WindowTest]::MoveWindow($handle,${x},${y},${width},${height},$true)) { throw 'MoveWindow failed' }`);
}

function sendEscapeKey(pid, title) {
  win32Window(pid, title, `
    $child = [WindowTest]::GetWindow($handle, 5)
    $target = if ($child -ne [IntPtr]::Zero) { $child } else { $handle }
    $null = [WindowTest]::PostMessage($target, 0x0100, [IntPtr]0x1B, [IntPtr]0x00010001)
    $null = [WindowTest]::PostMessage($target, 0x0101, [IntPtr]0x1B, [IntPtr]0xC0010001)
  `);
}

test('live narrow panel, bare host omnibox, movable window with toolbar, fullscreen and return preserve webpage', async () => {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'jharness-window-'));
  const project = randomUUID();
  const server = createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end('<!doctype html><title>Fixture Page</title><body style="height:3200px"><footer style="padding-top:3100px">End <input id="draft"></footer>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const bareAddress = '127.0.0.1:' + server.address().port;
  const url = 'http://' + bareAddress + '/';
  await fs.writeFile(path.join(profile, 'settings.json'), JSON.stringify({ models: [], projects: [
    { id: project, name: 'Window fixture', directory: profile, sessions: [{ id: randomUUID(), title: 'Test' }] }] }));
  const release = process.env.JHARNESS_RELEASE_DIR || path.resolve(__dirname, '../../release/win-unpacked');
  const dev = process.env.JHARNESS_TEST_DEV === '1';
  const child = spawn(dev ? require('electron') : path.join(release, 'JHarness.exe'),
    [...(dev ? ['.'] : []), '--user-data-dir=' + profile, '--remote-debugging-port=0'], { windowsHide: true, stdio: 'ignore' });
  const exited = once(child, 'exit');
  let app, page, shell;
  try {
    const marker = path.join(profile, 'DevToolsActivePort');
    const port = await until(async () => (await fs.readFile(marker, 'utf8').catch(() => '')).split(/\s/)[0], 'debug port');
    const targets = () => fetch('http://127.0.0.1:' + port + '/json/list').then(r => r.json());
    const find = check => until(async () => (await targets()).find(check), 'missing target');
    const host = await find(t => t.url.includes('/dist/index.html'));
    app = await connect(host.webSocketDebuggerUrl);
    await until(() => app.evaluate("!!document.querySelector('.project-name')"), 'project missing');
    moveWindow(child.pid, await app.evaluate('document.title'), 60, 50, 940, 680);
    await until(() => app.evaluate('innerWidth < 1140'), 'window did not narrow');
    await app.evaluate("document.querySelector('.project-name').click()");
    await app.evaluate("document.querySelector('button[aria-label=内置浏览器]').click()");
    const state = () => app.evaluate('window.jharness.browserState(' + JSON.stringify(project) + ').then(({visible,detached,fullscreen,url}) => ({visible,detached,fullscreen,url}))');
    await until(async () => (await state()).visible, 'narrow window shows a still preview instead of a live webpage');
    // Submit bare address without http:// or https:// in the omnibox form.
    await app.evaluate(`(() => {
      const input = document.querySelector('dialog.nav-browser input[aria-label="网页地址"]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(bareAddress)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.closest('form').requestSubmit();
    })()`);
    const target = await find(t => t.url === url);
    page = await connect(target.webSocketDebuggerUrl);
    await until(() => page.evaluate("document.readyState === 'complete' && !!document.querySelector('#draft')"), 'page load');
    const bounds = () => app.evaluate("document.querySelector('.browser-viewport').getBoundingClientRect().toJSON()");
    const fillsDock = async () => {
      const rect = await bounds();
      const [w, h] = await page.evaluate('[innerWidth,innerHeight]');
      return Math.abs(rect.width - w) < 2 && Math.abs(rect.height - h) < 2;
    };
    await until(fillsDock, 'initial live viewport does not match the narrow panel');
    await page.evaluate("scrollTo(0,document.body.scrollHeight); document.querySelector('#draft').focus(); document.querySelector('#draft').value='preserved'");
    assert.ok(await page.evaluate('scrollY > 0'));
    const click = label => app.evaluate('document.querySelector(' + JSON.stringify('button[aria-label="' + label + '"]') + ').click()');
    await click('独立窗口');
    await until(async () => (await state()).detached, 'window did not detach');
    const shellTarget = await find(t => t.url.includes('browser-shell.html'));
    shell = await connect(shellTarget.webSocketDebuggerUrl);
    await until(() => shell.evaluate("document.querySelector('#address')?.value === " + JSON.stringify(url)),
      'detached browser window toolbar did not sync current URL');
    await until(async () => (await page.evaluate('innerWidth')) > 900, 'detached window initial width');
    const initialDetachedWidth = await page.evaluate('innerWidth');
    assert.ok(await page.evaluate('scrollY > 0'), 'scroll after detach');
    moveWindow(child.pid, 'JHarness · 内置浏览器', 140, 95, 760, 520);
    try {
      await until(async () => (await page.evaluate('innerWidth')) < initialDetachedWidth, 'detached window did not narrow');
    } catch (e) {
      throw Error(e.message + ' ' + JSON.stringify({
        initialDetachedWidth,
        pageWidth: await page.evaluate('innerWidth'),
        shellWidth: await shell.evaluate('innerWidth')
      }));
    }
    const narrow = await page.evaluate('innerWidth');
    moveWindow(child.pid, 'JHarness · 内置浏览器', 70, 50, 1200, 780);
    await until(async () => (await page.evaluate('innerWidth')) > narrow, 'moving and resizing the detached window did not resize the page');
    await until(() => app.evaluate("!!document.querySelector('button[aria-label=返回面板]')"), 'panel did not reflect detached window');
    await shell.evaluate("document.querySelector('#fullscreen').click()");
    await until(async () => (await state()).fullscreen, 'window did not enter fullscreen');
    await until(() => page.evaluate('innerWidth >= screen.width - 2 && innerHeight >= screen.height - 2'), 'page does not fill the screen');
    assert.ok(await page.evaluate('scrollY > 0'), 'scroll after fullscreen');
    sendEscapeKey(child.pid, 'JHarness · 内置浏览器');
    await until(async () => !(await state()).fullscreen, 'Escape did not exit fullscreen');
    await shell.evaluate("document.querySelector('#dock').click()");
    await until(async () => { const s = await state(); return !s.detached && s.visible; }, 'redock failed');
    assert.equal(await page.evaluate("document.querySelector('#draft').value"), 'preserved');
    assert.ok(await page.evaluate('scrollY > 0'));
    try {
      await until(fillsDock, 'returned webpage does not fill the panel');
    } catch (e) {
      throw Error(e.message + ' ' + JSON.stringify({
        bounds: await bounds(),
        pageSize: await page.evaluate('[innerWidth,innerHeight]'),
        state: await state()
      }));
    }
  } finally {
    shell?.close();
    page?.close();
    if (app) await app.evaluate('setTimeout(() => window.close(),0)');
    app?.close();
    const timer = setTimeout(() => child.kill(), 2000);
    await exited; clearTimeout(timer);
    server.closeAllConnections(); server.close();
    await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

const { spawn } = require('node:child_process');
const { existsSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');

const port = Number(process.env.JHARNESS_BROWSER_PORT || 9222);
const endpoint = `http://127.0.0.1:${port}`;
const edgeCandidates = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe'
];
const chromeCandidates = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'
];

async function status() {
  try {
    const response = await fetch(`${endpoint}/json/version`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return { available: true, port, ...(await response.json()) };
  } catch (error) {
    return { available: false, port, error: error.message };
  }
}

async function ensureBrowser() {
  const current = await status();
  if (current.available) return current;
  const executable = [...edgeCandidates, ...chromeCandidates].find(existsSync);
  if (!executable) throw new Error('Edge or Chrome was not found');
  const profile = path.join(os.tmpdir(), 'jharness-browser-profile');
  const child = spawn(executable, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank'
  ], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  for (let i = 0; i < 50; i++) {
    await new Promise(resolve => setTimeout(resolve, 200));
    const next = await status();
    if (next.available) return next;
  }
  throw new Error('Browser debugging endpoint did not start');
}

async function tabs() {
  await ensureBrowser();
  const response = await fetch(`${endpoint}/json/list`);
  const values = await response.json();
  return values.filter(item => item.type === 'page').map(item => ({
    id: item.id, title: item.title, url: item.url
  }));
}

async function openTab(url) {
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Only HTTP(S) URLs are supported');
  await ensureBrowser();
  const response = await fetch(`${endpoint}/json/new?${encodeURIComponent(parsed.href)}`, { method: 'PUT' });
  if (!response.ok) throw new Error(`Open tab failed: HTTP ${response.status}`);
  const target = await response.json();
  return { id: target.id, title: target.title, url: target.url || parsed.href };
}

async function evaluate(target, expression) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error('DevTools evaluation timed out'));
    }, 15000);
    socket.addEventListener('open', () => socket.send(JSON.stringify({
      id: 1,
      method: 'Runtime.evaluate',
      params: { expression, returnByValue: true, awaitPromise: true }
    })));
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.id !== 1) return;
      clearTimeout(timer);
      socket.close();
      if (message.error) reject(new Error(message.error.message));
      else if (message.result?.exceptionDetails) reject(new Error(message.result.exceptionDetails.text));
      else resolve(message.result?.result?.value);
    });
    socket.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('DevTools WebSocket failed'));
    });
  });
}

async function pageTarget(urlContains = '') {
  await ensureBrowser();
  const response = await fetch(`${endpoint}/json/list`);
  const values = (await response.json()).filter(item => item.type === 'page');
  return values.find(item => !urlContains || item.url.includes(urlContains)) || values[0];
}

async function extract({ urlContains = '', maxChars = 12000 } = {}) {
  const target = await pageTarget(urlContains);
  if (!target) throw new Error('No browser page target');
  const text = await evaluate(target,
    'document.body ? document.body.innerText : ""');
  return {
    url: target.url,
    title: target.title,
    text: String(text || '').slice(0, Math.max(0, Math.min(Number(maxChars) || 12000, 50000)))
  };
}

async function search({ query, maxResults = 8 } = {}) {
  if (!query || !String(query).trim()) throw new Error('query is required');
  const limit = Math.max(1, Math.min(Number(maxResults) || 8, 20));
  const url = 'https://www.bing.com/search?q=' + encodeURIComponent(String(query).trim());
  const tab = await openTab(url);
  const target = await pageTarget('bing.com');
  await new Promise(resolve => setTimeout(resolve, 800));
  const results = await evaluate(target, `(() => {
    const values = [];
    for (const item of document.querySelectorAll('li.b_algo')) {
      const link = item.querySelector('h2 a');
      if (!link) continue;
      values.push({
        title: link.innerText,
        url: link.href,
        snippet: (item.querySelector('.b_caption p')?.innerText || '').slice(0, 500)
      });
      if (values.length >= ${limit}) break;
    }
    return values;
  })()`);
  return { query: String(query).trim(), url, results: results || [] };
}

async function invoke(tool, input = {}) {
  if (tool === 'browser_status') return status();
  if (tool === 'browser_tabs') return { tabs: await tabs() };
  if (tool === 'browser_open') return openTab(input.url);
  if (tool === 'browser_extract') return extract(input);
  if (tool === 'browser_search') return search(input);
  throw new Error(`Unknown tool: ${tool}`);
}

const input = readline.createInterface({ input: process.stdin, terminal: false });
input.on('line', async line => {
  const request = JSON.parse(line);
  if (request.method === 'shutdown') process.exit(0);
  try {
    const result = await invoke(request.params?.tool, request.params?.input);
    process.stdout.write(JSON.stringify({ id: request.id, result }) + '\n');
  } catch (error) {
    process.stdout.write(JSON.stringify({ id: request.id, error: error.message }) + '\n');
  }
});

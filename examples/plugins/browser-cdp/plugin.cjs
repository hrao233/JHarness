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

async function cdp(target, method, params = {}, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    if (!target?.webSocketDebuggerUrl) {
      reject(new Error('No DevTools WebSocket target'));
      return;
    }
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error('DevTools command timed out'));
    }, timeoutMs);
    socket.addEventListener('open', () => socket.send(JSON.stringify({
      id: 1,
      method,
      params
    })));
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.id !== 1) return;
      clearTimeout(timer);
      socket.close();
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    });
    socket.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('DevTools WebSocket failed'));
    });
  });
}

async function evaluate(target, expression, timeoutMs = 15000) {
  const result = await cdp(target, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true
  }, timeoutMs);
  if (result?.exceptionDetails) {
    const detail = result.exceptionDetails.exception?.description
      || result.exceptionDetails.text || 'Evaluation failed';
    throw new Error(String(detail).slice(0, 1000));
  }
  return result?.result?.value;
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

function selector(value) {
  const result = String(value || '').trim();
  if (!result || result.length > 1000) throw new Error('selector is required');
  return result;
}

async function click({ urlContains = '', selector: targetSelector } = {}) {
  const target = await pageTarget(urlContains);
  if (!target) throw new Error('No browser page target');
  const css = selector(targetSelector);
  const value = await evaluate(target, `(() => {
    const element = document.querySelector(${JSON.stringify(css)});
    if (!element) return { found: false };
    element.scrollIntoView({ block: "center", inline: "center" });
    element.click();
    return {
      found: true,
      tag: element.tagName.toLowerCase(),
      text: String(element.innerText || element.value || "").slice(0, 500)
    };
  })()`);
  if (!value?.found) throw new Error('Element not found: ' + css);
  return { ...value, selector: css, url: target.url };
}

async function fill({ urlContains = '', selector: targetSelector, value = '' } = {}) {
  const target = await pageTarget(urlContains);
  if (!target) throw new Error('No browser page target');
  const css = selector(targetSelector);
  const text = String(value);
  if (text.length > 10000) throw new Error('value is too large');
  const result = await evaluate(target, `(() => {
    const element = document.querySelector(${JSON.stringify(css)});
    if (!element) return { found: false };
    const value = ${JSON.stringify(text)};
    if (element.isContentEditable) element.textContent = value;
    else element.value = value;
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return { found: true, tag: element.tagName.toLowerCase(), length: value.length };
  })()`);
  if (!result?.found) throw new Error('Element not found: ' + css);
  return { ...result, selector: css, url: target.url };
}

async function waitFor({ urlContains = '', selector: targetSelector, timeoutMs = 5000 } = {}) {
  const target = await pageTarget(urlContains);
  if (!target) throw new Error('No browser page target');
  const css = selector(targetSelector);
  const budget = Math.max(100, Math.min(Number(timeoutMs) || 5000, 30000));
  const deadline = Date.now() + budget;
  while (Date.now() < deadline) {
    const found = await evaluate(target, `Boolean(document.querySelector(${JSON.stringify(css)}))`);
    if (found) return { found: true, selector: css, url: target.url };
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  return { found: false, selector: css, url: target.url, timedOut: true };
}

async function reload({ urlContains = '' } = {}) {
  const target = await pageTarget(urlContains);
  if (!target) throw new Error('No browser page target');
  await cdp(target, 'Page.reload', { ignoreCache: true });
  return { reloaded: true, url: target.url };
}

async function history(direction, { urlContains = '' } = {}) {
  if (!['back', 'forward'].includes(direction)) throw new Error('Invalid history direction');
  const target = await pageTarget(urlContains);
  if (!target) throw new Error('No browser page target');
  await evaluate(target, `history.${direction}()`);
  return { direction, url: target.url };
}

async function invoke(tool, input = {}) {
  if (tool === 'browser_status') return status();
  if (tool === 'browser_tabs') return { tabs: await tabs() };
  if (tool === 'browser_open') return openTab(input.url);
  if (tool === 'browser_extract') return extract(input);
  if (tool === 'browser_search') return search(input);
  if (tool === 'browser_click') return click(input);
  if (tool === 'browser_fill') return fill(input);
  if (tool === 'browser_wait_for') return waitFor(input);
  if (tool === 'browser_reload') return reload(input);
  if (tool === 'browser_back') return history('back', input);
  if (tool === 'browser_forward') return history('forward', input);
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

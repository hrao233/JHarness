const { BrowserWindow, Menu, WebContentsView, clipboard } = require('electron');
const { randomBytes } = require('node:crypto');
const { createServer } = require('node:http');
const path = require('node:path');
const { WebSocketServer, WebSocket } = require('ws');

const TOOLBAR_HEIGHT = 48;

const commands = new Set([
  'Page.enable', 'Page.stopLoading', 'Page.getFrameTree', 'Page.createIsolatedWorld', 'Page.navigate',
  'Page.getNavigationHistory', 'Page.navigateToHistoryEntry', 'Page.reload', 'Page.captureScreenshot',
  'Network.enable', 'Runtime.enable', 'Runtime.evaluate', 'Fetch.enable', 'Fetch.disable',
  'Fetch.continueRequest', 'Fetch.failRequest', 'Input.dispatchKeyEvent'
]);
const events = new Set(['Page.frameNavigated', 'Page.frameStartedLoading', 'Page.frameStoppedLoading',
  'Page.navigatedWithinDocument', 'Runtime.consoleAPICalled', 'Runtime.exceptionThrown',
  'Network.loadingFailed', 'Network.responseReceived', 'Fetch.requestPaused']);

function web(url) {
  try { return ['http:', 'https:'].includes(new URL(url).protocol); } catch { return false; }
}

function createBrowserPanes(window, register, notify) {
  const panes = new Map();
  function pane(id) {
    if (!panes.has(id)) panes.set(id, { id, visible: false, active: false, takeover: false, preview: '' });
    return panes.get(id);
  }
  async function capture(p) {
    if (!p.view || p.capturing || p.view.webContents.isDestroyed()) return;
    p.capturing = true;
    try {
      const image = await p.view.webContents.capturePage(undefined, { stayHidden: true });
      if (!image.isEmpty()) p.preview = image.resize({ width: Math.min(900, image.getSize().width) }).toDataURL();
    } catch { /* Window closed during capture. */ }
    finally { p.capturing = false; }
  }
  function handleShortcuts(p, event, input) {
    if ((input.type !== 'keyDown' && input.type !== 'rawKeyDown') || input.isAutoRepeat) return false;
    if (p.detached && p.parking && !p.parking.isDestroyed() && input.key === 'Escape' && p.parking.isFullScreen()) {
      event.preventDefault();
      p.parking.setFullScreen(false);
      fitWindow(p);
      return true;
    }
    if (p.active && !p.takeover) return false;
    if (input.key === 'F11') {
      event.preventDefault();
      if (p.detached) {
        p.parking.setFullScreen(!p.parking.isFullScreen());
        fitWindow(p);
      } else {
        presentPane(p, 'fullscreen');
      }
      return true;
    }
    const wc = p.view?.webContents;
    if (!wc || wc.isDestroyed()) return false;
    if (input.key === 'F5' || ((input.control || input.meta) && !input.alt && input.key.toLowerCase() === 'r')) {
      event.preventDefault();
      wc.reload();
      return true;
    }
    if (input.alt && !input.control && !input.meta && input.key === 'ArrowLeft' && wc.navigationHistory.canGoBack()) {
      event.preventDefault();
      wc.navigationHistory.goBack();
      return true;
    }
    if (input.alt && !input.control && !input.meta && input.key === 'ArrowRight' && wc.navigationHistory.canGoForward()) {
      event.preventDefault();
      wc.navigationHistory.goForward();
      return true;
    }
    return false;
  }
  function view(p) {
    if (p.view) return p.view;
    const v = new WebContentsView({ webPreferences: { partition: 'persist:jharness-browser-' + p.id,
      contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false, navigateOnDragDrop: false } });
    // Hosts the live page offscreen when hidden and serves as a full movable browser window with toolbar when detached.
    p.parking = new BrowserWindow({
      title: 'JHarness · 内置浏览器', show: false, width: 1020, height: 740,
      minWidth: 360, minHeight: 240, useContentSize: true, autoHideMenuBar: true, backgroundColor: '#f6f7fa',
      webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true }
    });
    p.parking.setMenu(null);
    p.parking.on('page-title-updated', event => event.preventDefault());
    p.parking.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    p.parking.webContents.on('will-navigate', event => event.preventDefault());
    p.parking.webContents.on('before-input-event', (event, input) => { handleShortcuts(p, event, input); });
    p.parking.on('resize', () => fitWindow(p));
    p.parking.on('enter-full-screen', () => { fitWindow(p); p.view?.webContents.focus(); });
    p.parking.on('leave-full-screen', () => fitWindow(p));
    p.parking.on('close', event => {
      if (p.detached) {
        event.preventDefault();
        redock(p, false);
      }
    });
    p.visible = !!p.dockBounds;
    const host = p.visible ? window() : p.parking;
    host.contentView.addChildView(v);
    v.setBounds(p.dockBounds || { x: 0, y: 0, width: 960, height: 720 });
    p.view = v;
    const wc = v.webContents;
    wc.on('before-input-event', (event, input) => {
      if (handleShortcuts(p, event, input)) return;
      if (p.active && !p.takeover) event.preventDefault();
    });
    wc.on('before-mouse-event', event => { if (p.active && !p.takeover) event.preventDefault(); });
    wc.on('context-menu', (_event, params) => {
      if (p.active && !p.takeover) return;
      const items = [
        { label: '后退', enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() },
        { label: '前进', enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() },
        { label: '重新加载', click: () => wc.reload() },
        { type: 'separator' }
      ];
      if (params.isEditable) {
        items.push(
          { label: '剪切', role: 'cut', enabled: params.editFlags.canCut },
          { label: '复制', role: 'copy', enabled: params.editFlags.canCopy },
          { label: '粘贴', role: 'paste', enabled: params.editFlags.canPaste },
          { label: '全选', role: 'selectAll', enabled: params.editFlags.canSelectAll },
          { type: 'separator' }
        );
      } else if (params.selectionText) {
        items.push({ label: '复制', role: 'copy' }, { type: 'separator' });
      }
      if (params.linkURL && web(params.linkURL)) {
        items.push({ label: '复制链接地址', click: () => clipboard.writeText(params.linkURL) });
      }
      const currentUrl = wc.getURL();
      if (web(currentUrl)) {
        items.push({ label: '复制当前网页地址', click: () => clipboard.writeText(currentUrl) });
      }
      Menu.buildFromTemplate(items).popup({ window: p.detached ? p.parking : window() });
    });
    wc.session.setPermissionRequestHandler((_wc, _permission, respond) => respond(false));
    wc.session.setPermissionCheckHandler(() => false);
    wc.session.on('will-download', event => event.preventDefault());
    wc.setWindowOpenHandler(({ url }) => {
      if (web(url)) void wc.loadURL(url).catch(() => {});
      return { action: 'deny' };
    });
    for (const name of ['will-frame-navigate', 'will-redirect'])
      wc.on(name, (event, details) => {
        const url = event.url || details?.url || details;
        if (!web(url)) event.preventDefault();
      });
    wc.on('did-finish-load', () => { if (!p.visible && !p.detached) void capture(p); });
    void wc.loadURL('about:blank').catch(() => {});
    return v;
  }
  async function bridge(p) {
    const token = '/cdp/' + randomBytes(32).toString('hex');
    const server = createServer((_req, res) => { res.writeHead(404); res.end(); });
    const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024, perMessageDeflate: false });
    p.server = server;
    let used = false;
    server.on('upgrade', (req, socket, head) => {
      if (used || req.url !== token || req.headers.origin) return socket.destroy();
      used = true;
      wss.handleUpgrade(req, socket, head, async ws => {
        p.socket = ws;
        const debug = view(p).webContents.debugger;
        try { debug.attach('1.3'); } catch { ws.close(1011); return; }
        const send = frame => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame)); };
        const forward = (_event, method, params, sessionId) => {
          if (!sessionId && events.has(method)) send({ method, params });
        };
        debug.on('message', forward);
        ws.on('error', () => ws.terminate());
        ws.on('message', async buffer => {
          let id;
          try {
            const message = JSON.parse(buffer);
            id = message.id;
            if (!Number.isSafeInteger(id) || !commands.has(message.method)) throw Error('Unsupported page command');
            const params = message.params || {};
            const wc = p.view.webContents;
            const backgroundCapture = !p.visible && !p.detached && message.method === 'Page.captureScreenshot';
            if (backgroundCapture) wc.beginFrameSubscription(false, () => {});
            let result;
            try {
              const response = debug.sendCommand(message.method, params);
              if (backgroundCapture) wc.invalidate();
              result = await response;
            } finally { if (backgroundCapture) wc.endFrameSubscription(); }
            if (message.method === 'Page.captureScreenshot' && result.data)
              p.preview = 'data:image/png;base64,' + result.data;
            send({ id, result });
          } catch (e) { send({ id, error: { message: e.message } }); }
        });
        ws.once('close', () => {
          p.active = false;
          p.takeover = false;
          debug.off('message', forward);
          if (!p.view.webContents.isDestroyed() && debug.isAttached()) debug.detach();
          server.close();
          p.ready = null;
        });
      });
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    try { await register(p.id, 'ws://127.0.0.1:' + server.address().port + token); }
    catch (e) { server.close(); throw e; }
  }
  function ensure(id) {
    const p = pane(id);
    p.ready ??= bridge(p).catch(e => { p.ready = null; throw e; });
    return p.ready;
  }
  function hide(p) {
    if (p.visible) {
      window()?.contentView.removeChildView(p.view);
      p.parking.contentView.addChildView(p.view);
      p.view.setBounds({ x: 0, y: 0, width: 960, height: 720 });
      p.visible = false;
      void capture(p);
    }
  }
  function fitWindow(p) {
    if (!p.detached || !p.parking || p.parking.isDestroyed()) return;
    const [width, height] = p.parking.getContentSize();
    const top = p.parking.isFullScreen() ? 0 : Math.round(TOOLBAR_HEIGHT * p.parking.webContents.getZoomFactor());
    p.view.setBounds({ x: 0, y: top, width, height: Math.max(1, height - top) });
  }
  function dock(p) {
    if (!p.dockBounds) { hide(p); return; }
    for (const other of panes.values()) if (other !== p) hide(other);
    const v = view(p);
    if (!p.visible) {
      p.parking.contentView.removeChildView(v);
      window().contentView.addChildView(v);
    }
    v.setBounds(p.dockBounds);
    v.setVisible(true);
    p.visible = true;
  }
  function redock(p, focusPanel = true) {
    if (!p.detached) return;
    p.detached = false;
    const main = window();
    if (focusPanel && main && !main.isDestroyed()) {
      if (main.isMinimized()) main.restore();
      main.show();
      main.focus();
    }
    if (p.dockBounds) {
      dock(p);
    } else if (p.view) {
      p.view.setBounds({ x: 0, y: 0, width: 960, height: 720 });
    }
    if (p.parking && !p.parking.isDestroyed()) {
      if (p.parking.isFullScreen()) p.parking.setFullScreen(false);
      p.parking.hide();
    }
    if (p.visible && p.dockBounds) {
      p.view.setBounds(p.dockBounds);
      p.view.webContents.focus();
    }
    if (main && !main.isDestroyed() && notify) {
      notify({ event: 'browser-state-changed', data: { projectId: p.id } });
      if (focusPanel && !p.dockBounds) notify({ event: 'browser-dock-request', data: { projectId: p.id } });
    }
  }
  function presentPane(p, mode) {
    if (mode === 'dock') { redock(p, true); return; }
    if (mode !== 'window' && mode !== 'fullscreen') throw Error('无效的浏览器显示方式');
    const v = view(p);
    if (!p.shellLoaded) {
      p.shellLoaded = true;
      void p.parking.loadFile(path.join(__dirname, 'browser-shell.html'), { query: { project: p.id } }).catch(() => {});
    }
    if (!p.detached) {
      if (p.visible) {
        window()?.contentView.removeChildView(v);
        p.parking.contentView.addChildView(v);
      }
      p.visible = false;
      p.detached = true;
    }
    if (p.parking.isMinimized()) p.parking.restore();
    p.parking.show();
    p.parking.setFullScreen(mode === 'fullscreen');
    fitWindow(p);
    p.parking.focus();
    if (mode === 'fullscreen') v.webContents.focus();
  }
  return {
    ensure,
    ownsSender(sender, projectId) {
      const p = panes.get(projectId);
      return !!p?.parking && !p.parking.isDestroyed() && p.parking.webContents === sender;
    },
    present(id, mode) {
      presentPane(pane(id), mode);
    },
    layout(id, bounds) {
      const p = pane(id);
      if (!bounds.visible) { p.dockBounds = null; hide(p); return; }
      const rect = {};
      const zoom = window().webContents.getZoomFactor();
      for (const key of ['x', 'y', 'width', 'height']) {
        if (!Number.isFinite(bounds[key])) throw Error('无效的浏览器面板位置');
        rect[key] = Math.max(0, Math.round(bounds[key] * zoom));
      }
      p.dockBounds = rect.width >= 2 && rect.height >= 2 ? rect : null;
      if (!p.detached) dock(p);
    },
    event(message) {
      const p = panes.get(message.data?.projectId);
      if (!p || message.event !== 'browser') return;
      p.active = message.data.phase !== 'done';
      p.takeover = !!message.data.takeover;
      if (message.data.phase === 'artifact' || message.data.phase === 'done') void capture(p);
    },
    async state(id) {
      const p = pane(id);
      const wc = p.view?.webContents;
      const alive = wc && !wc.isDestroyed();
      return {
        visible: p.visible || !!p.detached,
        detached: !!p.detached,
        fullscreen: !!p.detached && !!p.parking && !p.parking.isDestroyed() && p.parking.isFullScreen(),
        loading: !!(alive && wc.isLoading()),
        url: (alive && wc.getURL()) || 'about:blank',
        title: (alive && wc.getTitle()) || '',
        preview: p.preview,
        canGoBack: !!(alive && wc.navigationHistory.canGoBack()),
        canGoForward: !!(alive && wc.navigationHistory.canGoForward())
      };
    },
    close() {
      for (const p of panes.values()) {
        p.detached = false;
        p.socket?.terminate();
        p.server?.close();
        if (p.view && !p.view.webContents.isDestroyed()) p.view.webContents.close();
        if (p.parking && !p.parking.isDestroyed()) p.parking.close();
      }
      panes.clear();
    }
  };
}
module.exports = { createBrowserPanes };

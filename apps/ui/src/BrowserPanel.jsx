import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, RotateCw, CornerDownLeft, ExternalLink, Maximize, Minimize, PanelRight } from 'lucide-react';

export function navigationAddress(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';
  // A host followed by a numeric port can also match the syntax of a URI scheme.
  if (/^[a-z][a-z\d+.-]*:/i.test(value) && !/^[^/:?#\s]+:\d{1,5}(?:[/?#]|$)/.test(value)) {
    if (/^https?:/i.test(value)) {
      try { return new URL(value.replace(/ /g, '%20')).href; } catch { return value; }
    }
    return value;
  }
  if (value.startsWith('//')) {
    try { return new URL('https:' + value).href; } catch { return 'https:' + value; }
  }
  if (/\s/.test(value)) return 'https://www.bing.com/search?q=' + encodeURIComponent(value);
  const slash = value.search(/[/?#]/);
  const authority = slash < 0 ? value : value.slice(0, slash);
  const suffix = slash < 0 ? '' : value.slice(slash);
  const local = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\]|0\.0\.0\.0|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|[^.:/?#]+\.(?:local|localhost|test))(?::\d{1,5})?$/i.test(authority);
  if (local) {
    const host = authority.replace(/^0\.0\.0\.0(?=:|$)/, '127.0.0.1');
    try { return new URL('http://' + host + suffix).href; } catch { return 'http://' + host + suffix; }
  }
  const ipv4 = /^\d{1,3}(?:\.\d{1,3}){3}(?::\d{1,5})?$/.test(authority);
  const ipv6 = /^\[[0-9a-f:]+\](?::\d{1,5})?$/i.test(authority);
  const hasPort = /^[^/:?#]+:\d{1,5}$/.test(authority);
  const hostOnly = authority.replace(/:\d{1,5}$/, '');
  const domain = !ipv4 && !ipv6 && /^[^\s/:?#.]+\.[^\s/:?#]+$/.test(hostOnly) && !/\.\d+$/.test(hostOnly);
  if (ipv4 || ipv6 || domain || hasPort) {
    const scheme = hasPort && !authority.endsWith(':443') ? 'http://' : 'https://';
    try { return new URL(scheme + value).href; } catch { return scheme + value; }
  }
  return 'https://www.bing.com/search?q=' + encodeURIComponent(value);
}

export function BrowserPanel({ api, project, docked, settingsOpen }) {
  const viewport = useRef(null);
  const editing = useRef(false);
  const pendingUrl = useRef({ url: '', until: 0 });
  const [state, setState] = useState({});
  const [address, setAddress] = useState('');
  const [error, setError] = useState('');
  const [live, setLive] = useState(false);
  const detachedRef = useRef(false);
  detachedRef.current = !!state.detached;

  useEffect(() => {
    const owner = viewport.current?.closest('dialog');
    if (docked && owner) {
      const saved = Number(localStorage.getItem('browserWidth'));
      if (saved >= 320) owner.style.setProperty('--browser-width', saved + 'px');
    }
  }, [docked]);

  useEffect(() => {
    let mounted = true, timer;
    async function poll() {
      try {
        const next = await api.browserState(project);
        if (mounted) {
          setState(next);
          if (pendingUrl.current.url && (Date.now() > pendingUrl.current.until
              || (next.url && next.url !== 'about:blank'))) {
            pendingUrl.current = { url: '', until: 0 };
          }
          if (!editing.current && !pendingUrl.current.url) {
            setAddress(next.url === 'about:blank' ? '' : next.url);
          }
        }
      } catch (e) { if (mounted) setError(e.message); }
      if (mounted) timer = setTimeout(poll, 700);
    }
    void poll();
    const off = api.onEvent?.(msg => {
      if ((msg.event === 'browser-state-changed' || msg.event === 'browser') && msg.data?.projectId === project) {
        void poll();
      }
    });
    return () => { mounted = false; clearTimeout(timer); off?.(); };
  }, [api, project]);

  useLayoutEffect(() => {
    const el = viewport.current;
    let previous;
    function sync() {
      const rect = el.getBoundingClientRect();
      const owner = el.closest('dialog');
      const covered = [...document.querySelectorAll('dialog:modal')].some(dialog => dialog !== owner);
      const visible = owner?.open && !settingsOpen && (!document.hidden || detachedRef.current) && !covered
        && rect.width > 1 && rect.height > 1;
      const bounds = { x: rect.left, y: rect.top, width: rect.width, height: rect.height, visible };
      const key = JSON.stringify(bounds);
      if (key === previous) return;
      previous = key;
      setLive(visible);
      api.browserLayout(project, bounds).catch(e => setError(e.message));
    }
    const resize = new ResizeObserver(sync);
    resize.observe(el);
    const dialogs = new MutationObserver(sync);
    dialogs.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['open'] });
    window.addEventListener('resize', sync);
    window.addEventListener('scroll', sync, true);
    document.addEventListener('visibilitychange', sync);
    sync();
    return () => {
      resize.disconnect(); dialogs.disconnect();
      window.removeEventListener('resize', sync); window.removeEventListener('scroll', sync, true);
      document.removeEventListener('visibilitychange', sync);
      void api.browserLayout(project, { visible: false }).catch(() => {});
    };
  }, [api, project, docked, settingsOpen]);

  async function present(mode) {
    setError('');
    try {
      await api.browserPresent(project, mode);
      setState(await api.browserState(project));
    } catch (e) { setError(e.message); }
  }

  function resizeDock(width) {
    const clamped = Math.max(320, Math.round(width));
    viewport.current.closest('dialog').style.setProperty('--browser-width', clamped + 'px');
    localStorage.setItem('browserWidth', String(clamped));
  }

  async function control(action) {
    setError('');
    try {
      let target = address;
      if (action === 'navigate') {
        target = navigationAddress(address);
        if (!target) return;
        pendingUrl.current = { url: target, until: Date.now() + 2500 };
        setAddress(target);
      }
      await api.browserControl(project, action, target);
      editing.current = false;
      setState(await api.browserState(project));
    } catch (e) {
      pendingUrl.current = { url: '', until: 0 };
      setError(e.message);
    }
  }

  const statusText = state.takeover ? '等待人工接管'
    : state.active ? '助手操作中'
    : state.loading ? '正在加载…'
    : state.title ? state.title : '空闲可自由浏览';

  return <section className="browser-panel">
    {docked && <div className="browser-grip" role="separator" aria-label="调整浏览器宽度" title="左右拖动调整浏览器宽度"
      aria-orientation="vertical" tabIndex={0}
      onPointerDown={e => { e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); }}
      onPointerMove={e => { if (e.currentTarget.hasPointerCapture(e.pointerId)) resizeDock(window.innerWidth - e.clientX); }}
      onPointerUp={e => { if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId); }}
      onKeyDown={e => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        e.preventDefault();
        resizeDock(e.currentTarget.closest('dialog').getBoundingClientRect().width + (e.key === 'ArrowLeft' ? 24 : -24));
      }}/>}
    <form className="browser-bar" onSubmit={e => { e.preventDefault(); void control('navigate'); }}>
      <button type="button" aria-label="后退" title="后退 (Alt+←)" disabled={!state.canGoBack || state.active}
        onClick={() => control('back')}><ArrowLeft size={16}/></button>
      <button type="button" aria-label="前进" title="前进 (Alt+→)" disabled={!state.canGoForward || state.active}
        onClick={() => control('forward')}><ArrowRight size={16}/></button>
      <button type="button" aria-label="刷新网页" title="刷新网页 (F5 / Ctrl+R)" disabled={state.active}
        onClick={() => control('reload')}><RotateCw size={16} className={state.loading ? 'spin' : ''}/></button>
      <input aria-label="网页地址" type="text" inputMode="url" autoComplete="off" spellCheck={false}
        placeholder="输入网址（如 baidu.com、localhost:3000）或搜索词"
        value={address} disabled={state.active}
        onFocus={e => { editing.current = true; e.currentTarget.select(); }}
        onBlur={() => { editing.current = false; }}
        onKeyDown={e => {
          if (e.key === 'Escape') {
            editing.current = false;
            setAddress(state.url === 'about:blank' ? '' : (state.url || ''));
            e.currentTarget.blur();
          }
        }}
        onChange={e => setAddress(e.target.value)}/>
      <button aria-label="打开网页" title="打开网址或搜索" disabled={state.active || !address.trim()}><CornerDownLeft size={16}/></button>
    </form>
    <div className="browser-status">
      <span className="browser-status-label" role="status" title={statusText}>{statusText}</span>
      {state.active && <button type="button" className="secondary browser-takeover-btn"
        onClick={() => control(state.takeover ? 'release' : 'takeover')}>
        {state.takeover ? '交还助手' : '人工接管'}</button>}
      <div className="browser-display">
        <button type="button" aria-label={state.detached ? '返回面板' : '独立窗口'}
          title={state.detached ? '将网页收回右侧面板' : '弹出为可自由拖动、调整大小的独立浏览器窗口'}
          onClick={() => present(state.detached ? 'dock' : 'window')}>
          {state.detached ? <PanelRight size={15}/> : <ExternalLink size={15}/>} {state.detached ? '返回面板' : '独立窗口'}</button>
        <button type="button" aria-label={state.fullscreen ? '退出全屏' : '全屏浏览'} title="全屏浏览（F11 / Esc 退出）"
          onClick={() => present(state.fullscreen ? 'window' : 'fullscreen')}>
          {state.fullscreen ? <Minimize size={15}/> : <Maximize size={15}/>} {state.fullscreen ? '退出全屏' : '全屏'}</button>
      </div>
    </div>
    <details><summary>控制台 {state.consoleErrorCount || 0} · 网络错误 {state.networkErrorCount || 0}</summary>
      <pre>{[...(state.consoleErrors || []), ...(state.networkErrors || [])].join('\n') || '尚未记录错误'}</pre></details>
    {error && <p role="alert" className="error-text">{error}</p>}
    <div className="browser-viewport" ref={viewport}>{state.detached
      ? <div className="browser-detached-card">
          <strong>网页已在可拖动的独立窗口打开</strong>
          {state.url && state.url !== 'about:blank' && <small>{state.title || state.url}</small>}
          <div className="browser-detached-actions">
            <button type="button" className="secondary" onClick={() => present('window')}><ExternalLink size={14}/>定位独立窗口</button>
            <button type="button" className="secondary" onClick={() => present('dock')}><PanelRight size={14}/>收回至面板</button>
          </div>
        </div>
      : !live && state.preview && <img src={state.preview} alt="最近的浏览器画面"/>}</div>
  </section>;
}

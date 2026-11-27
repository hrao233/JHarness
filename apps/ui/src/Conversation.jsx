import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowDown, Bookmark, Check, Copy, Ellipsis, FileText, GitBranch, Quote } from 'lucide-react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { FileActivity, groupFileActivity } from './FileActivity.jsx';

export function conversationLinkUrl(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';
  const candidate = value.startsWith('//') ? 'https:' + value : value;
  if (!/^https?:\/\//i.test(candidate)) return '';
  try {
    const parsed = new URL(candidate.replace(/ /g, '%20'));
    if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && !parsed.username && !parsed.password) {
      return parsed.href;
    }
  } catch {
    return '';
  }
  return '';
}

function renderUserText(text, openLink) {
  if (!openLink || !/https?:\/\//i.test(text)) return text;
  const pattern = /https?:\/\/[^\s<>"'`]+/gi;
  const nodes = [];
  let last = 0;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    let rawUrl = match[0];
    let trailing = '';
    while (rawUrl.length && /[.,;:!?，。；：！？）》】\]]$/.test(rawUrl)) {
      const ch = rawUrl.at(-1);
      if (ch === ')' && (rawUrl.match(/\(/g)?.length || 0) >= (rawUrl.match(/\)/g)?.length || 0)) break;
      if (ch === ']' && (rawUrl.match(/\[/g)?.length || 0) >= (rawUrl.match(/\]/g)?.length || 0)) break;
      trailing = ch + trailing;
      rawUrl = rawUrl.slice(0, -1);
    }
    const target = conversationLinkUrl(rawUrl);
    if (target) {
      nodes.push(<a key={match.index} className="chat-link" href={target}
        title={'在内置浏览器打开 ' + target}
        onClick={event => { event.preventDefault(); openLink(target); }}
        onAuxClick={event => { if (event.button === 1) { event.preventDefault(); openLink(target); } }}>{rawUrl}</a>);
    } else {
      nodes.push(rawUrl);
    }
    if (trailing) nodes.push(trailing);
    last = pattern.lastIndex;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

export function Conversation({ items, sessionId, children, status, copy, quote, saved, onSave, onFork,
    openLink, run, jump, scroll }) {
  const rail = useRef(null);
  const thread = useRef(null);
  const follow = useRef(true);
  const target = useRef(null);
  const [active, setActive] = useState(0);
  const [atBottom, setAtBottom] = useState(true);
  const [preview, setPreview] = useState(null);
  let turn = 0;
  const rows = items.map((item, index) => {
    if (item.turn !== undefined) turn = item.turn;
    else if (item.role === 'user') turn++;
    return { item, turn, index };
  });
  const prompts = rows.filter(({ item }) => item.role === 'user');

  function update() {
    const pane = scroll.current;
    if (!pane) return;
    const bottom = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 12;
    follow.current = bottom;
    setAtBottom(bottom);
    const markers = pane.querySelectorAll('[data-prompt]');
    let position = 0;
    if (target.current?.top === pane.scrollTop) position = target.current.turn;
    else if (bottom) position = markers.length;
    else {
      let low = 0;
      let high = markers.length;
      while (low < high) {
        const mid = (low + high) >>> 1;
        if (markers[mid].offsetTop <= pane.scrollTop + 44) low = mid + 1;
        else high = mid;
      }
      position = markers.length ? Math.max(low, 1) : 0;
    }
    if (target.current?.top !== pane.scrollTop) target.current = null;
    setActive(position);
  }

  function goBottom() {
    const pane = scroll.current;
    if (!pane) return;
    target.current = null;
    pane.scrollTop = pane.scrollHeight;
    update();
  }

  function goTo(turn, messageId) {
    const pane = scroll.current;
    if (!pane) return;
    const message = messageId ? pane.querySelector('[data-message-id="' + CSS.escape(messageId) + '"]') : null;
    const anchor = message || pane.querySelector('[data-prompt="' + Number(turn) + '"]');
    if (!anchor) return;
    pane.scrollTop = anchor.offsetTop - 20;
    target.current = { turn: Number(anchor.dataset.turn), top: pane.scrollTop };
    update();
  }

  useLayoutEffect(() => {
    if (follow.current) goBottom();
    else update();
  }, [items, status]);

  useLayoutEffect(() => {
    const pane = scroll.current;
    if (!pane) return;
    const observer = new ResizeObserver(() => {
      if (follow.current && !target.current) goBottom();
      else update();
    });
    observer.observe(pane);
    observer.observe(thread.current);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const list = rail.current;
    const mark = list?.querySelector('[aria-current="step"]');
    if (!mark) return;
    if (mark.offsetTop < list.scrollTop) list.scrollTop = mark.offsetTop;
    if (mark.offsetTop + mark.offsetHeight > list.scrollTop + list.clientHeight) {
      list.scrollTop = mark.offsetTop + mark.offsetHeight - list.clientHeight;
    }
  }, [active, prompts.length]);

  useEffect(() => {
    if (jump?.turn === 'latest') goBottom();
    else if (jump) goTo(jump.turn, jump.messageId);
  }, [jump]);

  return <div className="conversation">
    {!!prompts.length && <div className="timeline-wrap">
      <nav className="timeline" ref={rail} aria-label="对话时间线"
        onKeyDown={event => {
          const step = { ArrowDown: 1, ArrowUp: -1 }[event.key];
          if (!step) return;
          const buttons = Array.from(rail.current.querySelectorAll('button'));
          const next = buttons[buttons.indexOf(event.target) + step];
          if (!next) return;
          event.preventDefault();
          next.focus({ preventScroll: true });
          next.click();
        }}>
        {prompts.map(({ item, turn }) => <button type="button" className="timeline-mark" key={turn}
          aria-current={active === turn ? 'step' : undefined} aria-label={'跳转到用户消息 ' + turn}
          onMouseEnter={event => setPreview({ turn, y: event.currentTarget.getBoundingClientRect().top })}
          onMouseLeave={() => setPreview(null)}
          onFocus={event => setPreview({ turn, y: event.currentTarget.getBoundingClientRect().top })}
          onBlur={() => setPreview(null)}
          onClick={() => goTo(turn)}><span/></button>)}
      </nav>
      {preview && <div className="timeline-preview" aria-hidden="true" style={{ top: Math.min(preview.y, window.innerHeight - 118) }}>
        <b>第 {preview.turn} 轮</b><span>{prompts[preview.turn - 1]?.item.text.replace(/\s+/g, ' ').slice(0, 100)}</span>
      </div>}
    </div>}
    <div className="scroll" ref={scroll} onScroll={update}>
      <div className="thread" ref={thread}>
        {children}
        {groupFileActivity(rows).map(({ item, turn, index, calls }) => calls
          ? <FileActivity key={'activity:' + (item.id || index)} calls={calls} run={run}
              onInspect={() => { follow.current = false; }}/>
          : item.role === 'browser'
          ? <div className="browser-step" key={item.id}><strong>浏览器 · 第 {item.step} 步</strong>
            <span>{item.action}</span>{(() => {
              const target = conversationLinkUrl(item.url);
              return target && openLink
                ? <small><a className="chat-link" href={target} title={'在内置浏览器打开 ' + target}
                    onClick={event => { event.preventDefault(); openLink(target); }}>{item.url}</a></small>
                : <small>{item.url}</small>;
            })()}</div>
          : item.role === 'tool'
          ? <details className="tool" key={item.id || index}><summary><FileText size={15}/>{item.name}<small>{item.status}</small></summary>
            {item.args && <pre>{item.args}</pre>}{item.output && <pre>{item.output}</pre>}</details>
          : <Message key={sessionId + ':' + index} item={item} turn={turn}
            bookmark={saved.find(value => value.sessionId === sessionId && (value.messageId
              ? value.messageId === item.id : value.turn === turn && value.role === item.role && value.text === item.text))}
            copy={copy} quote={quote} onSave={onSave} onFork={onFork} openLink={openLink}
            canSave={!!item.id && !run}/>)}
        {status && <p className="muted" role="status">{status}</p>}
      </div>
    </div>
    {!!prompts.length && !atBottom && <button className="latest" title="跳到最新消息" aria-label="跳到最新消息"
      onClick={goBottom}><ArrowDown size={17}/></button>}
  </div>;
}

function Message({ item, turn, bookmark, copy, quote, onSave, onFork, openLink, canSave }) {
  const [copied, setCopied] = useState(false);
  const reset = useRef(null);
  const menu = useRef(null);
  const user = item.role === 'user';
  useEffect(() => () => clearTimeout(reset.current), []);

  async function copyMessage() {
    if (!await copy(item.text)) return;
    setCopied(true);
    clearTimeout(reset.current);
    reset.current = setTimeout(() => setCopied(false), 1600);
  }

  return <article className={'message ' + (user ? 'message-user' : 'message-assistant')}
    data-prompt={user ? turn : undefined} data-message-id={item.id} data-turn={turn}
    aria-label={user ? '用户消息 ' + turn : '助手回复'}>
    <div className={user ? 'user-msg' : 'assistant-msg'}>
      {user ? renderUserText(item.text, openLink) : <Markdown remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => {
            const target = conversationLinkUrl(href);
            if (!target || !openLink) return <span>{children}</span>;
            return <a className="chat-link" href={target} title={'在内置浏览器打开 ' + target}
              onClick={event => { event.preventDefault(); openLink(target); }}
              onAuxClick={event => { if (event.button === 1) { event.preventDefault(); openLink(target); } }}>{children}</a>;
          },
          img: () => null
        }}>{item.text}</Markdown>}
    </div>
    <div className="message-actions">
      <button type="button" aria-label={copied ? '已复制' : '复制消息'} title={copied ? '已复制' : '复制消息'}
        onClick={copyMessage}>{copied ? <Check size={15}/> : <Copy size={15}/>}</button>
      <button type="button" disabled={!quote} aria-label="引用到输入栏" title="引用到输入栏" onClick={() => quote(item.text)}><Quote size={15}/></button>
      {canSave && onFork && <button type="button" aria-label="从这里分叉会话" title="从这里分叉会话"
        onClick={() => onFork({ item, turn })}><GitBranch size={15}/></button>}
      {canSave && turn > 0 && <details ref={menu} className="message-menu" onBlur={event => {
        if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false;
      }} onKeyDown={event => {
        if (event.key === 'Escape') {
          event.currentTarget.open = false;
          event.currentTarget.querySelector('summary').focus();
        }
      }}>
        <summary aria-label="更多消息操作" title="更多消息操作"><Ellipsis size={17}/></summary>
        <div className="message-popover">
          <button type="button" onClick={() => { menu.current.open = false; void onSave({ item, turn, bookmark }); }}>
            <Bookmark size={15}/>{bookmark ? '移出资料库' : '收藏到资料库'}
          </button>
        </div>
      </details>}
    </div>
  </article>;
}

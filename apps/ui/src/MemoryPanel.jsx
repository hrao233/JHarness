import React, { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';

export function MemoryPanel({ project, busy, api, close, onAuto, errorText }) {
  const dialog = useRef(null);
  const [snapshot, setSnapshot] = useState(null);
  const [choice, setChoice] = useState('');
  const [draft, setDraft] = useState('');
  const [ledger, setLedger] = useState('');
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState('');
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState(false);

  async function execute(action) {
    setPending(true);
    setMessage('');
    setError(false);
    try { await action(); }
    catch (failure) { setError(true); setMessage(errorText(failure)); }
    finally { setPending(false); }
  }

  async function reload() {
    const result = await api.memory(project.id, 'list');
    setSnapshot(result);
    setDraft(result.summary);
    setChoice('');
  }

  useEffect(() => {
    dialog.current.showModal();
    void execute(reload);
  }, []);

  function select(value) {
    setChoice(value);
    setLedger('');
    if (value) void execute(async () => {
      const [group, name] = value.split(':');
      setLedger(await api.memory(project.id, 'read', { name, archive: group === 'archive' }));
    });
  }

  return <dialog ref={dialog} className="dialog nav-dialog memory-dialog" aria-label="项目记忆"
    onCancel={event => { event.preventDefault(); if (!pending) close(); }}>
    <div className="dialog-head"><h2>项目记忆</h2><button aria-label="关闭" disabled={pending} onClick={close}><X size={18}/></button></div>
    <label className="check-row"><input type="checkbox" checked={project.autoMemory === true} disabled={busy || pending}
      onChange={event => {
        const enabled = event.target.checked;
        void execute(async () => onAuto(await api.memory(project.id, 'auto', { enabled })));
      }}/>自动提取和整理记忆</label>
    <p className="muted">开启后，JHarness 会用当前模型从会话提取项目事实并定期整理，产生额外 API 用量。</p>
    <form className="memory-search" onSubmit={event => {
      event.preventDefault();
      if (query.trim()) void execute(async () => {
        setMatches(await api.memory(project.id, 'search', { query: query.trim() }));
      });
    }}>
      <input type="search" placeholder="搜索长期记忆和每日日志" aria-label="搜索记忆" maxLength={200}
        disabled={pending} value={query} onChange={event => { setQuery(event.target.value); setMatches(''); }}/>
      <button className="secondary" disabled={pending || !query.trim()}>搜索</button>
    </form>
    {matches && <pre className="memory-ledger" aria-label="记忆搜索结果">{matches}</pre>}
    {snapshot && <>
      <label>查看<select value={choice} disabled={pending} onChange={event => select(event.target.value)}>
        <option value="">长期记忆</option>
        {!!snapshot.daily.length && <optgroup label="每日日志">{snapshot.daily.map(name =>
          <option key={name} value={'daily:' + name}>{name}</option>)}</optgroup>}
        {!!snapshot.archive.length && <optgroup label="归档日志">{snapshot.archive.map(name =>
          <option key={name} value={'archive:' + name}>{name}</option>)}</optgroup>}
      </select></label>
      {choice ? <pre className="memory-ledger">{ledger || (pending ? '正在读取…' : '没有内容。')}</pre>
        : <textarea aria-label="长期记忆" placeholder="记录项目约定、重要决定或偏好"
          rows={12} maxLength={25000} disabled={busy || pending} value={draft} onChange={event => setDraft(event.target.value)}/>}
      <div className="dialog-actions">
        <button type="button" className="secondary" disabled={pending}
          onClick={() => execute(reload)}>重新读取</button>
        {!choice && <button type="button" className="primary" disabled={busy || pending || draft === snapshot.summary}
          onClick={() => execute(async () => {
            await api.memory(project.id, 'update', { expected: snapshot.summary, text: draft });
            await reload();
            setMessage('已保存。');
          })}>保存记忆</button>}
      </div>
    </>}
    {message && <p className={error ? 'error-text' : 'success-text'} role={error ? 'alert' : 'status'}>{message}</p>}
  </dialog>;
}

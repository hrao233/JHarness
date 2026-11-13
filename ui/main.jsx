import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ArrowUp, ChevronRight, CircleHelp, FolderOpen, FolderPlus, MessageSquare, Plus, Settings, Square, X, FileText } from 'lucide-react';
import './style.css';

const api = window.jharness;
const empty = { projects: [], model: {} };
const errText = error => String(error.message || error).replace(/^Error invoking remote method '[^']+': Error: /, '');
const suggestions = ['读一下 README，解释这个项目的结构。', '这个项目有哪些主要模块？', '帮我找到项目的启动入口。'];

function App() {
  const [data, setData] = useState(empty);
  const [selected, setSelected] = useState(null);
  const [items, setItems] = useState([]);
  const [draft, setDraft] = useState('');
  const [run, setRun] = useState(null);
  const [notice, setNotice] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [loading, setLoading] = useState(false);
  const running = useRef(null);
  const selection = useRef(null);
  const scroll = useRef(null);
  const project = data.projects.find(value => value.id === selected?.project);
  const session = project?.sessions.find(value => value.id === selected?.session);

  async function refresh() {
    const state = await api.state();
    setData(state);
    return state;
  }

  async function select(p, s) {
    const next = { project: p.id, session: s?.id };
    selection.current = next;
    setSelected(next);
    setItems([]);
    setNotice('');
    setLoading(Boolean(s));
    if (!s) return;
    try {
      const history = await api.history(p.id, s.id);
      if (selection.current === next) setItems(history);
    } catch (error) {
      if (selection.current === next) setNotice(errText(error));
    } finally {
      if (selection.current === next) setLoading(false);
    }
  }

  useEffect(() => {
    refresh().then(state => {
      const p = state.projects[0];
      if (p) void select(p, p.sessions[0]);
    }).catch(error => setNotice(errText(error)));
    return api.onEvent(message => {
      const current = running.current;
      if (message.runId !== current?.id) return;
      const { event, data } = message;
      if (event === 'error') return setNotice(data.message);
      if (event === 'done') {
        running.current = null;
        setRun(null);
        return;
      }
      if (selection.current !== current.selection) return;
      setItems(previous => {
        if (event === 'text' || event === 'result') {
          const index = previous.findLastIndex(item => item.role === 'assistant' && item.runId === current.id);
          if (index < 0) return [...previous, { role: 'assistant', runId: current.id, text: data.text || data.delta }];
          const item = previous[index];
          return previous.map((value, i) => i === index
            ? { ...item, text: event === 'result' ? data.text : item.text + data.delta }
            : value);
        }
        if (event === 'tool-start') {
          return [...previous, { role: 'tool', id: data.toolId, name: data.name, status: '执行中', args: '', output: '' }];
        }
        return previous.map(item => {
          if (item.role !== 'tool' || item.id !== data.toolId) return item;
          if (event === 'tool-args') return { ...item, args: (item.args + data.delta).slice(0, 16000) };
          if (event === 'tool-output') return { ...item, output: (item.output + data.delta).slice(0, 16000) };
          if (event === 'tool-end') return { ...item, status: data.status };
          return item;
        });
      });
    });
  }, []);

  useEffect(() => {
    const pane = scroll.current;
    if (pane) pane.scrollTop = pane.scrollHeight;
  }, [items]);

  async function openProject() {
    try {
      const p = await api.openProject();
      if (!p) return;
      await refresh();
      await select(p, p.sessions[0]);
    } catch (error) { setNotice(errText(error)); }
  }

  async function newSession() {
    if (!project) return openProject();
    try {
      const created = await api.newSession(project.id);
      await refresh();
      await select(project, created);
    } catch (error) { setNotice(errText(error)); }
  }

  async function send(event) {
    event?.preventDefault();
    const text = draft.trim();
    if (!text || running.current || loading) return;
    if (!data.model.hasKey) return setShowSettings(true);
    if (!project) return openProject();
    setNotice('');
    let target = session;
    const id = crypto.randomUUID();
    const reservation = { id, selection: selection.current };
    running.current = reservation;
    setRun(id);
    try {
      if (!target) {
        target = await api.newSession(project.id);
        await refresh();
        await select(project, target);
      }
      reservation.selection = selection.current;
      setDraft('');
      setItems(previous => [...previous, { role: 'user', text }]);
      await api.chat(project.id, target.id, text, id);
      await refresh();
    } catch (error) {
      if (running.current?.id === id) {
        running.current = null;
        setRun(null);
      }
      setNotice(errText(error));
    }
  }

  return <div className="app">
    <aside className="sidebar">
      <div className="brand"><span className="mark">J</span><strong>JHarness</strong></div>
      <button className="side-action" disabled={!!run} onClick={newSession}><Plus size={17}/>新建会话</button>
      <button className="side-action" disabled={!!run} onClick={openProject}><FolderPlus size={17}/>打开项目</button>
      <div className="projects">
        {data.projects.length > 0 && <div className="side-label">项目</div>}
        {data.projects.map(p => <div className="project" key={p.id}>
          <button title={p.directory} className="project-name" disabled={!!run} onClick={() => select(p, p.sessions[0])}>
            <FolderOpen size={15}/><span>{p.name}</span>
          </button>
          {p.sessions.map(s => <button key={s.id} disabled={!!run}
            className={'session ' + (selected?.session === s.id ? 'selected' : '')}
            onClick={() => select(p, s)}><MessageSquare size={14}/><span>{s.title}</span></button>)}
        </div>)}
      </div>
      <button className="side-action settings" onClick={() => setShowSettings(true)}><Settings size={16}/>设置</button>
    </aside>
    <main>
      <header><div className="crumb"><span title={project?.directory}>{project?.name || '工作台'}</span>
        <ChevronRight size={15}/><strong>{session?.title || '新会话'}</strong></div>
        <button className="model" onClick={() => setShowSettings(true)}>{data.model.hasKey ? data.model.model : '配置模型'}</button>
      </header>
      <div className="scroll" ref={scroll}>
        <div className="thread">
          {!items.length && !loading && <div className="welcome">
            <div className="welcome-icon"><MessageSquare size={24} strokeWidth={1.6}/></div>
            <h1>{project ? '想了解项目的什么？' : '打开一个项目'}</h1>
            <p>{project ? '可以阅读代码、梳理项目结构，或修改项目文件。' : '选择本机文件夹，开始一段项目会话。'}</p>
            {project ? <div className="suggestions">{suggestions.map(text =>
              <button key={text} onClick={() => setDraft(text)}><FileText size={15}/>{text}</button>)}</div>
              : <button className="primary" onClick={openProject}><FolderOpen size={16}/>选择文件夹</button>}
          </div>}
          {loading && <p className="muted">正在加载会话…</p>}
          {items.map((item, index) => item.role === 'tool'
            ? <details className="tool" key={item.id || index}><summary><FileText size={15}/>{item.name}<small>{item.status}</small></summary>
                {item.args && <pre>{item.args}</pre>}{item.output && <pre>{item.output}</pre>}</details>
            : <div key={index} className={item.role === 'user' ? 'user-msg' : 'assistant-msg'}>
                {item.role === 'user' ? item.text : <Markdown remarkPlugins={[remarkGfm]}
                  components={{ a: ({ children }) => <span>{children}</span>, img: () => null }}>{item.text}</Markdown>}
              </div>)}
          {run && !items.some(item => item.runId === run) && <p className="muted" role="status">正在处理…</p>}
        </div>
      </div>
      <div className="bottom"><div className="composer-wrap">
        {notice && <div className="notice" role="alert"><CircleHelp size={16}/>{notice}
          <button aria-label="关闭提示" onClick={() => setNotice('')}><X size={15}/></button></div>}
        <form className="composer" onSubmit={send}>
          <textarea rows="2" maxLength={16000} value={draft} placeholder={project ? '输入消息…' : '先选择项目文件夹'}
            aria-label="消息" disabled={!project || loading} onChange={event => setDraft(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) void send(event);
            }}/>
          <div className="compose-actions"><span>{project ? '可编辑项目' : '未选择项目'}</span>
            {run ? <button type="button" className="send" aria-label="停止"
              onClick={() => api.stop(run).catch(error => setNotice(errText(error)))}><Square size={15}/></button>
              : <button className="send" aria-label="发送" disabled={!project || !draft.trim() || loading}><ArrowUp size={19}/></button>}
          </div>
        </form>
      </div></div>
    </main>
    {showSettings && <ModelSettings value={data.model} close={() => setShowSettings(false)}
      onSave={model => setData(previous => ({ ...previous, model }))}/>}
  </div>;
}

function ModelSettings({ value, close, onSave }) {
  const [form, setForm] = useState({ provider: value.provider || 'deepseek',
    baseUrl: value.baseUrl || '', model: value.model || '', key: '' });
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const panel = useRef(null);
  const compatible = form.provider === 'compatible';
  const keepKey = value.hasKey && value.provider === form.provider && (!compatible || value.baseUrl === form.baseUrl.trim());

  useEffect(() => { panel.current.showModal(); }, []);

  function edit(field, value) {
    setStatus('');
    setForm(previous => ({ ...previous, [field]: value }));
  }

  async function execute(save) {
    setBusy(true);
    setFailed(false);
    setStatus('');
    try {
      const next = await (save ? api.saveModel(form) : api.testModel(form));
      if (save) {
        onSave(next);
        close();
      } else setStatus('连接成功 · ' + next.model);
    } catch (error) {
      setFailed(true);
      setStatus(errText(error));
    } finally { setBusy(false); }
  }

  return <dialog ref={panel} className="dialog" onCancel={event => { event.preventDefault(); if (!busy) close(); }}>
    <div className="dialog-head"><h2>模型设置</h2><button aria-label="关闭" disabled={busy} onClick={close}><X size={18}/></button></div>
    <form onSubmit={event => { event.preventDefault(); void execute(true); }}>
      <label>服务商<select value={form.provider} onChange={event => {
        const provider = event.target.value;
        setStatus('');
        setForm({ provider, key: '', baseUrl: value.provider === provider ? value.baseUrl : '',
          model: value.provider === provider ? value.model : '' });
      }}><option value="deepseek">DeepSeek 官方</option><option value="compatible">OpenAI 兼容接口</option></select></label>
      {compatible ? <>
        <label>Base URL<input required type="url" placeholder="https://api.example.com/v1" value={form.baseUrl}
          onChange={event => edit('baseUrl', event.target.value)}/></label>
        <label>模型 ID<input required value={form.model} onChange={event => edit('model', event.target.value)}/></label>
      </> : <div className="provider-note"><span>默认模型</span><code>deepseek-flash</code></div>}
      <label>API Key<input type="password" autoComplete="off" required={!keepKey} value={form.key}
        placeholder={keepKey ? '已保存，留空继续使用' : '粘贴 API Key'} onChange={event => edit('key', event.target.value)}/></label>
      {status && <p className={failed ? 'error-text' : 'success-text'} role="status">{status}</p>}
      <div className="dialog-actions">
        <button type="button" className="secondary" disabled={busy} onClick={() => execute(false)}>测试连接</button>
        <button className="primary" disabled={busy}>{busy ? '处理中…' : '保存'}</button>
      </div>
    </form>
  </dialog>;
}

createRoot(document.getElementById('root')).render(<App/>);

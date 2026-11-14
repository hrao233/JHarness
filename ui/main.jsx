import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ChevronDown, ChevronRight, CircleHelp, FolderOpen, FolderPlus, MessageSquare, Plus, X, FileText } from 'lucide-react';
import { ApprovalCard, Composer, effortLabels } from './Composer.jsx';
import { Conversation } from './Conversation.jsx';
import { Navigation, NavigationPanel } from './Navigation.jsx';
import './style.css';

const api = window.jharness;
const empty = { projects: [], models: [] };
const errText = error => String(error.message || error).replace(/^Error invoking remote method '[^']+': Error: /, '');
const suggestions = ['读一下 README，解释这个项目的结构。', '这个项目有哪些主要模块？', '帮我找到项目的启动入口。'];

function App() {
  const [data, setData] = useState(empty);
  const [selected, setSelected] = useState(null);
  const [items, setItems] = useState([]);
  const [draft, setDraft] = useState('');
  const [parts, setParts] = useState([]);
  const [availableParts, setAvailableParts] = useState(null);
  const [perm, setPerm] = useState('assist');
  const [effort, setEffort] = useState('');
  const [fast, setFast] = useState(false);
  const [modelId, setModelId] = useState('');
  const [approvals, setApprovals] = useState([]);
  const [collapsed, setCollapsed] = useState({});
  const [run, setRun] = useState(null);
  const [notice, setNotice] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [showSidebar, setShowSidebar] = useState(true);
  const [panel, setPanel] = useState(null);
  const [jump, setJump] = useState(null);
  const [bookmarks, setBookmarks] = useState([]);
  const [loading, setLoading] = useState(false);
  const running = useRef(null);
  const selection = useRef(null);
  const scroll = useRef(null);
  const project = data.projects.find(value => value.id === selected?.project);
  const session = project?.sessions.find(value => value.id === selected?.session);
  const model = data.models.find(value => value.id === (modelId || data.defaultModelId));
  const effectiveEffort = model?.effortLevels?.includes(effort) ? effort : model?.initialEffort || '';
  const effectiveFast = !!model?.fastTier && fast;
  const recent = data.projects.flatMap(p => p.sessions.filter(s => s.updatedAt).map(s => ({ p, s })))
    .sort((a, b) => b.s.updatedAt - a.s.updatedAt).slice(0, 5);

  async function refresh() {
    const state = await api.state();
    setData(state);
    return state;
  }

  async function select(p, s) {
    if (selection.current?.project === p.id && selection.current?.session === s?.id) return;
    setParts([]);
    setAvailableParts(null);
    setDraft('');
    const next = { project: p.id, session: s?.id };
    selection.current = next;
    setSelected(next);
    setModelId(s?.modelId || '');
    setEffort(s?.effort || '');
    setFast(s?.fast === true);
    setPerm(s?.permission || 'assist');
    setCollapsed(previous => ({ ...previous, [p.id]: false }));
    setItems([]);
    setJump(null);
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
    api.bookmarks().then(setBookmarks).catch(error => setNotice(errText(error)));
    return api.onEvent(message => {
      const current = running.current;
      if (message.runId !== current?.id) return;
      const { event, data } = message;
      if (event === 'error') return setNotice(data.message);
      if (event === 'done') {
        running.current = null;
        setRun(null);
        setApprovals([]);
        return;
      }
      if (event === 'approval') return setApprovals(previous => [...previous, data]);
      if (event === 'approval-end') return setApprovals(previous => previous.filter(item => item.id !== data.id));
      if (event === 'review') {
        const labels = { PENDING: '正在自动审查', APPROVE: '自动审查已批准', DENY: '自动审查已阻止', ASK: '需要你批准' };
        setItems(previous => {
          const id = current.id + ':review:' + data.path;
          const index = previous.findLastIndex(item => item.id === id && item.status === labels.PENDING);
          const item = { role: 'tool', id, name: data.path, status: labels[data.decision], args: '', output: '' };
          if (index < 0) return [...previous, { ...item, id: data.decision === 'PENDING' ? id : crypto.randomUUID() }];
          return previous.map((value, i) => i === index ? { ...item, id: crypto.randomUUID() } : value);
        });
        return;
      }
      if (selection.current !== current.selection) return;
      setItems(previous => {
        if (event === 'text' || event === 'result') {
          const index = previous.findLastIndex(item => item.role === 'assistant' && item.runId === current.id);
          if (index < 0) return [...previous, { id: data.id, role: 'assistant', runId: current.id, text: data.text || data.delta }];
          const item = previous[index];
          return previous.map((value, i) => i === index
            ? { ...item, id: data.id ?? item.id, text: event === 'result' ? data.text : item.text + data.delta }
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

  async function openProject() {
    try {
      const p = await api.openProject();
      if (!p) return;
      await refresh();
      await select(p, p.sessions[0]);
    } catch (error) { setNotice(errText(error)); }
  }

  async function newSession(p) {
    if (!p) return openProject();
    try {
      const created = await api.newSession(p.id);
      await refresh();
      await select(p, created);
    } catch (error) { setNotice(errText(error)); }
  }

  async function loadParts() {
    const selectedProject = project?.id;
    if (!selectedProject) return;
    setAvailableParts(null);
    try {
      const entries = await api.projectParts(selectedProject);
      if (selection.current?.project === selectedProject) setAvailableParts(entries);
    } catch (error) {
      setAvailableParts([]);
      setNotice(errText(error));
    }
  }

  function appendParts(entries) {
    setParts(previous => [...previous, ...entries.filter(part =>
      !previous.some(old => part.id === old.id && part.source === old.source && part.kind === old.kind))].slice(0, 8));
  }

  async function attach(kind) {
    if (!project) return;
    const target = selection.current;
    try {
      const entries = await api.attach(project.id, kind);
      if (selection.current === target) appendParts(entries);
    } catch (error) { setNotice(errText(error)); }
  }

  async function copy(text) {
    try {
      await api.copy(text);
      return true;
    } catch (error) {
      setNotice(errText(error));
      return false;
    }
  }

  function quote(text) {
    if (run || loading || !project) return;
    const quoted = text.split('\n').map(line => '> ' + line).join('\n');
    setDraft(previous => ((previous ? previous + '\n\n' : '') + quoted + '\n\n').slice(0, 16000));
    document.querySelector('.composer textarea')?.focus();
  }

  async function removeBookmark(id) {
    try {
      setBookmarks(await api.removeBookmark(id));
    } catch (error) { setNotice(errText(error)); }
  }

  async function saveBookmark({ item, bookmark }) {
    if (bookmark) return removeBookmark(bookmark.id);
    if (!session || !item.id || run) return;
    try {
      setBookmarks(await api.bookmark({ projectId: project.id, sessionId: session.id, messageId: item.id }));
    } catch (error) { setNotice(errText(error)); }
  }

  async function openChat(projectId, sessionId, anchor) {
    const target = data.projects.find(value => value.id === projectId);
    const chat = target?.sessions.find(value => value.id === sessionId);
    if (!chat || run) return;
    await select(target, chat);
    if (anchor && selection.current?.session === sessionId) setJump(anchor);
  }

  async function decide(id, allow) {
    if (!run) return;
    try {
      if (!await api.approve(run, id, allow)) setNotice('这项审批已结束。');
      setApprovals(previous => previous.filter(item => item.id !== id));
    } catch (error) { setNotice(errText(error)); }
  }

  async function send(event) {
    event?.preventDefault();
    const text = draft.trim() || (parts.length ? '请查看附加内容。' : '');
    if (!text || running.current || loading) return;
    if (!model?.hasKey) return setShowSettings(true);
    if (!project) return openProject();
    setNotice('');
    let target = session;
    const id = crypto.randomUUID();
    const reservation = { id, selection: selection.current, submitting: true };
    running.current = reservation;
    setRun(id);
    try {
      if (!target) {
        target = await api.newSession(project.id);
        await refresh();
        await select(project, target);
      }
      reservation.selection = selection.current;
      const labels = parts.map(part => part.label);
      const display = text + (labels.length ? '\n\n' + labels.join(' · ') : '');
      setItems(previous => [...previous, { id, role: 'user', text: display, runId: id }]);
      await api.chat(project.id, target.id, text, id, { modelId, effort: effectiveEffort, fast: effectiveFast, permission: perm, parts });
    } catch (error) {
      if (running.current?.id === id) {
        running.current = null;
        setRun(null);
      }
      setDraft(draft);
      setParts(parts);
      setItems(previous => previous.filter(item => item.role !== 'user' || item.runId !== id));
      setNotice(errText(error));
      return;
    }
    reservation.submitting = false;
    setJump({ turn: 'latest' });
    setDraft('');
    setParts([]);
    setModelId(modelId);
    setEffort(effectiveEffort);
    setFast(effectiveFast);
    setPerm(perm);
    if (reservation.stopRequested && running.current === reservation) {
      api.stop(id).catch(error => setNotice(errText(error)));
    }
    refresh().catch(error => setNotice(errText(error)));
  }

  function stop() {
    const current = running.current;
    if (!current) return;
    if (current.submitting) current.stopRequested = true;
    else api.stop(current.id).catch(error => setNotice(errText(error)));
  }

  return <div className={'app' + (showSidebar ? '' : ' sidebar-hidden')}>
    <Navigation project={project} busy={!!run} showSidebar={showSidebar}
      home={() => setShowSidebar(value => !value)} attachImage={() => attach('image')}
      openPanel={setPanel} openSettings={() => setShowSettings(true)}/>
    <aside className="sidebar" aria-label="项目和会话" hidden={!showSidebar}>
      <div className="brand"><span className="mark">J</span><strong>JHarness</strong></div>
      <button className="side-action" disabled={!!run} onClick={() => newSession(project)}><Plus size={17}/>新建会话</button>
      <button className="side-action" disabled={!!run} onClick={openProject}><FolderPlus size={17}/>打开项目</button>
      <div className="projects">
        {!!recent.length && <section className="recent">
          <div className="side-label">最近会话</div>
          {recent.map(({ p, s }) => <button className="session recent-session" disabled={!!run} key={s.id}
            onClick={() => select(p, s)} title={p.name + ' / ' + s.title}>
            <MessageSquare size={14}/><span>{s.title}</span></button>)}
        </section>}
        {data.projects.length > 0 && <div className="side-label">项目</div>}
        {data.projects.map(p => <div className="project" key={p.id}>
          <div className="project-row">
            <button className="project-toggle" aria-label={p.name + ' 会话'} aria-expanded={!collapsed[p.id]}
              onClick={() => setCollapsed(previous => ({ ...previous, [p.id]: !previous[p.id] }))}>
              {collapsed[p.id] ? <ChevronRight size={13}/> : <ChevronDown size={13}/>}
            </button>
            <button title={p.directory} className="project-name" disabled={!!run} onClick={() => select(p, p.sessions[0])}>
              <FolderOpen size={15}/><span>{p.name}</span>
            </button>
            <button className="project-add" disabled={!!run} aria-label={'在 ' + p.name + ' 新建会话'}
              title="在此项目中新建会话" onClick={() => newSession(p)}><Plus size={16}/></button>
          </div>
          {!collapsed[p.id] && p.sessions.map(s => <button key={s.id} disabled={!!run}
            className={'session ' + (selected?.session === s.id ? 'selected' : '')}
            onClick={() => select(p, s)}><MessageSquare size={14}/><span>{s.title}</span></button>)}
        </div>)}
      </div>
    </aside>
    <main>
      <header><div className="crumb"><span title={project?.directory}>{project?.name || '工作台'}</span>
        <ChevronRight size={15}/><strong>{session?.title || '新会话'}</strong></div>
      </header>
      <Conversation key={session?.id || project?.id || 'empty'} items={items} sessionId={session?.id}
        status={!!run && !approvals.length && !items.some(item => item.role === 'assistant' && item.runId === run)}
        copy={copy} quote={run || loading ? null : quote} saved={bookmarks} onSave={saveBookmark}
        run={run} jump={jump} scroll={scroll}>
          {!items.length && !loading && <div className="welcome">
            <div className="welcome-icon"><MessageSquare size={24} strokeWidth={1.6}/></div>
            <h1>{project ? '想了解项目的什么？' : '打开一个项目'}</h1>
            <p>{project ? '可以阅读代码、梳理项目结构，或修改项目文件。' : '选择本机文件夹，开始一段项目会话。'}</p>
            {project ? <div className="suggestions">{suggestions.map(text =>
              <button key={text} onClick={() => setDraft(text)}><FileText size={15}/>{text}</button>)}</div>
              : <button className="primary" onClick={openProject}><FolderOpen size={16}/>选择文件夹</button>}
          </div>}
          {loading && <p className="muted">正在加载会话…</p>}
      </Conversation>
      <div className="bottom"><div className="composer-wrap">
        {!!approvals.length && <div className="approvals">{approvals.map(item =>
          <ApprovalCard key={item.id} item={item} decide={decide}/>)}</div>}
        {notice && <div className="notice" role="alert"><CircleHelp size={16}/>{notice}
          <button aria-label="关闭提示" onClick={() => setNotice('')}><X size={15}/></button></div>}
        <Composer draft={draft} setDraft={setDraft} project={project} loading={loading} run={run} send={send} stop={stop}
          parts={parts} remove={part => setParts(previous => previous.filter(value => value !== part))}
          attach={attach} availableParts={availableParts} loadParts={loadParts} addPart={part => appendParts([part])}
          permission={perm} setPermission={setPerm} models={data.models} modelId={modelId} model={model}
          defaultModelId={data.defaultModelId} effort={effectiveEffort} setEffort={setEffort} fast={effectiveFast} setFast={setFast}
          selectModel={id => { setModelId(id); setEffort(''); setFast(false); }} settings={() => setShowSettings(true)}/>
      </div></div>
    </main>
    {panel && <NavigationPanel key={panel} panel={panel} close={() => setPanel(null)} projects={data.projects}
      project={project} bookmarks={bookmarks} openChat={openChat} removeBookmark={removeBookmark}
      copy={copy} addPart={part => appendParts([part])} busy={!!run} api={api} errorText={errText}/>}
    {showSettings && <ModelSettings models={data.models} defaultModelId={data.defaultModelId} selectedId={model?.id}
      close={() => setShowSettings(false)} onSave={({ savedModelId, ...state }) => {
        setData(state);
        setModelId(savedModelId);
        setEffort('');
        setFast(false);
      }}/>}
  </div>;
}

function modelForm(value, defaultModelId) {
  return { id: value?.id || '', provider: value?.provider || 'deepseek', baseUrl: value?.baseUrl || '',
    model: value?.model || 'deepseek-flash', key: '', makeDefault: !defaultModelId || value?.id === defaultModelId,
    fastTier: value?.fastTier ?? '', efforts: value?.efforts
      || ['minimal', 'low', 'medium', 'high', 'xhigh'] };
}

function ModelSettings({ models, defaultModelId, selectedId, close, onSave }) {
  const [form, setForm] = useState(() => modelForm(models.find(value => value.id === selectedId), defaultModelId));
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [testEffort, setTestEffort] = useState('');
  const [testFast, setTestFast] = useState(false);
  const panel = useRef(null);
  const compatible = form.provider === 'compatible';
  const levels = compatible ? form.efforts : ['none', 'low', 'high', 'max'];
  const selectedTestEffort = levels.includes(testEffort) ? testEffort : levels.includes('high') ? 'high' : levels[0];
  const value = models.find(item => item.id === form.id);
  const keepKey = value?.hasKey && value.provider === form.provider && (!compatible || value.baseUrl === form.baseUrl.trim());

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
      const next = await (save ? api.saveModel(form) : api.testModel({ ...form, testEffort: selectedTestEffort,
        testFast: compatible && !!form.fastTier && testFast }));
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
      {!!models.length && <label>配置<select value={form.id} disabled={busy} onChange={event => {
        const id = event.target.value;
        setStatus('');
        setTestEffort('');
        setTestFast(false);
        setForm(modelForm(models.find(item => item.id === id), defaultModelId));
      }}><option value="">添加模型</option>{models.map(item =>
        <option value={item.id} key={item.id}>{item.model} · {item.provider === 'deepseek' ? 'DeepSeek 官方' : item.baseUrl}</option>)}
      </select></label>}
      <label>服务商<select value={form.provider} disabled={busy} onChange={event => {
        const provider = event.target.value;
        setStatus('');
        setTestEffort('');
        setTestFast(false);
        setForm(previous => ({ ...previous, provider, key: '', baseUrl: value?.provider === provider ? value.baseUrl : '',
          model: value?.provider === provider ? value.model : provider === 'deepseek' ? 'deepseek-flash' : '' }));
      }}><option value="deepseek">DeepSeek 官方</option><option value="compatible">OpenAI 兼容接口</option></select></label>
      {compatible ? <>
        <label>Base URL<input required type="url" placeholder="https://api.example.com/v1" value={form.baseUrl}
          onChange={event => edit('baseUrl', event.target.value)}/></label>
        <label>模型 ID<input required value={form.model} onChange={event => edit('model', event.target.value)}/></label>
        <label>服务商快速档位<select value={form.fastTier} onChange={event => {
          edit('fastTier', event.target.value);
          setTestFast(false);
        }}>
          <option value="">关闭</option><option value="fast">fast</option><option value="priority">priority</option>
        </select></label>
        <details className="effort-config"><summary>配置服务商支持的推理强度</summary>
          <div>{Object.entries(effortLabels).map(([id, label]) =>
            <label className="check-row" key={id}><input type="checkbox" checked={form.efforts.includes(id)}
              onChange={event => {
                edit('efforts', event.target.checked ? [...form.efforts, id] : form.efforts.filter(value => value !== id));
                if (testEffort === id) setTestEffort('');
              }}/>{label}</label>)}</div>
        </details>
      </> : <label>模型<select value={form.model} onChange={event => edit('model', event.target.value)}>
        <option value="deepseek-flash">DeepSeek Flash</option>
        <option value="deepseek-v4-pro">DeepSeek V4 Pro</option>
      </select></label>}
      <label>API Key<input type="password" autoComplete="off" required={!keepKey} value={form.key}
        placeholder={keepKey ? '已保存，留空继续使用' : '粘贴 API Key'} onChange={event => edit('key', event.target.value)}/></label>
      <label className="check-row"><input type="checkbox" checked={form.makeDefault}
        disabled={!defaultModelId || form.id === defaultModelId}
        onChange={event => edit('makeDefault', event.target.checked)}/>设为默认模型</label>
      <details className="effort-config"><summary>连接测试选项</summary>
        {!!levels.length && <label>测试推理强度<select value={selectedTestEffort} onChange={event => setTestEffort(event.target.value)}>
          {levels.map(level =>
            <option key={level} value={level}>{effortLabels[level]}</option>)}
        </select></label>}
        {compatible && form.fastTier && <label className="check-row"><input type="checkbox" checked={testFast}
          onChange={event => setTestFast(event.target.checked)}/>测试快速档位</label>}
      </details>
      {status && <p className={failed ? 'error-text' : 'success-text'} role="status">{status}</p>}
      <div className="dialog-actions">
        <button type="button" className="secondary" disabled={busy} onClick={() => execute(false)}>测试连接</button>
        <button className="primary" disabled={busy}>{busy ? '处理中…' : '保存'}</button>
      </div>
    </form>
  </dialog>;
}

createRoot(document.getElementById('root')).render(<App/>);

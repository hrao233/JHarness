import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Globe, ChevronDown, ChevronRight, CircleHelp, FolderOpen, FolderPlus, MessageSquare, Plus, X, PanelLeft, PanelRight, Settings, SquarePen, Terminal, FileText } from 'lucide-react';
import { ApprovalCard, Composer, InterruptedApprovals, TaskRecovery, effortLabels } from './Composer.jsx';
import { Conversation } from './Conversation.jsx';
import { Navigation, NavigationPanel, inspectorTools } from './Navigation.jsx';
import { MemoryPanel } from './MemoryPanel.jsx';
import './style.css';

const api = window.jharness;
const empty = { projects: [], models: [] };
const errText = error => String(error.message || error).replace(/^Error invoking remote method '[^']+': Error: /, '');
const suggestions = [
  ['梳理项目结构', '读一下 README，解释这个项目的结构。'],
  ['了解主要模块', '这个项目有哪些主要模块？'],
  ['查找启动入口', '帮我找到项目的启动入口。']
];

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
  const [task, setTask] = useState(null);
  const [taskPending, setTaskPending] = useState(false);
  const [taskError, setTaskError] = useState('');
  const [cancelingTask, setCancelingTask] = useState(false);
  const [sessionView, setSessionView] = useState('project');
  const [collapsed, setCollapsed] = useState({});
  const [run, setRun] = useState(null);
  const [browserBusy, setBrowserBusy] = useState(false);
  const [phase, setPhase] = useState(null);
  const [notice, setNotice] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [showSidebar, setShowSidebar] = useState(() => localStorage.getItem('sidebarVisible') !== 'false');
  const [sidebarWidth, setSidebarWidth] = useState(() =>
    Math.min(420, Math.max(264, Number(localStorage.getItem('sidebarWidth')) || 272)));
  const [wide, setWide] = useState(() => matchMedia('(min-width: 1140px)').matches);
  useEffect(() => {
    const media = matchMedia('(min-width: 1140px)');
    const update = () => setWide(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  useEffect(() => { localStorage.setItem('sidebarVisible', String(showSidebar)); }, [showSidebar]);
  useEffect(() => { localStorage.setItem('sidebarWidth', String(sidebarWidth)); }, [sidebarWidth]);
  const [panel, setPanel] = useState(null);
  const [jump, setJump] = useState(null);
  const [bookmarks, setBookmarks] = useState([]);
  const [loading, setLoading] = useState(false);
  const running = useRef(null);
  const selection = useRef(null);
  const openingSession = useRef(null);
  const [focusSession, setFocusSession] = useState(null);
  const scroll = useRef(null);
  const project = data.projects.find(value => value.id === selected?.project);
  const session = project?.sessions.find(value => value.id === selected?.session);
  const model = data.models.find(value => value.id === (modelId || data.defaultModelId));
  const effectiveEffort = model?.effortLevels?.includes(effort) ? effort : model?.initialEffort || '';
  const effectiveFast = !!model?.fastTier && fast;
  const recent = data.projects.flatMap(p => p.sessions.filter(s => s.updatedAt).map(s => ({ p, s })))
    .sort((a, b) => b.s.updatedAt - a.s.updatedAt);

  const [reportRevision, setReportRevision] = useState(0);
  const [reportData, setReportData] = useState(null);
  const [rerunning, setRerunning] = useState(null);
  const rerunLock = useRef(null);
  const [completed, setCompleted] = useState(null);
  const latestUser = items.findLast(item => item.role === 'user');
  const latestRun = completed?.target === selected ? completed.id : (latestUser?.runId || latestUser?.id);
  const reports = reportData?.target === selected ? reportData?.value : null;
  const reportError = reportData?.target === selected ? reportData?.error : '';
  const latestReport = reports?.find(report => report.runId === latestRun);
  const lastCommand = latestReport?.commands.at(-1);
  const uncovered = lastCommand ? lastCommand.changedFiles : latestReport
    && (latestReport.acceptance?.criteria?.length || reports.some(report => report.commands.length))
      ? [...new Set(latestReport.checkpoints.filter(cp => ['SUCCESS', 'RESTORED'].includes(cp.status))
          .map(cp => cp.path))] : [];
  const refreshReports = () => setReportRevision(value => value + 1);

  useEffect(() => {
    if (!selected?.session || run || loading || (!latestRun && panel !== 'reports')) return;
    let active = true;
    let request = 0;
    async function load() {
      const version = ++request;
      try {
        const value = await api.report(selected.project, selected.session);
        if (active && version === request) setReportData({ target: selected, value });
      } catch (error) {
        if (active && version === request) setReportData({ target: selected, error: errText(error) });
      }
    }
    void load();
    window.addEventListener('focus', load);
    return () => { active = false; window.removeEventListener('focus', load); };
  }, [selected, run, loading, latestRun, reportRevision, panel === 'reports']);

  async function rerunCommand(report, command) {
    if (rerunLock.current || running.current || !selected?.session) return;
    const target = selected;
    rerunLock.current = command.id;
    setRerunning(command.id);
    try {
      await api.rerunCommand(target.project, target.session, report.runId, command.id);
    } catch (error) {
      if (selection.current === target) setNotice(errText(error));
    } finally {
      rerunLock.current = null;
      setRerunning(null);
      refreshReports();
    }
  }

  async function refresh() {
    const state = await api.state();
    setData(state);
    return state;
  }

  async function loadTask(target) {
    setTaskPending(true);
    setTaskError('');
    try {
      const result = await api.task(target.project, target.session);
      if (selection.current === target) setTask(result.turnId ? result : null);
    } catch (error) {
      if (selection.current === target) setTaskError(errText(error));
    } finally {
      if (selection.current === target) setTaskPending(false);
    }
  }

  async function select(p, s) {
    if (selection.current?.project === p.id && selection.current?.session === s?.id) return;
    setPanel(null);
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
    setTask(null);
    setTaskError('');
    setTaskPending(false);
    setCancelingTask(false);
    setLoading(Boolean(s));
    if (!s) return;
    void loadTask(next);
    try {
      const history = await api.history(p.id, s.id);
      if (selection.current === next) setItems(history);
    } catch (error) {
      if (selection.current === next) setNotice(errText(error));
    } finally {
      if (selection.current === next) setLoading(false);
    }
  }

  async function worktreesChanged(created, removedId) {
    const state = await refresh();
    if (created) {
      const target = state.projects.find(item => item.id === created.id);
      if (target) await select(target, target.sessions[0]);
      return;
    }
    if (removedId && selected?.project === removedId) {
      const target = state.projects[0];
      if (target) {
        await select(target, target.sessions[0]);
      } else {
        selection.current = { project: null, session: null };
        setSelected(null);
        setItems([]);
        setTask(null);
        setNotice('');
      }
    }
  }

  useEffect(() => {
    refresh().then(state => {
      const p = state.projects[0];
      if (p) void select(p, p.sessions[0]);
    }).catch(error => setNotice(errText(error)));
    api.bookmarks().then(setBookmarks).catch(error => setNotice(errText(error)));
    return api.onEvent(message => {
      if (message.event === 'browser-dock-request') {
        if (selection.current?.project === message.data?.projectId) setPanel('browser');
        return;
      }
      if (message.event === 'automation-changed') {
        void refresh();
        return;
      }
      const current = running.current;
      if (message.runId !== current?.id) {
        const target = selection.current;
        if (!current && target?.session && ['approval', 'approval-end', 'done'].includes(message.event)) {
          void loadTask(target);
          if (message.event === 'done') {
            void refresh();
            api.history(target.project, target.session).then(history => {
              if (selection.current === target && !running.current) setItems(history);
            }).catch(() => {});
          }
        }
        return;
      }
      const { event, data } = message;
      if (event === 'error') return setNotice(data.message);
      if (event === 'done') {
        if (selection.current === current.selection) setCompleted({ target: current.selection, id: current.id });
        running.current = null;
        setRun(null);
        setBrowserBusy(false);
        setPhase(null);
        setApprovals([]);
        if (data.status && selection.current === current.selection) void loadTask(current.selection);
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
      if (event === 'browser') {
        setBrowserBusy(data.phase !== 'done');
        const id = current.id + ':browser';
        const item = { id, role: 'browser', ...data };
        setItems(previous => previous.some(value => value.id === id)
          ? previous.map(value => value.id === id ? item : value) : [...previous, item]);
        return;
      }
      if (event === 'loop-phase') {
        current.step = data.phase === 'summary' ? 'summary' : data.step;
        return setPhase(data);
      }
      const step = current.step;
      setItems(previous => {
        if (event === 'text' || event === 'result') {
          const index = previous.findLastIndex(item => item.role === 'assistant' && item.runId === current.id
            && item.step === step);
          if (index < 0) return [...previous, { id: data.id, replyId: data.replyId, role: 'assistant',
            runId: current.id, step, text: data.text || data.delta }];
          const item = previous[index];
          return previous.map((value, i) => i === index
            ? { ...item, id: data.id ?? item.id, replyId: data.replyId ?? item.replyId,
              text: event !== 'text' ? data.text : data.replyId === item.replyId ? item.text + data.delta : data.delta }
            : value);
        }
        if (event === 'tool-start') {
          return [...previous, { role: 'tool', id: current.id + ':' + step + ':' + data.toolId, toolId: data.toolId,
            runId: current.id, name: data.name, status: '待执行', args: '', output: '' }];
        }
        const toolIndex = previous.findLastIndex(item => item.role === 'tool'
          && item.runId === current.id && item.toolId === data.toolId);
        if (event === 'tool-execution' && toolIndex < 0) {
          return [...previous, { role: 'tool', id: current.id + ':' + step + ':' + data.toolId, toolId: data.toolId,
            runId: current.id, name: data.name, status: '执行中', args: '', output: '' }];
        }
        return previous.map((item, index) => {
          if (index !== toolIndex) return item;
          if (event === 'tool-execution') return { ...item, status: '执行中' };
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
      setSessionView('project');
      await select(p, p.sessions[0]);
    } catch (error) { setNotice(errText(error)); }
  }

  async function newSession(p) {
    if (running.current || openingSession.current?.project === (p?.id ?? null)) return;
    const origin = selection.current;
    const request = { project: p?.id ?? null };
    openingSession.current = request;
    try {
      if (!p) {
        await openProject();
        return;
      }
      const preferred = origin?.project === p.id ? origin.session : undefined;
      const blank = await api.newSession(p.id, preferred);
      await refresh();
      if (openingSession.current !== request || selection.current !== origin || running.current) return;
      await select(p, blank);
      setFocusSession(blank.id);
    } catch (error) {
      if (openingSession.current === request) setNotice(errText(error));
    } finally {
      if (openingSession.current === request) openingSession.current = null;
    }
  }

  useEffect(() => {
    if (!focusSession || loading) return;
    if (focusSession === selection.current?.session) document.querySelector('.composer textarea')?.focus();
    setFocusSession(null);
  }, [focusSession, loading]);

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

  async function forkMessage({ item }) {
    if (!project || !session || run || !item.id) return;
    try {
      const branch = await api.forkSession(project.id, session.id, item.id);
      await refresh();
      await select(project, branch);
      setNotice('已从所选消息创建分叉会话。');
    } catch (error) {
      setNotice(errText(error));
    }
  }

  async function openChat(projectId, sessionId, anchor) {
    const target = data.projects.find(value => value.id === projectId);
    const chat = target?.sessions.find(value => value.id === sessionId);
    if (!chat || run) return;
    await select(target, chat);
    if (anchor && selection.current?.session === sessionId) setJump(anchor);
  }

  async function openBrowserLink(url) {
    if (!project) return;
    setNotice('');
    try {
      const state = await api.browserState(project.id);
      if (!state.detached) setPanel('browser');
      await api.openBrowser(project.id, url);
    } catch (error) {
      setPanel('browser');
      setNotice(errText(error));
    }
  }

  async function decide(id, allow) {
    const targetRun = run || task?.liveRunId;
    if (!targetRun) return;
    try {
      if (!await api.approve(targetRun, id, allow)) setNotice('这项审批已结束。');
      setApprovals(previous => previous.filter(item => item.id !== id));
    } catch (error) { setNotice(errText(error)); }
  }

  async function send(event) {
    event?.preventDefault();
    const text = draft.trim() || (parts.length ? '请查看附加内容。' : '');
    if (!text || rerunLock.current || loading || task || taskPending || taskError) return;
    if (!model?.hasKey) return setShowSettings(true);
    if (!project) return openProject();
    setNotice('');
    if (running.current) {
      if (perm !== 'durable' || parts.length || !session) return;
      const id = running.current.id;
      try {
        if (!await api.steer(id, text)) {
          throw new Error('当前任务已停止接收补充指令。');
        }
        setItems(previous => [...previous, { id: crypto.randomUUID(), role: 'user', text, runId: id }]);
        setDraft('');
        setJump({ turn: 'latest' });
      } catch (error) {
        setNotice(errText(error));
        void loadTask(selection.current);
      }
      return;
    }
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

  async function queueTask() {
    const text = draft.trim();
    const target = selection.current;
    if (!text || !running.current || perm !== 'durable' || parts.length || loading
      || !target?.session || !project) return;
    if (!model?.hasKey) return setShowSettings(true);
    const id = crypto.randomUUID();
    setNotice('');
    try {
      if (!await api.queueTask(project.id, target.session, text, id,
        { modelId, effort: effectiveEffort, fast: effectiveFast })) {
        throw new Error('无法添加排队任务。');
      }
      setItems(previous => [...previous, { id, role: 'user', text, runId: id, queued: true }]);
      setDraft('');
      setJump({ turn: 'latest' });
      refresh().catch(error => setNotice(errText(error)));
    } catch (error) {
      setNotice(errText(error));
    }
  }

  function stop() {
    const current = running.current;
    if (!current) return;
    if (current.submitting) current.stopRequested = true;
    else api.stop(current.id).catch(error => setNotice(errText(error)));
  }

  async function resumeTask(answers, outcomes = {}) {
    const target = selection.current;
    if (!target?.session || !task || running.current || taskPending || taskError || cancelingTask) return;
    if (task.uncertain && !Object.keys(outcomes).length) return;
    if (!model?.hasKey) return setShowSettings(true);
    const id = crypto.randomUUID();
    const reservation = { id, selection: target, submitting: true };
    running.current = reservation;
    setRun(id);
    setNotice('');
    try {
      const options = { modelId, effort: effectiveEffort, fast: effectiveFast };
      const result = task.uncertain
        ? await api.reconcileTask(target.project, target.session, task.turnId, id, answers, outcomes, options)
        : await api.resumeTask(target.project, target.session, task.turnId, id, answers, options);
      if (result === false) {
        throw new Error('任务状态已更新，请查看当前任务。');
      }
      reservation.submitting = false;
      setJump({ turn: 'latest' });
      if (reservation.stopRequested && running.current === reservation) await api.stop(id);
    } catch (error) {
      if (running.current === reservation && reservation.submitting) {
        running.current = null;
        setRun(null);
        if (selection.current === target) void loadTask(target);
      }
      if (selection.current === target) setNotice(errText(error));
    }
  }

  async function cancelTask() {
    const target = selection.current;
    if (!target?.session || !task || task.uncertain || running.current || taskPending || taskError || cancelingTask) return;
    setCancelingTask(true);
    setNotice('');
    try {
      if (!await api.cancelTask(target.project, target.session, task.turnId)) {
        throw new Error('任务状态已更新，请查看当前任务。');
      }
    } catch (error) {
      if (selection.current === target) setNotice(errText(error));
    } finally {
      if (selection.current === target) {
        setCancelingTask(false);
        void loadTask(target);
      }
    }
  }

  const docked = wide && inspectorTools.includes(panel);
  function toggleSidebar() { setShowSidebar(value => !value); }

  useEffect(() => {
    function shortcut(event) {
      if (!event.ctrlKey || event.shiftKey || event.altKey || event.metaKey || event.isComposing
          || event.repeat || document.querySelector('dialog:modal')) return;
      if (event.code === 'KeyB') toggleSidebar();
      else if (event.code === 'KeyN' && !running.current) void newSession(project);
      else if (event.code === 'KeyO' && !running.current) void openProject();
      else return;
      event.preventDefault();
    }
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, [project]);

  const sidebarToggle = <button className="shell-icon" onClick={toggleSidebar}
    aria-expanded={showSidebar} aria-controls="project-sidebar" aria-keyshortcuts="Control+B"
    title={(showSidebar ? '收起' : '展开') + '侧栏 (Ctrl+B)'}><PanelLeft size={18}/></button>;

  return <div className={'app' + (showSidebar ? '' : ' sidebar-hidden') + (docked ? ' with-inspector' : '')}
    style={{ '--sidebar-width': sidebarWidth + 'px' }}>
    <aside id="project-sidebar" className="sidebar" aria-label="项目和会话" hidden={!showSidebar}>
      <div className="brand"><span className="mark"><Terminal size={16}/></span><strong>JHarness</strong>{sidebarToggle}</div>
      <div className="sidebar-scroll">
        <button className="side-action new-chat" disabled={!!run} title="新建会话 (Ctrl+N)"
          onClick={() => newSession(project)}><SquarePen size={17}/>新建会话<kbd>Ctrl N</kbd></button>
        <Navigation project={project} openPanel={setPanel}/>
        <div className="side-section"><div className="view-switch" role="group" aria-label="会话列表视图">
          <button aria-pressed={sessionView === 'project'} onClick={() => setSessionView('project')}>项目</button>
          <button aria-pressed={sessionView === 'recent'} onClick={() => setSessionView('recent')}>最近会话</button>
        </div>
          <button className="shell-icon" aria-label="打开项目" title="打开项目 (Ctrl+O)"
            disabled={!!run} onClick={openProject}><FolderPlus size={16}/></button>
        </div>
        {!data.projects.length && <button className="side-action add-folder" disabled={!!run}
          onClick={openProject}><Plus size={15}/>添加项目文件夹</button>}
        <div className="projects">
          {sessionView === 'recent' && <section className="recent">
            {!recent.length && <p className="side-label">还没有最近会话</p>}
            {recent.map(({ p, s }) => <button className={'session recent-session' + (selected?.session === s.id ? ' selected' : '')} disabled={!!run} key={s.id}
              onClick={() => select(p, s)} title={p.name + ' / ' + s.title}>
              <MessageSquare size={14}/><span>{s.title}</span></button>)}
          </section>}
          {sessionView === 'project' && data.projects.map(p => <div className="project" key={p.id}>
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
      </div>
      <button className="side-action sidebar-settings" aria-label="设置" onClick={() => setShowSettings(true)}>
        <Settings size={17}/>设置</button>
      <div className="sidebar-grip" role="separator" aria-label="调整侧栏宽度" aria-orientation="vertical"
        aria-valuemin={264} aria-valuemax={420} aria-valuenow={sidebarWidth} tabIndex={0}
        onPointerDown={event => { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); }}
        onPointerMove={event => {
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            setSidebarWidth(Math.min(420, Math.max(264, event.clientX)));
        }}
        onKeyDown={event => {
          if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
          event.preventDefault();
          setSidebarWidth(width => Math.min(420, Math.max(264, width + (event.key === 'ArrowRight' ? 16 : -16))));
        }}/>
    </aside>
    <main>
      <header><div className="crumb">{!showSidebar && <>{sidebarToggle}
        <button className="shell-icon" title="新建会话 (Ctrl+N)" disabled={!!run} onClick={() => newSession(project)}><SquarePen size={17}/></button></>}
        <span title={project?.directory}>{project?.name || '工作台'}</span>
        <ChevronRight size={15}/><strong>{session?.title || '新会话'}</strong></div>
        <button className={'shell-icon browser-shortcut' + (browserBusy ? ' active' : '')} disabled={!project}
          aria-label="内置浏览器" title="内置浏览器" onClick={() => setPanel(panel === 'browser' ? null : 'browser')}><Globe size={18}/></button>
        <button className="shell-icon" disabled={!project} aria-label="工作区工具" title="工作区工具"
          aria-expanded={inspectorTools.includes(panel)}
          onClick={() => setPanel(inspectorTools.includes(panel) ? null : session ? 'context' : 'review')}>
          <PanelRight size={18}/></button>
      </header>
      <Conversation key={session?.id || project?.id || 'empty'} items={items} sessionId={session?.id}
        status={run && !approvals.length ? (phase
          ? '第 ' + phase.step + ' 步 · '
            + ({ acting: '执行工具', reasoning: '请求模型', summary: '整理本轮结果' }[phase.phase] || '执行中')
          : '正在准备…') : null}
        copy={copy} quote={run || loading ? null : quote} saved={bookmarks} onSave={saveBookmark}
        onFork={run || loading ? null : forkMessage}
        openLink={project ? openBrowserLink : null}
        run={run} jump={jump} scroll={scroll}>
          {!items.length && !loading && <div className="welcome">
            <div className="welcome-icon"><Terminal size={30} strokeWidth={1.8}/></div>
            <h1>{project ? '从哪里开始？' : '打开项目，开始工作'}</h1>
            <p>{project ? project.name : '选择本机文件夹，开始一段项目会话。'}</p>
            {project ? <div className="suggestions">{suggestions.map(([label, text]) =>
              <button key={text} onClick={() => { setDraft(text); document.querySelector('.composer textarea')?.focus(); }}><FileText size={15}/>{label}</button>)}</div>
              : <button className="primary" onClick={openProject}><FolderOpen size={16}/>选择文件夹</button>}
          </div>}
          {loading && <p className="muted">正在加载会话…</p>}
      </Conversation>
      <div className="bottom"><div className="composer-wrap">
        {!run && !task && !taskPending && !taskError && !loading && !!uncovered?.length &&
          <div className="coverage-notice" role="status">
            <span>尚未被最近命令覆盖的文件：{uncovered.join('、')}</span>
            {lastCommand && <button type="button" className="secondary" disabled={!!rerunning}
              title={lastCommand.command} onClick={() => rerunCommand(latestReport, lastCommand)}>
              {rerunning === lastCommand.id ? '重新运行中…' : '重新运行最近命令'}</button>}
            <button type="button" className="secondary" onClick={() => setPanel('reports')}>任务报告</button>
          </div>}
        {!!approvals.length && <div className="approvals">{approvals.map(item =>
          <ApprovalCard key={item.id} item={item} openBrowser={() => setPanel('browser')} decide={decide}/>)}</div>}
        {!run && task?.liveRunId && task.approvals.map(item => <ApprovalCard key={item.id} item={item}
          openBrowser={() => setPanel('browser')} decide={decide}/>)}
        {!run && task && !task.liveRunId && <TaskRecovery key={task.turnId} task={task} canceling={cancelingTask}
          blocked={taskPending || !!taskError || cancelingTask} resume={resumeTask} cancel={cancelTask}/>}
        {taskError && <div className="notice" role="alert">无法读取任务状态。{taskError}
          <button type="button" onClick={() => loadTask(selection.current)}>重试</button></div>}
        {project && <InterruptedApprovals key={project.id} projectId={project.id} api={api} errorText={errText}/>}
        {notice && <div className="notice" role="alert"><CircleHelp size={16}/>{notice}
          <button aria-label="关闭提示" onClick={() => setNotice('')}><X size={15}/></button></div>}
        <Composer draft={draft} setDraft={setDraft} project={project} loading={loading}
          sendBlocked={!!rerunning || !!task || taskPending || !!taskError} run={run} send={send} stop={stop}
          canSteer={!!run && perm === 'durable' && !parts.length} queueTask={queueTask}
          parts={parts} remove={part => setParts(previous => previous.filter(value => value !== part))}
          attach={attach} availableParts={availableParts} loadParts={loadParts} addPart={part => appendParts([part])}
          permission={perm} setPermission={setPerm} models={data.models} modelId={modelId} model={model}
          defaultModelId={data.defaultModelId} effort={effectiveEffort} setEffort={setEffort} fast={effectiveFast} setFast={setFast}
          selectModel={id => { setModelId(id); setEffort(''); setFast(false); }} settings={() => setShowSettings(true)}/>
      </div></div>
    </main>
    {panel === 'memory' && project && <MemoryPanel project={project} busy={!!run} errorText={errText}
      api={api} close={() => setPanel(null)} onAuto={enabled => setData(previous => ({ ...previous,
        projects: previous.projects.map(p => p.id === project.id ? { ...p, autoMemory: enabled } : p) }))}/>}
    {panel && panel !== 'memory' && <NavigationPanel settingsOpen={showSettings} docked={docked} switchTool={setPanel} key={panel} panel={panel} close={() => setPanel(null)} projects={data.projects}
      reports={reports} reportError={reportError} refreshReports={refreshReports}
      rerunning={rerunning} rerunCommand={rerunCommand}
      project={project} session={session} bookmarks={bookmarks} openChat={openChat} removeBookmark={removeBookmark}
      copy={copy} addPart={part => appendParts([part])} busy={!!run} api={api} errorText={errText}
      onWorktreesChanged={worktreesChanged} openWorktree={target => select(target, target.sessions[0])}/>}
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

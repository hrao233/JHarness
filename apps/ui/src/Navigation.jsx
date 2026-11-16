import React, { useEffect, useRef, useState } from 'react';
import { BookOpen, Brain, CircleCheck, CircleDashed, ClipboardList, Download, ExternalLink,
  FileBox, GitBranch, GitPullRequest, House, Images, ListChecks, Plus, Power, Puzzle, RefreshCw,
  RotateCcw, ScanText, Search, Settings, SquareTerminal, Trash2, X }
  from 'lucide-react';

export function Navigation({ showSidebar, home, attachImage, openPanel, openSettings, busy, project, session }) {
  const links = [
    { label: '首页', Icon: House, action: home, expanded: showSidebar },
    { label: '添加图片', Icon: Images, action: attachImage, disabled: !project || busy },
    { label: '资料库', Icon: BookOpen, action: () => openPanel('library') },
    { label: '项目记忆', Icon: Brain, action: () => openPanel('memory'), disabled: !project },
    { label: 'Skills 与插件', Icon: Puzzle, action: () => openPanel('plugins') },
    { label: '搜索会话', Icon: Search, action: () => openPanel('search') },
    { label: '任务中心', Icon: ListChecks, action: () => openPanel('tasks') },
    { label: '任务报告', Icon: ClipboardList, action: () => openPanel('reports'), disabled: !session },
    { label: '隔离工作树', Icon: GitBranch, action: () => openPanel('worktrees'), disabled: !project },
    { label: '上下文', Icon: ScanText, action: () => openPanel('context'), disabled: !session },
    { label: '检查点', Icon: RotateCcw, action: () => openPanel('checkpoints'), disabled: !project },
    { label: '代码审查', Icon: GitPullRequest, action: () => openPanel('review'), disabled: !project }
  ];
  return <nav className="navigation-rail" aria-label="工作台导航">
    {links.map(({ label, Icon, action, disabled, expanded }) =>
      <button key={label} type="button" title={label} aria-label={label} aria-expanded={expanded}
        disabled={disabled} onClick={action}><Icon size={19}/></button>)}
    <button type="button" className="rail-settings" aria-label="设置" title="设置" onClick={openSettings}><Settings size={19}/></button>
  </nav>;
}

const titles = {
  library: '资料库', plugins: 'Skills 与插件', search: '搜索会话', tasks: '任务中心',
  reports: '任务报告', worktrees: '隔离工作树', context: '上下文', checkpoints: '检查点',
  review: '代码审查'
};
const taskStatus = {
  queued: '排队中', running: '运行中', suspended: '等待审批',
  interrupted: '已中断', failed: '失败', completed: '已完成', cancelled: '已取消', rejected: '已拒绝'
};

export function NavigationPanel({ panel, close, projects, project, bookmarks, openChat, removeBookmark,
    copy, addPart, busy, api, errorText, session, onWorktreesChanged, openWorktree }) {
  const dialog = useRef(null);
  const [query, setQuery] = useState('');
  const [result, setResult] = useState(null);
  const [search, setSearch] = useState(null);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [diff, setDiff] = useState('unstaged');
  const [tasks, setTasks] = useState(null);
  const [context, setContext] = useState(null);
  const [exportState, setExportState] = useState(null);
  const [externalPlugins, setExternalPlugins] = useState([]);
  const [pluginBusy, setPluginBusy] = useState('');
  const [checkpoints, setCheckpoints] = useState(null);
  const [checkpointDetail, setCheckpointDetail] = useState(null);
  const [checkpointBusy, setCheckpointBusy] = useState('');
  const [reports, setReports] = useState(null);
  const [reportBusy, setReportBusy] = useState('');
  const [changeSet, setChangeSet] = useState(null);
  const [changeSetBusy, setChangeSetBusy] = useState('');
  const [changeSetNotice, setChangeSetNotice] = useState('');
  const [worktreeStatus, setWorktreeStatus] = useState(null);
  const [worktreeBusy, setWorktreeBusy] = useState('');
  const [worktreeName, setWorktreeName] = useState('');
  useEffect(() => { dialog.current.showModal(); }, []);
  useEffect(() => {
    if (panel !== 'plugins' && (panel !== 'review' || !project)) return;
    let live = true;
    setResult(null);
    setError('');
    const read = panel === 'plugins'
      ? Promise.all([
        project ? api.projectParts(project.id) : Promise.resolve([]),
        api.externalPlugins()
      ]).then(([parts, plugins]) => {
        if (live) setExternalPlugins(plugins);
        return parts;
      })
      : api.review(project.id);
    read.then(value => { if (live) setResult(value); })
      .catch(error => { if (live) setError(errorText(error)); });
    return () => { live = false; };
  }, [panel, project?.id, revision]);

  useEffect(() => {
    if (panel !== 'tasks') return;
    let live = true;
    async function loadTasks() {
      try {
        const value = await api.tasks();
        if (!live) return;
        setTasks(value);
        setError('');
      } catch (failure) {
        if (live) setError(errorText(failure));
      }
    }
    setTasks(null);
    setError('');
    void loadTasks();
    const timer = setInterval(loadTasks, 2000);
    return () => { live = false; clearInterval(timer); };
  }, [api, errorText, panel, revision]);

  useEffect(() => {
    if (panel !== 'context' || !project || !session) return;
    let live = true;
    setContext(null);
    setError('');
    api.context(project.id, session.id).then(value => {
      if (live) setContext(value);
    }).catch(failure => {
      if (live) setError(errorText(failure));
    });
    return () => { live = false; };
  }, [api, errorText, panel, project?.id, session?.id, revision]);

  useEffect(() => {
    if (panel !== 'checkpoints' || !project) return;
    let live = true;
    setCheckpoints(null);
    setCheckpointDetail(null);
    setError('');
    api.checkpoints(project.id, session?.id || '').then(value => {
      if (live) setCheckpoints(value);
    }).catch(failure => {
      if (live) setError(errorText(failure));
    });
    return () => { live = false; };
  }, [api, errorText, panel, project?.id, session?.id, revision]);

  useEffect(() => {
    if (panel !== 'reports' || !project || !session) return;
    let live = true;
    setReports(null);
    setChangeSet(null);
    setError('');
    api.report(project.id, session.id).then(value => {
      if (live) setReports(value);
    }).catch(failure => {
      if (live) setError(errorText(failure));
    });
    return () => { live = false; };
  }, [api, errorText, panel, project?.id, session?.id, revision]);

  useEffect(() => {
    setChangeSet(null);
    setChangeSetNotice('');
  }, [panel, project?.id, session?.id]);

  useEffect(() => {
    if (panel !== 'worktrees' || !project) return;
    let live = true;
    setWorktreeStatus(null);
    setWorktreeName('');
    setError('');
    api.worktreeStatus(project.id).then(value => {
      if (live) setWorktreeStatus(value);
    }).catch(failure => {
      if (live) setError(errorText(failure));
    });
    return () => { live = false; };
  }, [api, errorText, panel, project?.id, revision]);

  const needle = query.trim().toLowerCase();
  useEffect(() => {
    if (panel !== 'search' || !needle) return;
    let live = true;
    const timer = setTimeout(() => {
      api.searchSessions(needle).then(matches => {
        if (live) setSearch({ needle, matches });
      }).catch(error => {
        if (live) setSearch({ needle, error: errorText(error) });
      });
    }, 220);
    return () => { live = false; clearTimeout(timer); };
  }, [panel, needle]);

  const chats = panel === 'search' ? projects.flatMap(p => p.sessions.map(s => ({ p, s })))
    .sort((a, b) => (b.s.updatedAt || 0) - (a.s.updatedAt || 0)) : [];
  const results = !needle ? chats : search?.needle === needle && search.matches
    ? search.matches.flatMap(match => {
      const chat = chats.find(({ p, s }) => p.id === match.projectId && s.id === match.sessionId);
      return chat ? [{ ...chat, ...match }] : [];
    }) : [];

  async function exportContext(format) {
    if (!project || !session) return;
    setExportState({ busy: format, message: '' });
    try {
      const result = await api.exportSession(project.id, session.id, format, session.title);
      setExportState(result
        ? { busy: '', message: '已导出到 ' + result.path }
        : { busy: '', message: '已取消导出。' });
    } catch (failure) {
      setExportState({ busy: '', error: errorText(failure) });
    }
  }

  async function installExternalPlugin() {
    setPluginBusy('install');
    setError('');
    try {
      const installed = await api.installExternalPlugin();
      if (installed) setRevision(value => value + 1);
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setPluginBusy('');
    }
  }

  async function toggleExternalPlugin(plugin) {
    setPluginBusy(plugin.id);
    setError('');
    try {
      const next = await api.setExternalPlugin(plugin.id, !plugin.enabled);
      setExternalPlugins(previous => previous.map(item => item.id === next.id ? next : item));
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setPluginBusy('');
    }
  }

  async function uninstallExternalPlugin(plugin) {
    setPluginBusy(plugin.id);
    setError('');
    try {
      await api.uninstallExternalPlugin(plugin.id);
      setExternalPlugins(previous => previous.filter(item => item.id !== plugin.id));
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setPluginBusy('');
    }
  }

  async function openCheckpoint(checkpoint) {
    setCheckpointBusy(checkpoint.id);
    setCheckpointDetail(null);
    setError('');
    try {
      setCheckpointDetail(await api.checkpoint(project.id, checkpoint.id));
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setCheckpointBusy('');
    }
  }

  async function restoreCheckpoint(checkpoint) {
    if (!confirm('恢复 ' + checkpoint.path + ' 到该检查点之前的内容？')) return;
    setCheckpointBusy(checkpoint.id);
    setError('');
    try {
      setCheckpointDetail(await api.restoreCheckpoint(project.id, checkpoint.id));
      setRevision(value => value + 1);
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setCheckpointBusy('');
    }
  }

  async function openArtifact(artifact) {
    if (!project || !session) return;
    setReportBusy(artifact.id);
    setError('');
    try {
      await api.openArtifact(project.id, session.id, artifact.id);
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setReportBusy('');
    }
  }

  async function previewChangeSet(runId) {
    if (!project || !session) return;
    setChangeSetBusy(runId);
    setChangeSetNotice('');
    setError('');
    try {
      setChangeSet(await api.previewChangeSet(project.id, session.id, runId));
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setChangeSetBusy('');
    }
  }

  async function restoreChangeSet(preview) {
    if (!project || !session || !preview.canRestore) return;
    if (!confirm('将 ' + preview.files.length + ' 个文件恢复到本次任务开始前？')) return;
    setChangeSetBusy(preview.runId);
    setError('');
    setChangeSetNotice('');
    try {
      await api.restoreChangeSet(project.id, session.id, preview.runId);
      setChangeSet(null);
      setChangeSetNotice({
        runId: preview.runId,
        message: '已恢复本次任务改动的 ' + preview.files.length + ' 个文件。'
      });
      setRevision(value => value + 1);
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setChangeSetBusy('');
    }
  }

  async function createWorktree() {
    if (!project || project.worktree) return;
    setWorktreeBusy('create');
    setError('');
    try {
      const created = await api.createWorktree(project.id, worktreeName.trim());
      await onWorktreesChanged(created);
      close();
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setWorktreeBusy('');
    }
  }

  async function removeWorktree() {
    if (!project?.worktree) return;
    const risky = worktreeStatus && (worktreeStatus.dirty || worktreeStatus.ahead > 0);
    const warning = risky
      ? '此工作树包含未提交修改或未合并提交。继续会永久丢弃这些内容，确定移除吗？'
      : '移除此隔离工作树及其 JHarness 会话记录？';
    if (!confirm(warning)) return;
    setWorktreeBusy('remove');
    setError('');
    try {
      await api.removeWorktree(project.id, !!risky);
      await onWorktreesChanged(null, project.id);
      close();
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setWorktreeBusy('');
    }
  }

  return <dialog ref={dialog} className={'dialog nav-dialog nav-' + panel} aria-label={titles[panel]}
    onCancel={event => { event.preventDefault(); close(); }}>
    <div className="dialog-head"><h2>{titles[panel]}</h2>
      <button onClick={close} aria-label="关闭"><X size={18}/></button></div>
    {error && <p className="error-text" role="alert">{error}</p>}
    {panel === 'search' && <>
      <input type="search" autoFocus maxLength={160} aria-label="搜索项目、会话标题或消息正文" placeholder="搜索项目、会话标题或消息正文"
        value={query} onChange={event => setQuery(event.target.value)}/>
      <div className="nav-list">
        {results.map(({ p, s, messageId, excerpt }) => <button className="menu-row" disabled={busy} key={s.id}
          onClick={() => { close(); void openChat(p.id, s.id, messageId ? { messageId } : null); }}>
          <span className="menu-copy">{s.title}<small>{p.name}</small>{excerpt && <small>{excerpt}</small>}</span>
        </button>)}
        {needle && search?.needle !== needle && <p className="muted" role="status">正在搜索会话…</p>}
        {needle && search?.needle === needle && search.error && <p className="error-text" role="alert">{search.error}</p>}
        {!results.length && (!needle || (search?.needle === needle && !search.error)) && <p className="muted">没有匹配的会话。</p>}
      </div>
    </>}
    {panel === 'library' && <div className="nav-list">
      {bookmarks.map(value => <div className="library-item" key={value.id}>
        <small>{projects.find(p => p.id === value.projectId)?.name} · 第 {value.turn} 轮</small>
        <p>{value.text}</p>
        <div>
          <button className="secondary" disabled={busy} onClick={() => {
            close();
            void openChat(value.projectId, value.sessionId, { messageId: value.messageId, turn: value.turn });
          }}>打开原会话</button>
          <button className="secondary" onClick={() => copy(value.text)}>复制</button>
          <button className="secondary" onClick={() => removeBookmark(value.id)}>移除收藏</button>
        </div>
      </div>)}
      {!bookmarks.length && <p className="muted">可以从消息的「更多操作」收藏内容。</p>}
    </div>}
    {panel === 'tasks' && <>
      <div className="review-head"><span>运行中与等待处理</span>
        <button type="button" className="secondary" onClick={() => setRevision(value => value + 1)}>
          <RefreshCw size={15}/>刷新
        </button>
      </div>
      <div className="nav-list task-list">
        {!tasks && !error && <p className="muted">正在读取任务…</p>}
        {tasks?.map(task => <button className="menu-row task-row" disabled={busy} key={task.turnId}
          onClick={() => {
            const target = projects.find(value => value.id === task.projectId);
            const chat = target?.sessions.find(value => value.id === task.sessionId);
            if (!chat) return;
            close();
            void openChat(task.projectId, task.sessionId);
          }}>
          <ListChecks size={17}/>
          <span className="menu-copy">
            <strong>{task.title || task.sessionTitle || '未命名任务'}</strong>
            <small>{task.projectName || '项目'} · {task.sessionTitle || '会话'}</small>
          </span>
          <span className={'task-state state-' + task.status}>{taskStatus[task.status] || task.status}</span>
          {!!task.approvals?.length && <span className="task-badge">{task.approvals.length}</span>}
        </button>)}
        {tasks?.length === 0 && <p className="muted">没有运行中或等待处理的任务。</p>}
      </div>
    </>}
    {panel === 'context' && <>
      <div className="review-head"><span>{session?.title || '当前会话'}</span>
        <div className="context-actions">
          <button type="button" className="secondary" disabled={!!exportState?.busy}
            onClick={() => exportContext('markdown')}><Download size={15}/>Markdown</button>
          <button type="button" className="secondary" disabled={!!exportState?.busy}
            onClick={() => exportContext('json')}><Download size={15}/>JSON</button>
          <button type="button" className="secondary" onClick={() => setRevision(value => value + 1)}>
            <RefreshCw size={15}/>刷新
          </button>
        </div>
      </div>
      {exportState?.error && <p className="error-text" role="alert">{exportState.error}</p>}
      {exportState?.message && <p className="success-text" role="status">{exportState.message}</p>}
      {!context && !error && <p className="muted">正在读取上下文…</p>}
      {context && <div className="context-view">
        <div className="context-metrics">
          <span><b>{context.transcriptMessages}</b>条原始消息</span>
          <span><b>{context.compactionCount}</b>次压缩</span>
          <span><b>{context.checkpointCount}</b>个检查点</span>
          <span><b>{context.pendingInteractions}</b>项待处理</span>
        </div>
        {context.branch && <div className="context-note">
          <span>分叉自会话 {context.branch.sourceSessionId.slice(0, 8)} 的第 {context.branch.sourceSeq} 条事件。</span>
          <button type="button" className="secondary" onClick={() => {
            const source = projects.find(value =>
              value.sessions.some(chat => chat.id === context.branch.sourceSessionId));
            if (!source) return;
            close();
            void openChat(source.id, context.branch.sourceSessionId);
          }}>打开来源会话</button>
        </div>}
        {context.lastRequest ? <>
          <div className="context-request">
            <strong>{context.lastRequest.model || '最近模型请求'}</strong>
            <small>{context.lastRequest.messageCount} 条消息 · {context.lastRequest.toolCount} 个工具 · {context.lastRequest.characters} 字符</small>
          </div>
          {context.lastRequest.tools?.length > 0 && <details className="context-details">
            <summary>可用工具（{context.lastRequest.tools.length}）</summary>
            <div className="context-tags">{context.lastRequest.tools.map(name => <code key={name}>{name}</code>)}</div>
          </details>}
          <div className="context-messages">
            {context.lastRequest.messages.map((message, index) => <article className="context-message" key={index}>
              <span className={'context-role role-' + message.role}>{message.role}</span>
              {message.name && <code>{message.name}</code>}
              <p>{message.preview}</p>
              {message.items.length > 0 && <div className="context-items">
                {message.items.map((item, itemIndex) => <span key={itemIndex}>
                  <b>{item.kind}</b>{item.source}
                </span>)}
              </div>}
            </article>)}
          </div>
        </> : <p className="muted">当前会话还没有模型请求记录。</p>}
      </div>}
    </>}
    {panel === 'reports' && <>
      <div className="review-head"><span>{session?.title || '当前会话'}的任务报告</span>
        <button type="button" className="secondary" onClick={() => setRevision(value => value + 1)}>
          <RefreshCw size={15}/>刷新
        </button>
      </div>
      {!reports && !error && <p className="muted">正在读取任务报告…</p>}
      {reports?.length === 0 && <p className="muted">当前会话还没有任务报告。</p>}
      {!!reports?.length && <div className="task-report-list">
        {reports.map((report, index) => <details className="task-report" key={report.runId} open={index === 0}>
          <summary>
            <span><strong>任务 {report.runId.slice(0, 8)}</strong>
              <small>{new Date(report.updatedAt).toLocaleString()}</small></span>
            <span className="report-counts">
              {report.plan?.steps?.length || 0} 步 · {report.commands.length} 条命令 ·
              {' '}{report.artifacts.length} 个交付物 · {report.checkpoints.length} 项改动
            </span>
          </summary>
          {report.plan ? <section className="report-section">
            <div className="report-section-head"><strong>执行计划</strong><small>第 {report.plan.revision} 版</small></div>
            <ol className="report-plan">
              {report.plan.steps.map((step, stepIndex) => {
                const Icon = step.status === 'completed' ? CircleCheck
                  : CircleDashed;
                return <li className={'plan-' + step.status} key={stepIndex}>
                  <Icon size={16}/><span>{step.content}</span>
                  {step.priority && <small>{step.priority}</small>}
                </li>;
              })}
            </ol>
          </section> : <p className="muted report-section">这次任务没有记录执行计划。</p>}
          <section className="report-section">
            <div className="report-section-head"><strong>命令与验证</strong><small>{report.commands.length} 条</small></div>
            {report.commands.length === 0 && <p className="muted">没有运行项目命令。</p>}
            {report.commands.map(command => <article className="command-evidence" key={command.id}>
              <div className="command-evidence-head">
                <SquareTerminal size={16}/>
                <code>{command.command}</code>
                <span className={'command-outcome outcome-' + command.outcome.toLowerCase()}>
                  {command.outcome === 'SUCCEEDED' ? '成功'
                    : command.outcome === 'FAILED' ? '失败' : '结果未知'}
                </span>
              </div>
              <small>
                {command.exitCode === null ? '无退出码' : '退出码 ' + command.exitCode}
                {' · '}{command.durationMs} ms
                {command.outputTruncated ? ' · 输出已截断' : ''}
              </small>
              {command.output && <details className="command-output">
                <summary>查看输出</summary><pre>{command.output}</pre>
              </details>}
            </article>)}
          </section>
          <section className="report-section">
            <div className="report-section-head"><strong>交付物</strong><small>{report.artifacts.length} 个</small></div>
            {report.artifacts.length === 0 && <p className="muted">没有登记交付物。</p>}
            {report.artifacts.map(artifact => <div className="artifact-row" key={artifact.id}>
              <FileBox size={17}/>
              <span><strong>{artifact.fileName}</strong>
                <small>{artifact.description || artifact.sourcePath} · {artifact.size} 字节</small></span>
              <button type="button" className="secondary" disabled={!!reportBusy}
                onClick={() => openArtifact(artifact)}><ExternalLink size={15}/>打开</button>
            </div>)}
          </section>
          <section className="report-section">
            <div className="report-section-head"><strong>文件改动</strong><small>{report.checkpoints.length} 项</small></div>
            {report.checkpoints.length === 0 && <p className="muted">没有通过 JHarness 写入项目文件。</p>}
            {report.checkpoints.map(checkpoint => <div className="report-checkpoint" key={checkpoint.id}>
              <RotateCcw size={15}/><code>{checkpoint.path}</code>
              <span>{checkpoint.operation}</span>
              <small>{checkpoint.status}</small>
            </div>)}
            {report.checkpoints.some(checkpoint => checkpoint.status === 'SUCCESS')
              && <div className="change-set-toolbar">
              <button type="button" className="secondary" disabled={!!changeSetBusy}
                onClick={() => previewChangeSet(report.runId)}>
                <RotateCcw size={15}/>预览整组恢复
              </button>
              {changeSetNotice?.runId === report.runId && <span className="success-text" role="status">
                {changeSetNotice.message}
              </span>}
            </div>}
            {changeSet?.runId === report.runId && <div className="change-set-preview">
              <div className="report-section-head">
                <strong>{changeSet.files.length} 个文件</strong>
                <small>{changeSet.canRestore ? '可以安全恢复' : '存在后续修改'}</small>
              </div>
              {changeSet.files.map(file => <div className="change-set-file" key={file.path}>
                <code>{file.path}</code>
                <small>{file.checkpointCount} 次写入</small>
                <span className={file.matchesAfter ? 'state-ready' : 'state-conflict'}>
                  {file.matchesAfter ? '未再修改' : '与任务结束时不同'}
                </span>
              </div>)}
              {changeSet.conflicts.length > 0 && <p className="error-text" role="alert">
                以下文件在任务结束后又被修改或删除，整组恢复不会覆盖它们：
                {changeSet.conflicts.join('、')}
              </p>}
              <div className="change-set-actions">
                <button type="button" className="secondary"
                  onClick={() => setChangeSet(null)}>收起</button>
                <button type="button" className="primary" disabled={!changeSet.canRestore || !!changeSetBusy}
                  onClick={() => restoreChangeSet(changeSet)}>恢复整组改动</button>
              </div>
            </div>}
          </section>
        </details>)}
      </div>}
    </>}
    {panel === 'worktrees' && <>
      <div className="review-head"><span>{project?.name || '项目'}的隔离工作树</span>
        <button type="button" className="secondary" onClick={() => setRevision(value => value + 1)}>
          <RefreshCw size={15}/>刷新
        </button>
      </div>
      {project && !project.worktree && <section className="worktree-create">
        <p className="muted">从当前 Git 提交创建独立分支和目录。未提交修改不会复制到工作树。</p>
        {worktreeStatus?.source && <div className="worktree-source-state">
          <GitBranch size={15}/><span>{worktreeStatus.branch}</span>
          <small className={worktreeStatus.dirty ? 'state-conflict' : 'state-ready'}>
            {worktreeStatus.dirty
              ? worktreeStatus.changedFiles + ' 项未提交修改，不会复制'
              : '来源工作区干净'}
          </small>
        </div>}
        <div className="worktree-create-row">
          <input maxLength={40} value={worktreeName} aria-label="工作树名称"
            placeholder="例如 fix-login" onChange={event => setWorktreeName(event.target.value)}/>
          <button type="button" className="primary" disabled={!!worktreeBusy || busy} onClick={createWorktree}>
            <GitBranch size={15}/>创建工作树
          </button>
        </div>
      </section>}
      {project?.worktree && <section className="worktree-current">
        <div className="worktree-heading">
          <GitBranch size={18}/><span><strong>{project.worktree.branch}</strong>
            <small>{project.worktree.parentProjectName || project.name}</small></span>
          <span className={'task-state ' + (worktreeStatus?.dirty || worktreeStatus?.ahead
            ? 'state-interrupted' : 'state-completed')}>
            {!worktreeStatus ? '读取中' : !worktreeStatus.exists ? '目录缺失'
              : worktreeStatus.dirty ? '有未提交修改'
                : worktreeStatus.ahead > 0 ? worktreeStatus.ahead + ' 个提交待处理' : '干净'}
          </span>
        </div>
        <code className="worktree-path">{project.directory}</code>
        <div className="worktree-metrics">
          <span><b>{worktreeStatus?.changedFiles ?? 0}</b> 项修改</span>
          <span><b>{worktreeStatus?.ahead ?? 0}</b> 个新提交</span>
          <span>起始提交 <code>{project.worktree.baseCommit?.slice(0, 8)}</code></span>
        </div>
        <div className="worktree-actions">
          <button type="button" className="secondary" disabled={!!worktreeBusy || busy}
            onClick={removeWorktree}><Trash2 size={15}/>移除工作树</button>
        </div>
      </section>}
      <section className="worktree-list">
        <div className="side-label">已有工作树</div>
        {projects.filter(item => item.worktree).map(item => <button type="button" className="menu-row"
          key={item.id} disabled={busy || item.id === project?.id}
          onClick={() => { close(); openWorktree(item); }}>
          <GitBranch size={16}/><span className="menu-copy">
            <strong>{item.worktree.branch}</strong>
            <small>{item.worktree.parentProjectName || item.name}</small>
          </span>
        </button>)}
        {!projects.some(item => item.worktree)
          && <p className="muted">还没有隔离工作树。</p>}
      </section>
    </>}
    {panel === 'checkpoints' && <>
      <div className="review-head"><span>{project?.name || '项目'} 的文件检查点</span>
        <button type="button" className="secondary" onClick={() => setRevision(value => value + 1)}>
          <RefreshCw size={15}/>刷新
        </button>
      </div>
      <div className="checkpoint-list">
        {!checkpoints && !error && <p className="muted">正在读取检查点…</p>}
        {checkpoints?.map(checkpoint => <button type="button" className="checkpoint-row" key={checkpoint.id}
          aria-pressed={checkpointDetail?.id === checkpoint.id} disabled={!!checkpointBusy}
          onClick={() => openCheckpoint(checkpoint)}>
          <RotateCcw size={16}/>
          <span className="menu-copy"><strong>{checkpoint.path}</strong>
            <small>{checkpoint.operation} · {new Date(checkpoint.createdAt).toLocaleString()}</small></span>
          <span className={'task-state state-' + checkpoint.status.toLowerCase()}>{checkpoint.status}</span>
        </button>)}
        {checkpoints?.length === 0 && <p className="muted">
          {session ? '当前会话还没有文件检查点。' : '当前项目还没有文件检查点。'}
        </p>}
      </div>
      {checkpointDetail && <section className="checkpoint-detail">
        <div className="checkpoint-detail-head">
          <div><strong>{checkpointDetail.path}</strong>
            <small>{checkpointDetail.operation} · {checkpointDetail.status}</small></div>
          <button type="button" className="secondary"
            disabled={checkpointDetail.status !== 'SUCCESS' || !!checkpointBusy}
            onClick={() => restoreCheckpoint(checkpointDetail)}>
            <RotateCcw size={15}/>恢复此文件
          </button>
        </div>
        <div className="checkpoint-diff">
          <div><span>修改前</span><pre>{checkpointDetail.before?.exists
            ? checkpointDetail.before.text : '（文件不存在）'}</pre></div>
          <div><span>修改后</span><pre>{checkpointDetail.after?.exists
            ? checkpointDetail.after.text : '（文件不存在）'}</pre></div>
        </div>
      </section>}
    </>}
    {panel === 'plugins' && <>
      <div className="review-head"><span>项目资源与已安装工具</span>
        <button type="button" className="secondary" disabled={!!pluginBusy}
          onClick={installExternalPlugin}><Plus size={15}/>安装工具插件</button>
      </div>
      <div className="nav-list plugin-list">
        <div className="side-label">项目 Skill 与插件</div>
        {!project && <p className="muted">打开项目后查看项目内资源。</p>}
        {project && !result && !error && <p className="muted">正在读取项目…</p>}
        {result?.map(part => <button key={part.kind + part.source} className="menu-row" disabled={busy}
          onClick={() => { addPart(part); close(); }}>
          <Puzzle size={17}/><span className="menu-copy">{part.name}<small>{part.source}</small></span>
        </button>)}
        {project && result?.length === 0 && <p className="muted">当前项目还没有可用的 Skill 或插件。</p>}
        <div className="side-label">外部工具插件</div>
        {externalPlugins.map(plugin => <div className="external-plugin" key={plugin.id}>
          <div className="external-plugin-head">
            <span className="menu-copy">
              <strong>{plugin.name || plugin.id}</strong>
              <small>{plugin.id}{plugin.version ? ' · ' + plugin.version : ''}</small>
            </span>
            <button type="button" className="secondary" disabled={!!pluginBusy}
              aria-pressed={plugin.enabled} onClick={() => toggleExternalPlugin(plugin)}>
              <Power size={15}/>{plugin.enabled ? '已启用' : '已停用'}
            </button>
            <button type="button" className="secondary" aria-label={'卸载 ' + plugin.name}
              disabled={!!pluginBusy} onClick={() => uninstallExternalPlugin(plugin)}><Trash2 size={15}/></button>
          </div>
          {plugin.description && <p>{plugin.description}</p>}
          <div className="plugin-tools">{plugin.tools?.map(tool => <code key={tool.name}>{tool.name}</code>)}</div>
          {plugin.error && <p className="error-text" role="alert">{plugin.error}</p>}
          {plugin.diagnostics && <details><summary>插件诊断</summary><pre>{plugin.diagnostics}</pre></details>}
        </div>)}
        {externalPlugins.length === 0 && <p className="muted">尚未显式安装外部工具插件。</p>}
      </div>
    </>}
    {panel === 'review' && <>
      <div className="review-head"><span>{project?.name}</span>
        <button type="button" className="secondary" onClick={() => setRevision(value => value + 1)}>刷新</button></div>
      {!result && !error && <p className="muted">正在读取 Git 状态…</p>}
      {result && <>
        <pre className="review-code">{result.status || '无变更'}</pre>
        <div className="review-tabs">
          {[['unstaged', '未暂存'], ['staged', '已暂存']].map(([id, label]) =>
            <button type="button" key={id} className="secondary" aria-pressed={diff === id} onClick={() => setDiff(id)}>{label}</button>)}
        </div>
        <pre className="review-code diff">{result[diff]
          ? result[diff].split('\n').map((line, index) =>
            <span className={line.startsWith('+') ? 'diff-added' : line.startsWith('-') ? 'diff-removed' : undefined}
              key={index}>{line + '\n'}</span>) : '没有差异。'}</pre>
      </>}
    </>}
  </dialog>;
}

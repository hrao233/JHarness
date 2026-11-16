import React, { useEffect, useRef, useState } from 'react';
import { BookOpen, Brain, GitPullRequest, House, Images, Puzzle, Search, Settings, X } from 'lucide-react';

export function Navigation({ showSidebar, home, attachImage, openPanel, openSettings, busy, project }) {
  const links = [
    { label: '首页', Icon: House, action: home, expanded: showSidebar },
    { label: '添加图片', Icon: Images, action: attachImage, disabled: !project || busy },
    { label: '资料库', Icon: BookOpen, action: () => openPanel('library') },
    { label: '项目记忆', Icon: Brain, action: () => openPanel('memory'), disabled: !project },
    { label: 'Skills 与插件', Icon: Puzzle, action: () => openPanel('plugins') },
    { label: '搜索会话', Icon: Search, action: () => openPanel('search') },
    { label: '代码审查', Icon: GitPullRequest, action: () => openPanel('review'), disabled: !project }
  ];
  return <nav className="navigation-rail" aria-label="工作台导航">
    {links.map(({ label, Icon, action, disabled, expanded }) =>
      <button key={label} type="button" title={label} aria-label={label} aria-expanded={expanded}
        disabled={disabled} onClick={action}><Icon size={19}/></button>)}
    <button type="button" className="rail-settings" aria-label="设置" title="设置" onClick={openSettings}><Settings size={19}/></button>
  </nav>;
}

const titles = { library: '资料库', plugins: 'Skills 与插件', search: '搜索会话', review: '代码审查' };

export function NavigationPanel({ panel, close, projects, project, bookmarks, openChat, removeBookmark,
    copy, addPart, busy, api, errorText }) {
  const dialog = useRef(null);
  const [query, setQuery] = useState('');
  const [result, setResult] = useState(null);
  const [search, setSearch] = useState(null);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [diff, setDiff] = useState('unstaged');
  useEffect(() => { dialog.current.showModal(); }, []);
  useEffect(() => {
    if (!project || (panel !== 'plugins' && panel !== 'review')) return;
    let live = true;
    setResult(null);
    setError('');
    const read = panel === 'plugins' ? api.projectParts : api.review;
    read(project.id).then(value => { if (live) setResult(value); })
      .catch(error => { if (live) setError(errorText(error)); });
    return () => { live = false; };
  }, [panel, project?.id, revision]);

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
    {panel === 'plugins' && <div className="nav-list">
      {!project && <p className="muted">打开项目后查看项目的 Skills 与插件。</p>}
      {project && !result && !error && <p className="muted">正在读取项目…</p>}
      {result?.map(part => <button key={part.kind + part.source} className="menu-row" disabled={busy}
        onClick={() => { addPart(part); close(); }}>
        <Puzzle size={17}/><span className="menu-copy">{part.name}<small>{part.source}</small></span>
      </button>)}
      {result?.length === 0 && <p className="muted">当前项目还没有可用的 Skill 或插件。</p>}
    </div>}
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

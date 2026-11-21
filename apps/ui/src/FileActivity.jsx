import React, { useState } from 'react';
import { ChevronRight, FolderSearch } from 'lucide-react';

const actions = new Map([
  ['read_file', '读文件'], ['list_files', '列目录'],
  ['search_files', '搜索文件名'], ['search_text', '搜索文本']
]);
const states = {
  SUCCESS: '成功', ERROR: '失败', INTERRUPTED: '已中断', DENIED: '已拒绝',
  SUSPENDED: '已暂停', RUNNING: '执行中'
};
const exceptional = new Set(['ERROR', 'INTERRUPTED', 'DENIED', 'SUSPENDED']);
const pending = new Set(['待执行', '执行中', 'RUNNING']);

export function groupFileActivity(rows) {
  const groups = [];
  for (const row of rows) {
    const { item, turn } = row;
    if (item.role !== 'tool' || !actions.has(item.name)) {
      groups.push(row);
      continue;
    }
    const previous = groups.at(-1);
    if (previous?.calls && previous.turn === turn && previous.item.runId === item.runId) {
      previous.calls.push(item);
    } else {
      groups.push({ ...row, calls: [item] });
    }
  }
  return groups;
}

function target(call) {
  try {
    const args = JSON.parse(call.args);
    const label = args.query || args.path;
    return typeof label === 'string' ? label : '';
  } catch {
    // Arguments may arrive in several stream events.
    return '';
  }
}

function ActivityCall({ call, onInspect }) {
  const [open, setOpen] = useState(false);
  const label = target(call);
  return <div className="activity-call">
    <button type="button" className="activity-row" aria-expanded={open}
      onClick={() => { onInspect(); setOpen(!open); }}>
      <ChevronRight size={13}/><span>{actions.get(call.name)}</span>
      <span className="activity-target" title={label}>{label}</span>
      <small className={exceptional.has(call.status) ? 'activity-warning' : ''}>{states[call.status] || call.status}</small>
    </button>
    {open && <div className="activity-detail">
      {call.args && <pre aria-label="调用参数">{call.args}</pre>}
      {call.output && <pre aria-label="工具输出" tabIndex={0}>{call.output}</pre>}
      {!call.args && !call.output && <span>暂无参数或输出</span>}
    </div>}
  </div>;
}

export function FileActivity({ calls, run, onInspect }) {
  const [open, setOpen] = useState(false);
  const counts = new Map();
  let active;
  let incomplete = 0;
  for (const call of calls) {
    counts.set(call.name, (counts.get(call.name) || 0) + 1);
    if (run && run === call.runId && pending.has(call.status)) active = call;
    else if (exceptional.has(call.status) || pending.has(call.status)) incomplete++;
  }
  const summary = Array.from(counts, ([name, count]) => actions.get(name) + ' ' + count + ' 次').join('、');
  const current = active && [actions.get(active.name), target(active)].filter(Boolean).join(' · ');
  return <section className="file-activity">
    <button type="button" className="activity-heading" aria-expanded={open}
      onClick={() => { onInspect(); setOpen(!open); }}>
      <FolderSearch size={16}/><span>{summary}</span>
      {incomplete > 0 && <small className="activity-warning">{incomplete} 项未成功</small>}
      <ChevronRight size={14} className="activity-chevron"/>
    </button>
    {current && <div className="activity-current" title={current}>进行中 · {current}</div>}
    {open && <div className="activity-list">
      {calls.map((call, index) => <ActivityCall key={call.id || index} call={call} onInspect={onInspect}/>)}
    </div>}
  </section>;
}

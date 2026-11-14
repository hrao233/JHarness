import React, { useEffect, useRef, useState } from 'react';
import { ArrowUp, Check, ChevronDown, ChevronRight, FileText, FolderOpen, Hand, Image, Paperclip, Plus,
  Puzzle, RotateCcw, ShieldAlert, ShieldCheck, Square, X, Zap } from 'lucide-react';

const permissionOptions = [
  { id: 'ask', label: '请求批准', description: '每次修改或创建项目文件前询问', Icon: Hand },
  { id: 'assist', label: '帮我批准', description: '用当前模型单独审查拟议改动。审查不确定时由你决定', Icon: ShieldCheck },
  { id: 'full', label: '完全访问权限', description: '允许项目内的可用文件操作，无需逐次批准', Icon: ShieldAlert }
];
export const effortLabels = { default: '默认', none: '关闭', minimal: '最低', low: '低', medium: '中',
  high: '高', xhigh: '很高', max: '极高' };
const partIcons = { file: FileText, folder: FolderOpen, image: Image, skill: FileText, plugin: Puzzle };

export function Composer({ draft, setDraft, project, loading, run, send, stop, parts, remove, attach,
    availableParts, loadParts, addPart, permission, setPermission, models, modelId, model,
    defaultModelId, effort, setEffort, fast, setFast, selectModel, settings }) {
  const [menu, setMenu] = useState(null);
  const box = useRef(null);
  const choice = permissionOptions.find(option => option.id === permission) || permissionOptions[1];
  const levels = model?.effortLevels || ['default'];
  const tick = Math.max(0, levels.indexOf(effort));

  useEffect(() => {
    function dismiss(event) {
      if (!box.current?.contains(event.target)) setMenu(null);
    }
    function keydown(event) {
      if (event.key === 'Escape' && menu) {
        setMenu(null);
        box.current?.querySelector('[aria-expanded="true"]')?.focus();
      }
      if (event.ctrlKey && event.shiftKey && event.code === 'KeyM' && !event.repeat
          && !document.querySelector('dialog[open]') && !run) {
        event.preventDefault();
        setMenu(current => current === 'reasoning' || current === 'models' ? null : 'reasoning');
      }
    }
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', keydown);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('keydown', keydown);
    };
  }, [menu, run]);

  useEffect(() => setMenu(null), [project?.id, run]);

  function toggle(next) {
    setMenu(menu === next ? null : next);
    if (next === 'add' && menu !== 'add') void loadParts();
  }

  function chooseFile(kind) {
    setMenu(null);
    void attach(kind);
  }

  return <form className="composer" ref={box} onSubmit={event => { setMenu(null); void send(event); }}>
    {!!parts.length && <div className="attachment-list">{parts.map(part => {
      const Icon = partIcons[part.kind];
      return <span className="attachment" key={part.id || part.kind + part.source} title={part.source || part.name}>
        <Icon size={15}/><span>{part.name}</span>
        <button type="button" aria-label={'移除 ' + part.name} disabled={!!run} onClick={() => remove(part)}><X size={14}/></button>
      </span>;
    })}</div>}
    <textarea rows="2" maxLength={16000} value={draft} placeholder={project ? '和 JHarness 一起工作' : '先打开项目文件夹'}
      aria-label="消息" disabled={!project || loading} readOnly={!!run} onChange={event => setDraft(event.target.value)}
      onKeyDown={event => {
        if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
          setMenu(null);
          void send(event);
        }
      }}/>
    <div className="compose-actions">
      <div className="action-group">
        <div className="menu-anchor">
          <button type="button" className="compose-button icon-button" title="添加文件、Skill 或插件" aria-label="添加文件、Skill 或插件"
            aria-expanded={menu === 'add'} disabled={!project || !!run} onClick={() => toggle('add')}><Plus size={21}/></button>
          {menu === 'add' && <div className="popover add-menu" aria-label="添加">
            <div className="menu-label">添加</div>
            <button type="button" className="menu-row" onClick={() => chooseFile('file')}><Paperclip size={17}/>文件</button>
            <button type="button" className="menu-row" onClick={() => chooseFile('folder')}><FolderOpen size={17}/>文件夹</button>
            {['skill', 'plugin'].map(kind => {
              const entries = availableParts?.filter(part => part.kind === kind);
              const Icon = partIcons[kind];
              return <React.Fragment key={kind}>
                <div className="menu-label">{kind === 'skill' ? 'Skills' : '插件'}</div>
                {entries?.length ? entries.map(part => <button type="button" className="menu-row" key={part.source}
                  onClick={() => { addPart(part); setMenu(null); }}><Icon size={17}/>{part.name}</button>)
                  : <div className="menu-empty">{entries ? '当前项目暂无可用' + (kind === 'skill' ? ' Skill' : '插件') : '正在加载…'}</div>}
              </React.Fragment>;
            })}
          </div>}
        </div>
        <div className="menu-anchor">
          <button type="button" className="compose-button permission-button" disabled={!!run}
            aria-expanded={menu === 'permission'} onClick={() => toggle('permission')}>
            <choice.Icon size={17}/>{choice.label}
          </button>
          {menu === 'permission' && <div className="popover permission-menu" aria-label="选择审批方式">
            <div className="menu-label">应如何批准文件操作？</div>
            {permissionOptions.map(({ id, label, description, Icon }) =>
              <button type="button" className={'menu-row mode-' + id} key={id} aria-pressed={id === permission}
                onClick={() => { setPermission(id); setMenu(null); }}>
                <Icon size={19}/><span className="menu-copy">{label}<small>{description}</small></span>
                {id === permission && <Check size={18}/>}
              </button>)}
          </div>}
        </div>
      </div>
      <div className="action-group">
        {!!model && <div className="menu-anchor">
          <button type="button" className="compose-button icon-button speed-button"
            title={fast ? '快速模式已开启' : '设置生成速度'} aria-label="设置生成速度"
            aria-expanded={menu === 'speed'} aria-pressed={fast} disabled={!!run} onClick={() => toggle('speed')}>
            <Zap size={17}/>
          </button>
          {menu === 'speed' && <div className="popover speed-menu right-menu" aria-label="生成速度">
            <div className="menu-label">生成速度</div>
            <button type="button" className="menu-row" aria-pressed={!fast}
              onClick={() => { setFast(false); setMenu(null); }}>
              <span className="menu-copy">标准<small>使用服务商的默认处理档位</small></span>{!fast && <Check size={17}/>}
            </button>
            {model.fastTier ? <button type="button" className="menu-row" aria-pressed={fast}
              onClick={() => { setFast(true); setMenu(null); }}>
              <span className="menu-copy">快速<small>请求服务商快速档位，可能有额外用量费用</small></span>{fast && <Check size={17}/>}
            </button> : <div className="menu-empty">{model.provider === 'deepseek'
              ? 'DeepSeek 官方接口未提供独立快速档位。'
              : '到模型设置配置服务商支持的快速档位。'}</div>}
          </div>}
        </div>}
        <div className="menu-anchor">
          <button type="button" className="compose-button model-button" title="选择推理强度（Ctrl+Shift+M）"
            disabled={!!run} aria-expanded={menu === 'reasoning' || menu === 'models'}
            onClick={() => {
              if (menu === 'models') setMenu(null);
              else toggle(model ? 'reasoning' : 'models');
            }}>
            <span className="model-name">{model?.model || '选择模型'}</span>
            {levels.length > 1 && <span className="effort-label">{effortLabels[levels[tick]]}</span>}<ChevronDown size={14}/>
          </button>
          {menu === 'reasoning' && <div className="popover reasoning-menu right-menu" aria-label="选择推理强度">
            <div className="reasoning-head"><span/><strong>{levels.length > 1 ? effortLabels[levels[tick]] : '模型默认'}</strong>
              <button type="button" title="恢复默认推理强度" aria-label="恢复默认推理强度" disabled={!model || tick === 0}
                onClick={() => setEffort('default')}><RotateCcw size={17}/></button>
            </div>
            <button type="button" className="model-picker-link" onClick={() => setMenu('models')}>
              {model?.model || '选择模型'}<ChevronRight size={15}/>
            </button>
            {levels.length > 1 ? <div className="reasoning-slider">
              <input type="range" min="0" max={levels.length - 1} step="1" value={tick}
                aria-label="推理强度" aria-valuetext={effortLabels[levels[tick]]}
                style={{ '--progress': (tick * 100 / (levels.length - 1)) + '%' }}
                onChange={event => setEffort(levels[Number(event.target.value)])}/>
              <div className="slider-labels"><span>默认</span><span>{effortLabels[levels.at(-1)]}</span></div>
            </div> : <p className="menu-empty">此配置使用模型默认推理强度。</p>}
          </div>}
          {menu === 'models' && <div className="popover model-menu right-menu" aria-label="选择模型">
            <div className="menu-label">选择模型</div>
            {!!models.length && <button type="button" className="menu-row" aria-pressed={!modelId}
              onClick={() => { selectModel(''); setMenu('reasoning'); }}>
              <span className="menu-copy">默认<small>{models.find(value => value.id === defaultModelId)?.model}</small></span>
              {!modelId && <Check size={17}/>}
            </button>}
            {models.map(value => <button type="button" className="menu-row" key={value.id} aria-pressed={modelId === value.id}
              onClick={() => { selectModel(value.id); setMenu('reasoning'); }}>
              <span className="menu-copy">{value.model}<small>{value.provider === 'deepseek' ? 'DeepSeek 官方' : value.baseUrl}</small></span>
              {modelId === value.id && <Check size={17}/>}
            </button>)}
            <button type="button" className="menu-row" onClick={() => { setMenu(null); settings(); }}><Plus size={17}/>管理模型</button>
          </div>}
        </div>
        {run ? <button type="button" className="send" aria-label="停止" onClick={stop}><Square size={14}/></button>
          : <button type="submit" className="send" aria-label="发送" disabled={!project || (!draft.trim() && !parts.length) || loading}>
            <ArrowUp size={20}/>
          </button>}
      </div>
    </div>
  </form>;
}

export function ApprovalCard({ item, decide }) {
  return <div className="approval-card" role="alert">
    <div className="approval-title"><ShieldAlert size={18}/><strong>{item.operation === 'create_file' ? '创建文件' : '编辑文件'}</strong>
      <code>{item.path}</code></div>
    <details><summary>查看变更内容</summary>
      {!!item.before && <pre className="before">{item.before}</pre>}
      <pre className="after">{item.after || '（移除选中的原文）'}</pre>
    </details>
    <div className="approval-actions">
      <button className="secondary" onClick={() => decide(item.id, false)}>拒绝</button>
      <button className="primary" onClick={() => decide(item.id, true)}>批准这一次</button>
    </div>
  </div>;
}

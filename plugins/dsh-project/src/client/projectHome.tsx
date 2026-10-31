import { useEffect, useRef, useState } from 'react';
import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client';
import Markdown from 'react-markdown';
import type { ProjectCatalog, ProjectBoard, DiscoveredProject } from '../projectSource.js';
import type { ProjectDocument } from '../documents.js';
import { IssuesPage } from './projectPage.js';
import { request, useProjectData } from './request.js';
import styles from './style.css';

type RpcProps = { rpc: ClientConnectionRpc };
const columns = [['backlog', '待规划'], ['todo', '待开始'], ['in_progress', '进行中'], ['in_review', '待验收'], ['done', '已完成'], ['blocked', '已阻塞'], ['cancelled', '已取消']] as const;
const moves: Record<string, string[]> = {
  backlog: ['todo', 'cancelled'], todo: ['cancelled'], in_progress: ['in_review', 'blocked', 'todo'],
  in_review: ['done', 'todo'], blocked: ['todo'], done: [], cancelled: [],
};

function ErrorNotice({ message, retry }: { message: string; retry: () => void }) {
  return message ? <div className="hp-error" role="alert">{message}<button className="hp-button" onClick={retry}>重试</button></div> : null;
}

export function ProjectPage({ rpc }: RpcProps) {
  const catalog = useProjectData<ProjectCatalog>(rpc, 'projects', {}, true);
  const [selected, setSelected] = useState<string>();
  const [tab, setTab] = useState('board');
  const [search, setSearch] = useState('');
  const [onlyRunning, setOnlyRunning] = useState(false);
  const project = catalog.data?.projects.find(item => item.id === selected);
  const projects = catalog.data?.projects.filter(item =>
    (!onlyRunning || item.running.length > 0) && `${item.name} ${item.path}`.toLocaleLowerCase().includes(search.toLocaleLowerCase())) ?? [];
  const enter = (id: string) => { setTab('board'); setSelected(id); };
  return <div className="hp-root">
    <style>{styles}</style>
    <header className="hp-header">
      <div><div className="hp-eyebrow">DSH / PROJECTS</div>
        {selected && <button className="hp-back" onClick={() => setSelected(undefined)}>← 全部项目</button>}
        <h1>{selected ? project?.name ?? '项目' : '项目空间'}</h1>
        <p>{selected ? project?.path : '从任务执行到文档，掌握每个项目的进展。'}</p>
      </div>
      <div className="hp-header-actions"><span className="hp-live">● 自动同步</span><button className="hp-button" onClick={catalog.refresh}>↻ 刷新</button></div>
    </header>
    <ErrorNotice message={catalog.error} retry={catalog.refresh} />
    {!selected ? <main className="hp-body">
      <section className="hp-home-stats">
        <div><span>全部项目</span><strong>{catalog.data?.projects.length ?? '—'}</strong></div>
        <div><span>运行中的项目</span><strong>{catalog.data?.projects.filter(item => item.running.length).length ?? '—'}</strong></div>
        <div><span>正在运行的会话</span><strong>{catalog.data?.projects.reduce((sum, item) => sum + item.running.length, 0) ?? '—'}</strong></div>
        <div><span>项目任务</span><strong>{catalog.data && catalog.data.projects.every(item => item.taskCount !== null) ? catalog.data.projects.reduce((sum, item) => sum + (item.taskCount ?? 0), 0) : '—'}</strong></div>
      </section>
      <div className="hp-project-toolbar"><h2>我的项目</h2><input aria-label="搜索项目" placeholder="搜索项目名称或路径…" value={search} onChange={e => setSearch(e.target.value)} />
        <label><input type="checkbox" checked={onlyRunning} onChange={e => setOnlyRunning(e.target.checked)} /> 仅运行中</label></div>
      {!catalog.data && !catalog.error && <div className="hp-empty" role="status">正在发现 DSH 项目…</div>}
      {catalog.data && !catalog.data.discoveryAvailable && <p className="hp-error">DSH 工作区与会话服务尚未就绪，暂时无法自动发现项目。</p>}
      <div className="hp-project-grid">{projects.map(item => <button className="hp-project-card" key={item.id} onClick={() => enter(item.id)}>
        <div className="hp-card-heading"><span className="hp-folder">▦</span><span className={`hp-badge ${item.running.length ? 'hp-running' : ''}`}>{item.running.length ? '运行中' : '空闲'}</span></div>
        <h3>{item.name}</h3><p className="hp-path">{item.path}</p>
        {item.issueError && <p className="hp-note">任务读取失败，进入项目查看详情</p>}
        <footer><span>{item.taskCount ?? '—'} 个任务</span><span>{item.running.length} 个运行会话 <b>↗</b></span></footer>
      </button>)}</div>
      {catalog.data && !projects.length && <div className="hp-empty"><strong>{search || onlyRunning ? '没有符合条件的项目' : '还没有 DSH 项目'}</strong><p>在 DSH 中打开工作区或运行项目会话后，这里会自动显示。</p></div>}
    </main> : <>
      <nav className="hp-tabs" aria-label="项目页面">
        {[['board', '任务看板'], ['issues', 'Issues'], ['documents', '文档']].map(([id, label]) =>
          <button key={id} aria-current={tab === id ? 'page' : undefined} onClick={() => setTab(id!)}>{label}</button>)}
        {project && <span>{project.running.length} 个会话运行中</span>}
      </nav>
      <main className="hp-body" key={`${selected}:${tab}`}>
        {catalog.data && !project ? <div className="hp-empty">项目已不在 DSH 列表中。<button className="hp-button" onClick={() => setSelected(undefined)}>返回项目列表</button></div> :
          tab === 'board' ? <BoardPage rpc={rpc} projectId={selected} project={project} /> :
          tab === 'issues' ? <IssuesPage rpc={rpc} projectId={selected} /> :
          <DocumentsPage rpc={rpc} projectId={selected} />}
      </main>
    </>}
  </div>;
}

function BoardPage({ rpc, projectId, project }: RpcProps & { projectId: string; project?: DiscoveredProject }) {
  const board = useProjectData<ProjectBoard>(rpc, 'board', { projectId }, true);
  const [selected, setSelected] = useState<string>();
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const lifetime = useRef(new AbortController());
  const heading = useRef<HTMLHeadingElement>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  useEffect(() => { const controller = new AbortController(); lifetime.current = controller; return () => controller.abort(); }, []);
  useEffect(() => { if (selected) heading.current?.focus(); }, [selected]);
  const task = board.data?.tasks.find(item => item.id === selected);
  const executing = task?.executions.some(run => run.endedAt === undefined);
  const data = board.data;
  const close = () => { setSelected(undefined); trigger.current?.focus(); };
  async function act(action: object) {
    if (busy) return;
    setBusy(true); setError('');
    const signal = lifetime.current.signal;
    try {
      await request(rpc, 'board-action', { projectId, requestId: crypto.randomUUID(), ...action }, signal);
      if (!signal.aborted) { setCreating(false); setTitle(''); setPrompt(''); board.refresh(); }
    } catch (err) {
      if (!signal.aborted) setError(err instanceof Error ? err.message : String(err));
    } finally { if (!signal.aborted) setBusy(false); }
  }
  return <>
    <div className="hp-board-heading"><div><h2>任务看板</h2><p className="hp-muted">与 Issues 共用项目任务 · DSH 运行会话每 5 秒更新</p></div>
      <button className="hp-button hp-primary" disabled={!board.data || busy} onClick={() => setCreating(!creating)}>＋ 新建任务</button></div>
    <ErrorNotice message={board.error} retry={board.refresh} />
    {error && <div role="alert" className="hp-error">{error}</div>}
    {creating && <form className="hp-create" onSubmit={e => { e.preventDefault(); void act({ kind: 'create', title, prompt }); }}>
      <label>任务标题<input required maxLength={200} value={title} onChange={e => setTitle(e.target.value)} /></label>
      <label>执行说明<textarea required rows={4} maxLength={20000} value={prompt} onChange={e => setPrompt(e.target.value)} /></label>
      <div><button className="hp-button" type="button" onClick={() => setCreating(false)}>取消</button><button className="hp-button hp-primary" disabled={busy}>创建任务</button></div>
    </form>}
    {!board.data && !board.error && <p className="hp-empty" role="status">正在读取任务看板…</p>}
    {data && <>
      {!data.canRun && <p className="hp-note">DSH 会话执行服务尚未就绪，可以继续管理任务。</p>}
      <div className="hp-board">{columns.map(([status, label]) => {
        const tasks = data.tasks.filter(item => item.status === status);
        const sessions = status === 'in_progress' ? data.sessions : [];
        return <section className={`hp-column hp-column-${status}`} key={status}><h3><i />{label}<span>{tasks.length + sessions.length}</span></h3>
          {tasks.map(item => <button className="hp-task-card" key={item.id} onClick={event => { trigger.current = event.currentTarget; setSelected(item.id); }}>
            <span className="hp-number">ISS-{item.number}{item.parentId ? ' · 子任务' : ''}</span><strong>{item.title}</strong>
            <p>{item.description || item.prompt}</p><footer>{new Date(item.updatedAt).toLocaleDateString('zh-CN')}<span>查看详情 ↗</span></footer>
          </button>)}
          {sessions.map(session => <article className="hp-task-card hp-session-card" key={session.id}><span className="hp-live">● DSH 运行会话</span><strong>{session.title}</strong><p>{session.id}</p><footer>自动发现 · 实时状态</footer></article>)}
          {!tasks.length && !sessions.length && <div className="hp-column-empty">暂无任务</div>}
        </section>;
      })}</div>
    </>}
    {selected && <aside className="hp-detail" aria-label="看板任务详情" onKeyDown={e => { if (e.key === 'Escape') close(); }}>
      <header><h2 tabIndex={-1} ref={heading}>看板任务详情</h2><button className="hp-button" onClick={close}>关闭 ×</button></header>
      <div className="hp-detail-body">{task ? <>
        <div className="hp-eyebrow">{columns.find(([status]) => status === task.status)?.[1]}</div><h3>{task.title}</h3>
        <section><h4>描述</h4><p className="hp-prose">{task.description || '暂无描述'}</p></section>
        <section><h4>执行说明</h4><p className="hp-prose">{task.prompt || '暂无说明'}</p></section>
        <section><h4>执行记录</h4>{task.executions.length ? task.executions.map((run, i) => <p key={i} className="hp-prose">{run.sessionId ?? '等待建立会话'}{run.error && `\n${run.error}`}</p>) : <p className="hp-muted">尚未执行</p>}</section>
        {task.dispatchError && <p className="hp-error">{task.dispatchError}</p>}
        <p className="hp-note">执行使用 DSH 默认模型和权限。会话结束后，请检查结果并将任务移至待验收。</p>
        {project && <section className="hp-task-actions"><select aria-label="移动任务状态" value={task.status} disabled={busy || executing} onChange={e => void act({ kind: 'move', taskId: task.id, status: e.target.value })}>
          {columns.filter(([value]) => value === task.status || moves[task.status]?.includes(value)).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
          <button className="hp-button hp-primary" disabled={busy || executing || !data?.canRun || task.status !== 'todo'} onClick={() => void act({ kind: 'run', taskId: task.id })}>执行任务</button></section>}
        {error && <p className="hp-error" role="alert">{error}</p>}
      </> : <p>任务已移出看板，或正在刷新。</p>}</div>
    </aside>}
  </>;
}

function DocumentsPage({ rpc, projectId }: RpcProps & { projectId: string }) {
  const docs = useProjectData<{ documents: ProjectDocument[]; truncated: boolean }>(rpc, 'documents', { projectId });
  const [selected, setSelected] = useState<string>();
  const [query, setQuery] = useState('');
  const active = selected ?? docs.data?.documents[0]?.id;
  return <div className="hp-documents">
    <aside className="hp-doc-list"><div className="hp-section-heading"><h2>项目文档</h2><button className="hp-button" onClick={docs.refresh}>刷新</button></div>
      <input aria-label="搜索文档" placeholder="查找文档…" value={query} onChange={e => setQuery(e.target.value)} />
      <ErrorNotice message={docs.error} retry={docs.refresh} />
      {docs.data?.truncated && <p className="hp-note">文档较多，仅列出前 200 篇（最多扫描 8 层目录）。</p>}
      {docs.data?.documents.filter(doc => doc.title.toLocaleLowerCase().includes(query.toLocaleLowerCase())).map(doc =>
        <button className={active === doc.id ? 'hp-active' : ''} key={doc.id} onClick={() => setSelected(doc.id)}><span>{doc.group}</span>{doc.title}</button>)}
    </aside>
    <section className="hp-doc-view">{active ? <DocumentView key={active} rpc={rpc} projectId={projectId} id={active} /> :
      <div className="hp-empty">{docs.data ? <><strong>还没有项目文档</strong><p>项目根目录、docs/ 下的 Markdown，以及 Hadamard 设计文档和计划会显示在这里。</p></> : '正在读取文档目录…'}</div>}</section>
  </div>;
}

function DocumentView({ rpc, projectId, id }: RpcProps & { projectId: string; id: string }) {
  const doc = useProjectData<{ title: string; content: string }>(rpc, 'document', { projectId, id });
  return <><ErrorNotice message={doc.error} retry={doc.refresh} />{doc.data ? <>
    <header><h2>{doc.data.title}</h2><div><span className="hp-badge">只读</span> <button className="hp-button" onClick={doc.refresh}>刷新文档</button></div></header>
    <article className="hp-markdown"><Markdown components={{
      // Never load remote image beacons from project documents.
      img: ({ alt }) => <span className="hp-muted">[图片：{alt || '未命名'}]</span>,
      a: ({ href, children }) => href && /^https?:\/\//i.test(href) ? <a href={href} target="_blank" rel="noreferrer">{children}</a> : <span>{children}</span>,
    }}>{doc.data.content}</Markdown></article>
  </> : !doc.error && <p className="hp-empty" role="status">正在读取文档…</p>}</>;
}

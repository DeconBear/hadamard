import { useEffect, useRef, useState } from 'react';
import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client';
import type { ProjectSnapshot } from '../../../../src/project/projectReader.js';
import type { ProjectIssue } from '../../../../src/issues/issueStore.js';
import type { IssuePage } from '../webApi.js';
import { request } from './request.js';

const statuses: Record<string, string> = {
  backlog: '待规划', todo: '待开始', in_progress: '进行中', in_review: '待验收', done: '已完成', blocked: '已阻塞', cancelled: '已取消',
  not_started: '未开始', planning: '规划中', on_hold: '已暂停', completed: '已完成',
};
const priorities: Record<string, string> = { low: '低', medium: '中', high: '高', urgent: '紧急', none: '无' };
const issueStatuses = ['backlog', 'todo', 'in_progress', 'in_review', 'done', 'blocked', 'cancelled'];
const date = (value: string) => Number.isNaN(Date.parse(value)) ? value : new Date(value).toLocaleString('zh-CN');

function Badge({ value }: { value: string }) {
  return <span className={`hp-badge hp-${value}`}>{statuses[value] ?? value}</span>;
}

export function IssuesPage({ rpc, projectId }: { rpc: ClientConnectionRpc; projectId: string }) {
  const [project, setProject] = useState<ProjectSnapshot>();
  const [page, setPage] = useState<IssuePage>();
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [offset, setOffset] = useState(0);
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<string>();
  const [detail, setDetail] = useState<ProjectIssue | null>();
  const [detailError, setDetailError] = useState('');
  const detailHeading = useRef<HTMLHeadingElement>(null);
  const lastTrigger = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setBusy(true); setError('');
    Promise.all([
      request<ProjectSnapshot>(rpc, 'overview', { projectId }, controller.signal),
      request<IssuePage>(rpc, 'issues', { projectId, query: search, status, offset, limit: 20 }, controller.signal),
    ]).then(([nextProject, nextPage]) => {
      if (controller.signal.aborted) return;
      if (offset > 0 && offset >= nextPage.total) {
        setOffset(Math.max(0, Math.floor((nextPage.total - 1) / 20) * 20));
        return;
      }
      setProject(nextProject); setPage(nextPage);
    }).catch(err => {
      if (!controller.signal.aborted) setError(err.message);
    }).finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [rpc, projectId, search, status, offset, revision]);

  useEffect(() => {
    if (!selected) return;
    const controller = new AbortController();
    setDetail(undefined); setDetailError('');
    detailHeading.current?.focus();
    request<ProjectIssue | null>(rpc, 'issue', { projectId, id: selected }, controller.signal)
      .then(value => { if (!controller.signal.aborted) setDetail(value); })
      .catch(err => { if (!controller.signal.aborted) setDetailError(err.message); });
    return () => controller.abort();
  }, [rpc, projectId, selected, revision]);

  function closeDetail() {
    setSelected(undefined);
    lastTrigger.current?.focus();
  }

  return <div className="hp-issue-content">
      <section className="hp-overview" aria-label="项目概览">
        <div className="hp-project-title"><div><h2>{project?.name ?? '当前项目'}</h2><p className="hp-path">{project?.path ?? '正在读取项目信息…'}</p></div>
          {project && <Badge value={project.status} />}</div>
        <div className="hp-stats">
          {([['全部任务', project?.issueCounts.total], ['未关闭', project?.issueCounts.open], ['待验收', project?.issueCounts.review], ['已关闭', project?.issueCounts.closed]] as const)
            .map(([label, count]) => <div key={label}><span>{label}</span><strong>{count ?? '—'}</strong></div>)}
        </div>
        <div className="hp-note">与任务看板共用数据 · 在看板中创建和更新任务{project?.updatedAt && ` · 更新于 ${date(project.updatedAt)}`}</div>
      </section>
      <section className="hp-issues" aria-label="项目任务">
        <div className="hp-section-heading"><h2>Issues <span>{page?.total ?? '—'}</span></h2>
          <button className="hp-button" onClick={() => setRevision(value => value + 1)} disabled={busy}>刷新</button></div>
        <div className="hp-toolbar">
          <form onSubmit={event => { event.preventDefault(); setSearch(query.trim()); setOffset(0); }}>
            <input aria-label="搜索任务" placeholder="搜索标题、编号或标签…" value={query} maxLength={200} onChange={event => setQuery(event.target.value)} />
            <button className="hp-button" type="submit">搜索</button>
          </form>
          <select aria-label="任务状态" value={status} onChange={event => { setStatus(event.target.value); setOffset(0); }}>
            <option value="">全部状态</option>{issueStatuses.map(value => <option key={value} value={value}>{statuses[value]}</option>)}
          </select>
        </div>
        {error && <div role="alert" className="hp-error">读取失败：{error}<button className="hp-button" onClick={() => setRevision(value => value + 1)}>重试</button></div>}
        <div aria-busy={busy}>
          {busy ? <div className="hp-empty" role="status">正在加载项目任务…</div> : !error && page && (
            page.issues.length ? <div className="hp-table-wrap"><table>
              <thead><tr><th>任务</th><th>状态</th><th>优先级</th><th>更新时间</th></tr></thead>
              <tbody>{page.issues.map(issue => <tr key={issue.id} className={selected === issue.id ? 'hp-selected' : ''}>
                <td><button className="hp-issue-link" onClick={event => {
                  lastTrigger.current = event.currentTarget;
                  if (selected !== issue.id) { setDetail(undefined); setDetailError(''); setSelected(issue.id); }
                }}><span className="hp-number">ISS-{issue.number}</span><strong>{issue.title}</strong></button>
                  {issue.labels.length > 0 && <div className="hp-labels">{issue.labels.map((label, index) => <span key={index}>{label}</span>)}</div>}</td>
                <td><Badge value={issue.status} /></td><td><span className={`hp-priority hp-${issue.priority}`}>{priorities[issue.priority] ?? issue.priority}</span></td>
                <td className="hp-date">{date(issue.updatedAt)}</td>
              </tr>)}</tbody>
            </table></div> : <div className="hp-empty"><strong>{search || status ? '没有匹配的任务' : '项目中还没有任务'}</strong><p>{search || status ? '试试其他关键词或状态。' : '在任务看板中创建任务后，这里会同步显示。'}</p>
              {(search || status) && <button className="hp-button" onClick={() => { setQuery(''); setSearch(''); setStatus(''); setOffset(0); }}>清除筛选</button>}</div>
          )}
        </div>
        {page && !error && <footer className="hp-pagination"><span>共 {page.total} 项{page.total > 0 && ` · ${page.offset + 1}–${page.offset + page.issues.length}`}</span>
          <div><button className="hp-button" disabled={busy || offset === 0} onClick={() => setOffset(Math.max(0, offset - 20))}>上一页</button>
            <button className="hp-button" disabled={busy || offset + page.limit >= page.total} onClick={() => setOffset(offset + page.limit)}>下一页</button></div>
        </footer>}
      </section>
    {selected && <aside className="hp-detail" aria-label="任务详情" onKeyDown={event => { if (event.key === 'Escape') closeDetail(); }}>
      <header><h2 ref={detailHeading} tabIndex={-1}>任务详情</h2><button className="hp-button" aria-label="关闭任务详情" onClick={closeDetail}>关闭 ×</button></header>
      <div className="hp-detail-body">
        {detailError ? <div role="alert" className="hp-error">{detailError}<button className="hp-button" onClick={() => setRevision(value => value + 1)}>重试</button></div> :
          detail === undefined ? <p role="status">正在加载详情…</p> :
          detail === null ? <div className="hp-empty">任务已不存在，请刷新列表。</div> : <>
            <div className="hp-eyebrow">ISS-{detail.number}</div><h3>{detail.title}</h3>
            <div className="hp-detail-badges"><Badge value={detail.status} /><span>优先级：{priorities[detail.priority] ?? detail.priority}</span></div>
            <div className="hp-labels">{detail.labels.map((label, index) => <span key={index}>{label}</span>)}</div>
            <section><h4>任务描述</h4><p className="hp-prose">{detail.description || '暂无描述'}</p></section>
            <section><h4>验收标准 <span>{detail.acceptanceCriteria.length}</span></h4>{detail.acceptanceCriteria.length ?
              <ul className="hp-criteria">{detail.acceptanceCriteria.map((criterion, index) => <li key={index}>{criterion}</li>)}</ul> : <p className="hp-muted">暂无验收标准</p>}</section>
            <section><h4>动态与评论 <span>{detail.comments.length}</span></h4>{detail.comments.length ? detail.comments.map(comment =>
              <article className="hp-comment" key={comment.id}><div><strong>{comment.actor}</strong><time>{date(comment.createdAt)}</time></div>
                {comment.fromStatus && comment.toStatus && <p>{statuses[comment.fromStatus]} → {statuses[comment.toStatus]}</p>}<p className="hp-prose">{comment.body}</p></article>) : <p className="hp-muted">暂无动态</p>}</section>
            <section><h4>任务信息</h4><dl>
              <dt>创建时间</dt><dd>{date(detail.createdAt)}</dd><dt>更新时间</dt><dd>{date(detail.updatedAt)}</dd>
              <dt>创建者</dt><dd>{detail.createdBy}</dd>
              {detail.startedAt && <><dt>开始时间</dt><dd>{date(detail.startedAt)}</dd></>}
              {detail.completedAt && <><dt>完成时间</dt><dd>{date(detail.completedAt)}</dd></>}
              {detail.agentConfig && <><dt>执行配置</dt><dd>{detail.agentConfig}</dd></>}
              {detail.activeSessionId && <><dt>当前会话</dt><dd>{detail.activeSessionId}</dd></>}
              {detail.parentIssueId && <><dt>父任务</dt><dd>{detail.parentIssueId}</dd></>}
              {detail.sessionIds.length > 0 && <><dt>关联会话</dt><dd>{detail.sessionIds.join('\n')}</dd></>}
            </dl></section>
            {detail.brief && <section><h4>任务简报</h4><p className="hp-prose">{detail.brief}</p></section>}
            {Object.keys(detail.metadata).length > 0 && <details><summary>附加信息</summary><pre>{JSON.stringify(detail.metadata, null, 2)}</pre></details>}
          </>}
      </div>
    </aside>}
  </div>;
}

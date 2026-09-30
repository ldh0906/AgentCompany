import { useState } from 'react';
import { Link, useCompany } from '../App.tsx';
import { useT } from '../i18n.ts';
import { Avatar, EmptyState, empName, HoldChip, Icon, needsCeo, Skeleton, when } from '../components/ui.tsx';
import { fmtTokens } from '../components/usage.tsx';

const COLUMNS: { key: string; statuses: string[]; dot: string; ko: string; en: string }[] = [
  {
    key: 'todo',
    statuses: ['received', 'analyzing', 'backlog', 'assigned'],
    dot: '#858da3',
    ko: '배정을 기다리거나 시작 전',
    en: 'Waiting to be assigned or started',
  },
  {
    key: 'in_progress',
    statuses: ['in_progress'],
    dot: '#5cc8ff',
    ko: '직원이 격리된 작업공간에서 작업 중',
    en: 'An employee is working in an isolated worktree',
  },
  {
    key: 'verifying',
    statuses: ['verifying', 'in_review'],
    dot: '#8b8cff',
    ko: '시스템 검증 → 다른 직원의 독립 검수',
    en: 'System verification, then independent review',
  },
  {
    key: 'changes_requested',
    statuses: ['changes_requested'],
    dot: '#b48cff',
    ko: '검수에서 돌아와 다시 작업',
    en: 'Sent back by the reviewer',
  },
  {
    key: 'awaiting_approval',
    statuses: ['awaiting_approval', 'integrating'],
    dot: '#f5b546',
    ko: '대표님 차례: 승인하면 반영',
    en: 'Your turn: approve to integrate',
  },
  { key: 'done', statuses: ['done'], dot: '#3dd9a0', ko: '내 폴더에 반영됨', en: 'Integrated into your repository' },
  { key: 'failed', statuses: ['failed', 'cancelled'], dot: '#ff6b81', ko: '실패하거나 취소됨', en: 'Failed or cancelled' },
];
const LIVE = ['in_progress', 'verifying', 'in_review', 'integrating'];

export function Board({ onNewTicket }: { onNewTicket?: () => void }) {
  const { state } = useCompany();
  const { t, status, lang, difficulty } = useT();
  const [q, setQ] = useState('');
  const [who, setWho] = useState('');
  const [project, setProject] = useState('');
  if (!state) return <Skeleton />;
  const ko = lang === 'ko';
  const label = (k: string) =>
    k === 'verifying' ? (ko ? '검증·검수' : 'Verify · review') : k === 'todo' ? (ko ? '할 일' : 'To do') : status(k);
  const usage = state.usage;
  const tickets = state.tickets.filter(
    (x) =>
      (!q || `${x.id} ${x.title}`.toLowerCase().includes(q.toLowerCase())) &&
      (!who || x.assigneeId === who || x.reviewerId === who || x.ownerId === who) &&
      (!project || x.projectId === project),
  );
  const open = state.tickets.filter((x) => !['done', 'failed', 'cancelled'].includes(x.status)).length;
  const yourTurn = state.tickets.filter((x) => x.status === 'awaiting_approval' || needsCeo(x)).length;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{t('nav_board')}</h1>
          <div className="sub">
            {ko
              ? '카드는 상태기계가 옮깁니다. 직원의 말이 아니라 증거로 움직입니다.'
              : 'Cards move by the state machine, on evidence, not on claims.'}
          </div>
        </div>
        {onNewTicket && state.projects.length > 0 && (
          <button className="btn primary" onClick={onNewTicket}>
            <Icon name="plus" /> {t('newTicket')}
          </button>
        )}
      </div>

      <div className="board-bar">
        <div className="board-kpis">
          <span>
            <b>{state.tickets.length}</b> {ko ? '전체' : 'total'}
          </span>
          <span>
            <b>{open}</b> {ko ? '진행' : 'open'}
          </span>
          <span className={yourTurn ? 'hot' : ''}>
            <b>{yourTurn}</b> {ko ? '대표 차례' : 'need you'}
          </span>
          {usage && (
            <span title={ko ? '오늘 토큰 사용량' : "Today's token usage"}>
              <Icon name="spark" size={13} /> <b>{fmtTokens(usage.today.total, lang)}</b> {ko ? '오늘' : 'today'}
            </span>
          )}
        </div>
        <div className="board-filters">
          <input className="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={ko ? '업무 검색…' : 'Search tickets…'} />
          <select value={who} onChange={(e) => setWho(e.target.value)}>
            <option value="">{ko ? '모든 직원' : 'Everyone'}</option>
            {state.employees
              .filter((e) => !e.removedAt)
              .map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
          </select>
          {state.projects.length > 1 && (
            <select value={project} onChange={(e) => setProject(e.target.value)}>
              <option value="">{ko ? '모든 프로젝트' : 'All projects'}</option>
              {state.projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>

      {state.tickets.length === 0 ? (
        <div className="card">
          <EmptyState icon="board">
            <div style={{ color: 'var(--text)', fontWeight: 600, fontSize: 14 }}>{ko ? '아직 업무가 없습니다' : 'No tickets yet'}</div>
            <div style={{ marginTop: 4, maxWidth: 520 }}>
              {ko
                ? '업무를 만들면 할 일 → 작업 중 → 검증·검수 → 대표 승인 대기 → 완료로 움직입니다. 대표님은 승인만 하시면 됩니다.'
                : 'Tickets move To do → Working → Verify · review → Awaiting you → Done. You only approve.'}
            </div>
            {onNewTicket && state.projects.length > 0 && (
              <button className="btn primary" style={{ marginTop: 14 }} onClick={onNewTicket}>
                <Icon name="plus" /> {t('newTicket')}
              </button>
            )}
          </EmptyState>
        </div>
      ) : (
        <div className="board">
          {COLUMNS.map((c) => {
            const items = tickets.filter((x) => c.statuses.includes(x.status));
            if (c.key === 'failed' && items.length === 0) return null;
            return (
              <div className="column" key={c.key} style={{ '--dot': c.dot } as React.CSSProperties}>
                <h3>
                  <span className="dot" />
                  {label(c.key)} <span className="n">{items.length}</span>
                </h3>
                <div className="col-desc">{ko ? c.ko : c.en}</div>
                {items.length === 0 && <div className="empty-col">{ko ? '비어 있음' : 'Empty'}</div>}
                {items.map((x) => {
                  const tokens = usage?.byTicket[x.id]?.total ?? 0;
                  const live = LIVE.includes(x.status) && !x.hold;
                  return (
                    <Link to={`/tickets/${x.id}`} className={`tcard ${live ? 'is-live' : ''} ${x.hold ? 'held' : ''}`} key={x.id}>
                      <div className="spread">
                        <span className="id">
                          {live && <span className="live-dot" />}
                          {x.id}
                        </span>
                        <span className="chip">{x.type}</span>
                      </div>
                      <div className="ttl">{x.title}</div>
                      <div className="tmeta">
                        {x.difficulty && x.difficulty !== 'normal' && (
                          <span className={`chip ${x.difficulty === 'hard' ? 'warn' : ''}`}>{difficulty(x.difficulty)}</span>
                        )}
                        {x.round > 1 && <span className="chip accent">{`R${x.round}`}</span>}
                        {x.reviewBelowRank && <span className="chip warn">{ko ? '하위 검수' : 'Lower review'}</span>}
                        <span title={ko ? '요구사항' : 'Requirements'}>
                          <Icon name="check" size={12} /> {x.requirements.length}
                        </span>
                        {tokens > 0 && (
                          <span title={ko ? '이 업무의 토큰 사용량' : 'Tokens used by this ticket'}>
                            <Icon name="spark" size={12} /> {fmtTokens(tokens, lang)}
                          </span>
                        )}
                        <span title={x.updatedAt}>
                          <Icon name="activity" size={12} /> {when(x.updatedAt)}
                        </span>
                      </div>
                      <div className="people">
                        <Avatar employees={state.employees} id={x.assigneeId} />
                        <span className="name">{x.assigneeId ? empName(state.employees, x.assigneeId) : ko ? '미배정' : 'Unassigned'}</span>
                        {x.reviewerId && (
                          <>
                            <span className="arrow">→</span>
                            <Avatar employees={state.employees} id={x.reviewerId} />
                          </>
                        )}
                      </div>
                      {x.hold && (
                        <div style={{ marginTop: 8 }}>
                          <HoldChip ticket={x} />
                        </div>
                      )}
                    </Link>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

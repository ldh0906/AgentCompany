import { Link, useCompany } from '../App.tsx';
import { useT } from '../i18n.ts';
import { Avatar, empName, HoldChip, Skeleton } from '../components/ui.tsx';

const COLUMNS: { key: string; statuses: string[]; dot: string }[] = [
  { key: 'todo', statuses: ['received', 'analyzing', 'backlog', 'assigned'], dot: '#858da3' },
  { key: 'in_progress', statuses: ['in_progress'], dot: '#5cc8ff' },
  { key: 'verifying', statuses: ['verifying', 'in_review'], dot: '#8b8cff' },
  { key: 'changes_requested', statuses: ['changes_requested'], dot: '#b48cff' },
  { key: 'awaiting_approval', statuses: ['awaiting_approval', 'integrating'], dot: '#f5b546' },
  { key: 'done', statuses: ['done'], dot: '#3dd9a0' },
  { key: 'failed', statuses: ['failed', 'cancelled'], dot: '#ff6b81' },
];

export function Board() {
  const { state } = useCompany();
  const { t, status, lang, difficulty } = useT();
  if (!state) return <Skeleton />;
  const label = (k: string) =>
    k === 'verifying' ? (lang === 'ko' ? '검증·검수' : 'Verify · review') : k === 'todo' ? (lang === 'ko' ? '할 일' : 'To do') : status(k);

  return (
    <>
      <div className="page-head">
        <h1>{t('nav_board')}</h1>
        <div className="sub">
          {lang === 'ko'
            ? '카드는 상태기계가 옮깁니다. 직원의 말이 아니라 증거로 움직입니다.'
            : 'Cards move by the state machine, on evidence, not on claims.'}
        </div>
      </div>
      <div className="board">
        {COLUMNS.map((c) => {
          const items = state.tickets.filter((x) => c.statuses.includes(x.status));
          if (c.key === 'failed' && items.length === 0) return null; // 실패·취소 열은 있을 때만
          return (
            <div className="column" key={c.key} style={{ '--dot': c.dot } as React.CSSProperties}>
              <h3>
                <span className="dot" />
                {label(c.key)} <span className="n">{items.length}</span>
              </h3>
              {items.length === 0 && <div className="empty-col" />}
              {items.map((x) => (
                <Link to={`/tickets/${x.id}`} className="tcard" key={x.id}>
                  <div className="spread">
                    <span className="id">{x.id}</span>
                    <span className="row" style={{ gap: 4 }}>
                      {x.difficulty && x.difficulty !== 'normal' && (
                        <span className={`chip ${x.difficulty === 'hard' ? 'warn' : ''}`}>{difficulty(x.difficulty)}</span>
                      )}
                      {x.round > 1 && <span className="chip accent">{`R${x.round}`}</span>}
                      <span className="chip">{x.type}</span>
                    </span>
                  </div>
                  <div className="ttl">{x.title}</div>
                  <div className="people">
                    <Avatar employees={state.employees} id={x.assigneeId} />
                    <span className="name">{empName(state.employees, x.assigneeId)}</span>
                    <span className="arrow">→</span>
                    <Avatar employees={state.employees} id={x.reviewerId} />
                  </div>
                  {x.hold && (
                    <div style={{ marginTop: 6 }}>
                      <HoldChip ticket={x} />
                    </div>
                  )}
                </Link>
              ))}
            </div>
          );
        })}
      </div>
    </>
  );
}

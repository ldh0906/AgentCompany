import { Link, useCompany } from '../App.tsx';
import { useT } from '../i18n.ts';
import { empName, HoldChip } from '../components/ui.tsx';

const COLUMNS: { key: string; statuses: string[] }[] = [
  { key: 'backlog', statuses: ['received', 'analyzing', 'backlog'] },
  { key: 'assigned', statuses: ['assigned'] },
  { key: 'in_progress', statuses: ['in_progress'] },
  { key: 'verifying', statuses: ['verifying', 'in_review'] },
  { key: 'changes_requested', statuses: ['changes_requested'] },
  { key: 'awaiting_approval', statuses: ['awaiting_approval', 'integrating'] },
  { key: 'done', statuses: ['done'] },
  { key: 'failed', statuses: ['failed', 'cancelled'] },
];

export function Board() {
  const { state } = useCompany();
  const { t, status, lang } = useT();
  if (!state) return <div className="emptystate">{t('loading')}</div>;
  const label = (k: string) => (k === 'verifying' ? (lang === 'ko' ? '검증·검수' : 'Verify · review') : status(k));

  return (
    <>
      <div className="page-head">
        <h1>{t('nav_board')}</h1>
        <div className="sub">{lang === 'ko' ? '카드는 상태기계가 옮깁니다. 직원의 말이 아니라 증거로 움직입니다.' : 'Cards move by the state machine, on evidence, not on claims.'}</div>
      </div>
      <div className="board">
        {COLUMNS.map((c) => {
          const items = state.tickets.filter((x) => c.statuses.includes(x.status));
          return (
            <div className="column" key={c.key}>
              <h3>
                {label(c.key)} <span>{items.length}</span>
              </h3>
              {items.map((x) => (
                <Link to={`/tickets/${x.id}`} className="tcard" key={x.id}>
                  <div className="spread">
                    <span className="id">{x.id}</span>
                    <span className="chip">{x.type}</span>
                  </div>
                  <div className="ttl">{x.title}</div>
                  <div className="people">
                    {empName(state.employees, x.assigneeId)} → {empName(state.employees, x.reviewerId)}
                    {x.round > 1 && ` · ${t('round')} ${x.round}`}
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

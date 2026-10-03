// 할 일: 대표 차례인 일만 한 화면에. 대표 요청(2026-10-03): "대표가 할 일들 화면이 너무 읽기 불친절하다. 불필요하게 나열된 정보도 많고".
// 참고: Linear Inbox·GitHub Notifications처럼 한 줄에 하나(무엇·왜·언제), 종류별로 묶고, 바로 할 수 있는 일은 그 줄에서.
// 보류 메모 원문(경로·이유 문장)은 여기서 보여 주지 않는다: 줄을 누르면 업무 화면에서 자세히 본다.
import { api } from '../api.ts';
import { useCompany } from '../App.tsx';
import { useT } from '../i18n.ts';
import { EmptyState, Skeleton, useAction } from '../components/ui.tsx';
import { TODO_GROUPS, TodoRow } from '../components/inbox.tsx';

export function Inbox() {
  const { state, reload } = useCompany();
  const { lang } = useT();
  const { busy, run } = useAction();
  if (!state) return <Skeleton />;
  const ko = lang === 'ko';
  const todos = state.ceoTodos ?? [];

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{ko ? '할 일' : 'Inbox'}</h1>
          <div className="sub">
            {ko ? '대표 차례인 일만 모았습니다. 줄을 누르면 자세히 볼 수 있습니다.' : 'Only what needs you. Click a row for details.'}
          </div>
        </div>
      </div>
      {todos.length === 0 && (
        <div className="card">
          <EmptyState icon="inbox">{ko ? '지금 대표가 할 일은 없습니다.' : 'Nothing needs you right now.'}</EmptyState>
        </div>
      )}
      {TODO_GROUPS.map((g) => {
        const items = todos.filter((x) => g.kinds.includes(x.kind));
        if (!items.length) return null;
        return (
          <div className="card inbox-group" key={g.key}>
            <h2>
              <span className="row">
                {ko ? g.ko : g.en} <span className="chip">{items.length}</span>
              </span>
              <span className="sub">{ko ? g.hint[0] : g.hint[1]}</span>
            </h2>
            <div className="list">
              {items.map((x) => (
                <TodoRow key={x.key} x={x} />
              ))}
            </div>
            {g.key === 'later' && items.length > 1 && (
              <div className="row inbox-bulk">
                <button
                  className="btn small"
                  disabled={busy}
                  onClick={() =>
                    confirm(ko ? '나중에 확인 항목을 모두 "확인했어요"로 기록할까요?' : 'Mark all as confirmed?') &&
                    run(() => api('later-checks', { body: { mode: 'ok' } })).then(reload)
                  }
                >
                  {ko ? '모두 확인했어요' : 'All confirmed'}
                </button>
                <button
                  className="btn small"
                  disabled={busy}
                  title={ko ? '확인한 척 기록하지 않고 목록에서만 뺍니다' : 'Remove without recording a confirmation'}
                  onClick={() =>
                    confirm(ko ? '확인하지 않고 모두 목록에서 뺄까요?' : 'Dismiss all?') &&
                    run(() => api('later-checks', { body: { mode: 'dismiss' } })).then(reload)
                  }
                >
                  {ko ? '모두 버리기' : 'Dismiss all'}
                </button>
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}

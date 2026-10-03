// 할 일: 대표 차례인 일만 한 화면에. 대표 요청(2026-10-03): "대표가 할 일들 화면이 너무 읽기 불친절하다. 불필요하게 나열된 정보도 많고".
// 참고: Linear Inbox·GitHub Notifications처럼 한 줄에 하나(무엇·왜·언제), 종류별로 묶고, 바로 할 수 있는 일은 그 줄에서.
// 보류 메모 원문(경로·이유 문장)은 여기서 보여 주지 않는다: 줄을 누르면 업무 화면에서 자세히 본다.
import { api, type CeoTodo } from '../api.ts';
import { useCompany, useRoute } from '../App.tsx';
import { useT } from '../i18n.ts';
import { EmptyState, Icon, Skeleton, useAction, when } from '../components/ui.tsx';

const GROUPS: { key: string; kinds: string[]; ko: string; en: string; hint: [string, string] }[] = [
  {
    key: 'approve',
    kinds: ['approval'],
    ko: '승인할 것',
    en: 'To approve',
    hint: ['검수를 통과했습니다. 보고 승인하면 반영됩니다.', 'Passed review.'],
  },
  {
    key: 'decide',
    kinds: ['decision', 'permission'],
    ko: '결정할 것',
    en: 'To decide',
    hint: ['직원이 멈추고 대표 결정을 기다립니다.', 'Waiting for your decision.'],
  },
  { key: 'draft', kinds: ['draft', 'failed'], ko: '초안 확정', en: 'Drafts', hint: ['확정하면 업무가 시작됩니다.', 'Confirm to start.'] },
  {
    key: 'later',
    kinds: ['later'],
    ko: '직접 확인',
    en: 'Check yourself',
    hint: ['자동 점검으로 확인하지 못한 항목입니다.', 'Not verifiable automatically.'],
  },
  { key: 'watch', kinds: ['stalled', 'paused'], ko: '살펴볼 것', en: 'Keep an eye on', hint: ['', ''] },
];

export function Inbox() {
  const { state, reload } = useCompany();
  const { lang } = useT();
  const { go } = useRoute();
  const { busy, run } = useAction();
  if (!state) return <Skeleton />;
  const ko = lang === 'ko';
  const todos = state.ceoTodos ?? [];

  const act = (x: CeoTodo) => {
    const a = x.action;
    if (!a || !x.ticketId) return null;
    const call =
      a.kind === 'reverify'
        ? {
            path: `tickets/${x.ticketId}/reverify`,
            body: {},
            label: ko ? '다시 검증' : 'Re-verify',
            done: ko ? '다시 검증합니다.' : 'Re-verifying.',
          }
        : a.kind === 'allow'
          ? {
              path: `tickets/${x.ticketId}/scope-add`,
              body: { paths: a.paths ?? [] },
              label: ko ? '허용하고 계속' : 'Allow',
              done: ko ? '허용했습니다.' : 'Allowed.',
            }
          : a.kind === 'later-ok'
            ? {
                path: `tickets/${x.ticketId}/later-check`,
                body: { requirementId: a.requirementId, ok: true },
                label: ko ? '확인했어요' : 'Confirmed',
                done: ko ? '확인했다고 기록했습니다.' : 'Recorded.',
              }
            : {
                path: `tickets/${x.ticketId}/release`,
                body: {},
                label: ko ? '다시 진행' : 'Resume',
                done: ko ? '다시 진행합니다.' : 'Resumed.',
              };
    return (
      <button
        className="btn small primary"
        disabled={busy}
        title={a.kind === 'allow' ? (a.paths ?? []).join(', ') : undefined}
        onClick={() => run(() => api(call.path, { body: call.body }), call.done).then(reload)}
      >
        {call.label}
      </button>
    );
  };

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
      {GROUPS.map((g) => {
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
                <div
                  key={x.key}
                  className="inbox-row"
                  role="link"
                  tabIndex={0}
                  onClick={() => go(x.link)}
                  onKeyDown={(e) => e.key === 'Enter' && go(x.link)}
                >
                  <span className="inbox-id">{x.ticketId ?? ''}</span>
                  <span className="inbox-main">
                    <b>{x.label ?? x.title}</b>
                    {x.reason && <span className="sub">{x.reason}</span>}
                  </span>
                  <span className="sub inbox-when">{x.at ? when(x.at) : ''}</span>
                  <span className="inbox-actions" onClick={(e) => e.stopPropagation()}>
                    {act(x)}
                    <button className="btn small" onClick={() => go(x.link)}>
                      {ko ? '열기' : 'Open'} <Icon name="arrow" size={12} />
                    </button>
                  </span>
                </div>
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

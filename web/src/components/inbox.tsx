// 할 일 한 줄(할 일 화면·대시보드가 같이 쓴다). 대표 요청(2026-10-03): 할 일·대시보드가 읽기 불친절했다.
// 참고: Linear Inbox·GitHub Notifications — 한 줄에 하나(무엇·왜·언제), 바로 할 수 있는 일은 그 줄에서.
import { api, type CeoTodo } from '../api.ts';
import { useCompany, useRoute } from '../App.tsx';
import { useT } from '../i18n.ts';
import { Icon, useAction, when } from './ui.tsx';

export const TODO_GROUPS: { key: string; kinds: string[]; ko: string; en: string; hint: [string, string] }[] = [
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

/** 할 일 정렬: 묶음 순서(승인 → 결정 → 초안 → 직접 확인 → 살펴볼 것) */
export function sortTodos(todos: CeoTodo[]): CeoTodo[] {
  const rank = (k: string) => TODO_GROUPS.findIndex((g) => g.kinds.includes(k));
  return [...todos].sort((a, b) => rank(a.kind) - rank(b.kind));
}

/**
 * 할 일 한 줄. onToggle이 있으면(대시보드의 승인) "검토"로 그 자리에서 펼치고, 없으면 "열기"로 그 화면으로 간다.
 */
export function TodoRow({ x, expanded, onToggle }: { x: CeoTodo; expanded?: boolean; onToggle?: () => void }) {
  const { reload } = useCompany();
  const { lang } = useT();
  const { go } = useRoute();
  const { busy, run } = useAction();
  const ko = lang === 'ko';
  const a = x.action;
  const call =
    !a || !x.ticketId
      ? null
      : a.kind === 'reverify'
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
  const open = () => (onToggle ? onToggle() : go(x.link));
  return (
    <div
      className={`inbox-row ${expanded ? 'open' : ''}`}
      role="link"
      tabIndex={0}
      onClick={open}
      onKeyDown={(e) => e.key === 'Enter' && open()}
    >
      <span className="inbox-id">{x.ticketId ?? ''}</span>
      <span className="inbox-main">
        <b>{x.label ?? x.title}</b>
        {x.reason && <span className="sub">{x.reason}</span>}
      </span>
      <span className="sub inbox-when">{x.at ? when(x.at) : ''}</span>
      <span className="inbox-actions" onClick={(e) => e.stopPropagation()}>
        {call && (
          <button
            className="btn small primary"
            disabled={busy}
            title={a?.kind === 'allow' ? (a.paths ?? []).join(', ') : undefined}
            onClick={() => run(() => api(call.path, { body: call.body }), call.done).then(reload)}
          >
            {call.label}
          </button>
        )}
        {onToggle ? (
          <button className={`btn small ${call ? '' : 'primary'}`} onClick={onToggle}>
            {expanded ? (ko ? '접기' : 'Close') : ko ? '검토하기' : 'Review'}
          </button>
        ) : (
          <button className="btn small" onClick={() => go(x.link)}>
            {ko ? '열기' : 'Open'} <Icon name="arrow" size={12} />
          </button>
        )}
      </span>
    </div>
  );
}

import { useEffect, useState } from 'react';
import { api, type Approval, type DomainEvent, type State } from '../api.ts';
import { Link, useCompany, useRoute } from '../App.tsx';
import { ACCESS, josa, useT } from '../i18n.ts';
import { MAX_ACTIVE_EMPLOYEES } from '../../../src/core/types.ts';
import { Avatar, empName, EmptyState, Icon, Modal, needsCeo, useAction, when, Skeleton } from '../components/ui.tsx';
import { CliConnect, Segmented, useCliStatus } from '../components/kit.tsx';
import { fmtTokens, UsagePanel } from '../components/usage.tsx';
import { sortTodos, TodoRow } from '../components/inbox.tsx';
import { RequestBox } from './Requests.tsx';
import { PlaytestPanel, PreviewButton, QuickCheckLink, quickQueries, ScreenCheckPanel } from '../components/preview.tsx';
import { DeliverableView } from '../components/deliverable.tsx';

const ACTIVE = ['assigned', 'in_progress', 'verifying', 'in_review', 'changes_requested', 'integrating'];

/**
 * 활동 기록에서 뺄 잡음: 권한 요청을 대신 처리하는 직원이 있으면 요청·허용이 "…이 허용: 명령" 한 줄(approval.delegated)과 겹친다.
 * 실측: 명령 하나에 "승인 요청 / 대표 승인 / 허용" 세 줄이 떠 대표가 한 적 없는 승인처럼 보였다.
 */
export function isNoiseEvent(e: DomainEvent, s: State | null): boolean {
  const p = (e.payload ?? {}) as Record<string, unknown>;
  if (!e.type.startsWith('approval.') || p.kind !== 'tool_permission') return false;
  if (e.type === 'approval.requested') return Boolean(s?.permissionDelegate);
  return (e.type === 'approval.approved' || e.type === 'approval.rejected') && e.actor !== 'ceo';
}

export function describeEvent(e: DomainEvent, s: State | null, lang: string): string {
  const p = (e.payload ?? {}) as Record<string, unknown>;
  const who = (id: unknown) => (s ? empName(s.employees, String(id)) : String(id));
  const ko = lang === 'ko';
  const projectName = (id: string) => s?.projects.find((x) => x.id === id)?.name ?? id;
  const access = (v: unknown) => ACCESS[ko ? 'ko' : 'en'][String(v)] ?? String(v);
  switch (e.type) {
    case 'ticket.created':
      return ko ? `${e.entityId} 업무 생성: ${p.title}` : `${e.entityId} created: ${p.title}`;
    case 'ticket.assigned':
      return ko
        ? `${e.entityId} 배정 — 담당 ${who(p.assigneeId)}, 검수 ${who(p.reviewerId)}`
        : `${e.entityId} assigned to ${who(p.assigneeId)}, reviewer ${who(p.reviewerId)}`;
    case 'ticket.analyzing':
      return ko ? `${e.entityId} 분석 시작` : `${e.entityId} analysis started`;
    case 'ticket.backlog':
      return ko ? `${e.entityId} 대기 목록 등록` : `${e.entityId} moved to backlog`;
    case 'ticket.cancelled':
      return ko ? `${e.entityId} 취소: ${p.reason ?? ''}` : `${e.entityId} cancelled: ${p.reason ?? ''}`;
    case 'ticket.failed':
      return ko ? `${e.entityId} 실패: ${p.reason ?? ''}` : `${e.entityId} failed: ${p.reason ?? ''}`;
    case 'ticket.integration_failed':
      return ko ? `${e.entityId} 반영 실패: ${p.reason ?? ''}` : `${e.entityId} integration failed: ${p.reason ?? ''}`;
    case 'ticket.in_progress':
      return ko ? `${e.entityId} 작업 시작 (${p.runCount}번째 실행)` : `${e.entityId} work started (run #${p.runCount})`;
    case 'ticket.verifying':
      return ko ? `${e.entityId} 제출 → 시스템 검증 중` : `${e.entityId} submitted → verifying`;
    case 'ticket.in_review':
      return ko ? `${e.entityId} 검증 통과 → 독립 검수` : `${e.entityId} verified → independent review`;
    case 'ticket.changes_requested':
      return ko
        ? `${e.entityId} 수정 요청: ${String(p.reason ?? '').split('\n')[0]}`
        : `${e.entityId} changes requested: ${String(p.reason ?? '').split('\n')[0]}`;
    case 'ticket.awaiting_approval':
      return ko ? `${e.entityId} 검수 승인 → 대표 승인 대기` : `${e.entityId} review approved → awaiting CEO`;
    case 'ticket.integrating':
      return ko ? `${e.entityId} 대표 승인 → 반영 중` : `${e.entityId} CEO approved → integrating`;
    case 'ticket.done':
      return ko
        ? `${e.entityId} 완료 (${String(p.commitSha ?? '').slice(0, 8)})`
        : `${e.entityId} done (${String(p.commitSha ?? '').slice(0, 8)})`;
    case 'ticket.held':
      return ko ? `${e.entityId} 보류: ${p.reason}` : `${e.entityId} on hold: ${p.reason}`;
    case 'ticket.scope_violation':
      return ko
        ? `⚠ ${e.entityId} 범위 밖 수정 탐지: ${(p.paths as string[]).join(', ')}`
        : `⚠ ${e.entityId} out-of-scope change: ${(p.paths as string[]).join(', ')}`;
    case 'ticket.run_aborted':
      return ko ? `${e.entityId} 실행 중단: ${p.reason}` : `${e.entityId} run aborted: ${p.reason}`;
    case 'ticket.waiting_lock':
      return ko
        ? `${e.entityId} 대기: ${p.conflictWith}와 쓰기 범위가 겹쳐 순서를 기다립니다`
        : `${e.entityId} waiting: write scope overlaps ${p.conflictWith}`;
    case 'ticket.released':
      return ko ? `${e.entityId} 보류 해제` : `${e.entityId} hold released`;
    case 'request.submitted':
      return ko
        ? `대표 요청 → 비서실장: ${String(p.text ?? '').slice(0, 60)}`
        : `Request to chief of staff: ${String(p.text ?? '').slice(0, 60)}`;
    case 'request.drafted':
      return ko ? `비서실장이 업무 초안 ${p.count}개 작성` : `Chief of staff drafted ${p.count} tickets`;
    case 'request.accepted':
      return ko ? `대표가 초안 확정: ${(p.tickets as string[]).join(', ')}` : `CEO accepted drafts: ${(p.tickets as string[]).join(', ')}`;
    case 'evidence.attested':
      return ko ? `${e.entityId} ${p.requirementId} 대표 직접 확인` : `${e.entityId} ${p.requirementId} attested by CEO`;
    case 'ticket.deliberation_done':
      return ko
        ? `${e.entityId} 교차 검토 종합: 주장 ${p.claims}개, 미해결 ${p.escalated}개`
        : `${e.entityId} deliberation: ${p.claims} claims, ${p.escalated} unresolved`;
    case 'employee.hired':
      return ko ? `직원 추가: ${p.name}` : `Hired ${p.name}`;
    case 'approval.requested':
      return ko ? `승인 요청: ${p.summary}` : `Approval requested: ${p.summary}`;
    case 'orchestrator.recovered':
      return ko ? '재시작 복구 완료' : 'Recovered after restart';
    case 'approval.delegated':
      return p.allow
        ? ko
          ? `${josa(who(e.actor), '이/가')} 허용: ${p.command ? String(p.command) : (p.summary ?? '')}`
          : `${who(e.actor)} allowed: ${p.command ? String(p.command) : (p.summary ?? '')}`
        : ko
          ? `⛔ ${josa(who(e.actor), '이/가')} 차단: ${p.reason ?? ''}`
          : `⛔ ${who(e.actor)} blocked: ${p.reason ?? ''}`;
    case 'approval.approved':
      if (e.actor === 'auto')
        return ko ? `검수 통과 → 자동 반영(대표 설정): ${p.ticketId ?? ''}` : `Auto-merged after review: ${p.ticketId ?? ''}`;
      // 권한 요청을 대신 처리하는 직원의 허용은 "대표 승인"이 아니다(실측: 대표가 한 적 없는 승인이 줄줄이 보였다).
      if (e.actor !== 'ceo')
        return ko ? `${josa(who(e.actor), '이/가')} 대신 허용: ${p.ticketId ?? ''}` : `${who(e.actor)} allowed for ${p.ticketId ?? ''}`;
      return ko ? `대표 승인: ${p.ticketId ?? ''}` : `CEO approved ${p.ticketId ?? ''}`;
    case 'approval.rejected':
      return ko ? `대표 반려: ${p.ticketId ?? ''}` : `CEO rejected ${p.ticketId ?? ''}`;
    case 'approval.consumed':
      return ko ? `승인 사용 완료: ${p.ticketId ?? ''}` : `Approval used for ${p.ticketId ?? ''}`;
    case 'approval.expired':
      return ko ? `승인 만료: ${p.ticketId ?? ''}` : `Approval expired for ${p.ticketId ?? ''}`;
    case 'ticket.integration_result':
      return ko
        ? `${e.entityId} 원본 반영: ${p.kind === 'merged' ? '병합' : '브랜치 ' + String(p.branch ?? '')}`
        : `${e.entityId} integrated: ${p.kind === 'merged' ? 'merged' : 'branch ' + String(p.branch ?? '')}`;
    case 'decision.recorded':
      return ko ? `규칙 추가: ${String(p.text ?? '').slice(0, 60)}` : `Decision: ${String(p.text ?? '').slice(0, 60)}`;
    case 'project.registered':
      return ko ? `프로젝트 등록: ${p.name}` : `Project registered: ${p.name}`;
    case 'project.updated':
      return ko ? `프로젝트 설정 변경: ${projectName(e.entityId)}` : `Project settings changed: ${projectName(e.entityId)}`;
    case 'project.removed':
      return ko ? `프로젝트 삭제: ${projectName(e.entityId)}` : `Project removed: ${projectName(e.entityId)}`;
    case 'employee.access_changed':
      return ko
        ? `${who(e.entityId)} 접근 등급: ${access(p.from)} → ${access(p.to)}`
        : `${who(e.entityId)} access: ${access(p.from)} → ${access(p.to)}`;
    case 'employee.rank_changed':
      return ko ? `${who(e.entityId)} 직급 변경 → ${String(p.to)}` : `${who(e.entityId)} rank → ${String(p.to)}`;
    case 'employee.model_changed':
      return ko
        ? `${who(e.entityId)} 모델 변경 → ${(p.to as unknown[] | undefined)?.filter(Boolean).join(' · ') || '기본'}`
        : `${who(e.entityId)} model → ${(p.to as unknown[] | undefined)?.filter(Boolean).join(' · ') || 'default'}`;
    case 'employee.profile_changed':
      return ko ? `${who(e.entityId)} 정보 수정` : `${who(e.entityId)} profile updated`;
    case 'employee.removed':
      return ko ? `직원 삭제: ${who(e.entityId)}` : `Employee removed: ${who(e.entityId)}`;
    case 'decision.status':
      return ko
        ? p.to === 'withdrawn'
          ? '규칙 하나를 거뒀습니다'
          : `규칙 상태 변경 → ${({ current: '현재 유효', past: '과거', superseded: '대체됨', needs_verification: '검증 필요', draft: '초안' } as Record<string, string>)[String(p.to)] ?? String(p.to)}`
        : `Decision status → ${String(p.to)}`;
    case 'request.dismissed':
      return ko ? '대표 요청 초안을 버렸습니다' : 'Request drafts dismissed';
    case 'request.failed':
      return ko ? '비서실장 초안 작성 실패' : 'Chief of staff drafting failed';
    case 'ticket.scope_extended':
      return ko
        ? `${e.entityId} 대표가 파일을 더 허락: ${((p.paths as string[] | undefined) ?? []).join(', ')}`
        : `${e.entityId} write scope extended: ${((p.paths as string[] | undefined) ?? []).join(', ')}`;
    case 'ticket.split':
      return ko
        ? `${e.entityId} 담당자가 일을 나눔 → ${((p.parts as string[] | undefined) ?? []).join(', ')}`
        : `${e.entityId} split into ${((p.parts as string[] | undefined) ?? []).join(', ')}`;
    case 'ticket.review_skipped':
      return ko ? `${e.entityId} 대표가 검수를 건너뛰고 승인 단계로` : `${e.entityId} review skipped by the CEO`;
    case 'ticket.reverify':
      return ko ? `${e.entityId} 대표가 다시 검증 요청` : `${e.entityId} re-verification requested`;
    case 'orchestrator.error':
      return ko ? `시스템 오류: ${String(p.message ?? p.error ?? '')}` : `System error: ${String(p.message ?? p.error ?? '')}`;
    default:
      if (e.type.startsWith('deliberation.'))
        return `${e.entityId} ${who(e.actor)} ${e.type.split('.')[1]} ${p.summary ?? ''}${p.error ? ` ✗ ${p.error}` : ''}`;
      if (e.type.startsWith('run.')) {
        const [, kind, st] = e.type.split('.');
        const kindLabel = ko
          ? (({ work: '작업', review: '검수', analysis: '분석', chat: '대화 답장' } as Record<string, string>)[kind!] ?? kind)
          : kind;
        const stLabel = ko
          ? (({ prepared: '시작', succeeded: '성공', failed: '실패', orphaned: '고아' } as Record<string, string>)[st!] ?? st)
          : st;
        // 대화방 ID(t:T-17, dm:…, g:…)는 사람이 읽는 이름으로
        const where = e.entityId.startsWith('t:')
          ? ko
            ? `${e.entityId.slice(2)} 업무방`
            : `${e.entityId.slice(2)} room`
          : e.entityId.includes(':') || e.entityId === 'general'
            ? ko
              ? '대화방'
              : 'chat'
            : e.entityId;
        return `${where} ${who(e.actor)} ${kindLabel} ${stLabel}${p.failureClass ? ` (${p.failureClass})` : ''}`;
      }
      return `${e.type} ${e.entityId}`;
  }
}

export function ApprovalItem({ a, full = false }: { a: Approval; full?: boolean }) {
  return a.kind === 'integrate_request' ? <RequestApprovalItem a={a} /> : <TicketApprovalItem a={a} full={full} />;
}

interface RequestApprovalDetail {
  requestId: string;
  projectId: string;
  text: string;
  changedPaths: string[];
  mode: 'manual' | 'auto_after_approval';
  tickets: { id: string; title: string; status: string; belowRank: boolean }[];
  notDone?: string[];
  checks: { ticketId: string; id: string; text: string }[];
  acceptance: { round: number; passed: number; total: number; left: string[] } | null;
}

/** 요청 하나 = 결과물 하나: 업무들이 쌓인 요청 결과물 전체를 한 번에 승인한다. */
function RequestApprovalItem({ a }: { a: Approval }) {
  const { reload, state } = useCompany();
  const { t, lang } = useT();
  const ko = lang === 'ko';
  const { busy, run } = useAction();
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [checked, setChecked] = useState<string[]>([]);
  const [later, setLater] = useState<string[]>([]);
  const d = a.detail as RequestApprovalDetail;
  const key = (c: { ticketId: string; id: string }) => `${c.ticketId}:${c.id}`;
  const unchecked = d.checks.some((c) => !checked.includes(key(c)) && !later.includes(key(c)));
  const proj = state?.projects.find((p) => p.id === d.projectId);
  const kind = proj?.profile?.deliverable ?? 'screen';
  const belowRank = d.tickets.filter((x) => x.belowRank).map((x) => x.id);
  const toggle = (list: string[], set: (x: string[]) => void, k: string) =>
    set(list.includes(k) ? list.filter((x) => x !== k) : [...list, k]);
  const decide = (decision: 'approved' | 'rejected', mode?: string) =>
    run(
      () =>
        api(`approvals/${a.id}/decide`, {
          body: {
            decision,
            ...(mode ? { mode } : {}),
            reason,
            ...(decision === 'approved' ? { attested: checked, deferred: later.filter((x) => !checked.includes(x)) } : {}),
          },
        }),
      decision === 'approved' ? (ko ? '승인했습니다.' : 'Approved.') : ko ? '고칠 업무를 만들었습니다.' : 'Created a fix ticket.',
    ).then(reload);
  return (
    <div className="item">
      <div className="spread">
        <div>
          <div className="title">
            <span className="approval-mark">
              <Icon name="check" size={13} />
            </span>
            {a.summary}
          </div>
          <div className="meta">
            {ko ? '요청 결과물 한 번에 반영' : 'Merge the whole request at once'} ·{' '}
            {d.mode === 'auto_after_approval' ? (ko ? '승인하면 내 폴더에 반영' : 'auto merge') : ko ? '따로 보관만' : 'branch only'} ·{' '}
            {when(a.createdAt)}
          </div>
        </div>
        <div className="row">
          {kind === 'screen' && <PreviewButton projectId={d.projectId} ticketId={d.requestId} />}
          {d.mode === 'auto_after_approval' ? (
            <>
              <button className="btn ok small" disabled={busy || unchecked} onClick={() => decide('approved', 'auto_after_approval')}>
                {t('approveMerge')}
              </button>
              <button className="btn small" disabled={busy || unchecked} onClick={() => decide('approved', 'manual')}>
                {t('approveBranch')}
              </button>
            </>
          ) : (
            <button className="btn ok small" disabled={busy || unchecked} onClick={() => decide('approved')}>
              {t('approve')}
            </button>
          )}
          <button className="btn danger small" disabled={busy} onClick={() => setRejecting(true)}>
            {t('reject')}
          </button>
        </div>
      </div>
      <div className="approval-scroll">
        <div className="note">
          <b>{ko ? '요청' : 'Request'}</b> {d.text}
        </div>
        <div className="note">
          <b>{ko ? '업무' : 'Tickets'}</b>{' '}
          {d.tickets.map((x, i) => (
            <span key={x.id}>
              {i > 0 && ' · '}
              <Link to={`/tickets/${x.id}`}>{x.id}</Link> {x.title}
              {x.status !== 'done' && ` (${x.status})`}
            </span>
          ))}
        </div>
        {(d.notDone?.length ?? 0) > 0 && (
          <div className="banner warn" style={{ margin: '8px 0 0' }}>
            {ko ? '끝나지 않은 업무가 있어 그 몫은 결과물에 없습니다: ' : 'Some tickets did not finish; their part is not in the result: '}
            {d.notDone!.join(' · ')}
          </div>
        )}
        {d.acceptance && (
          <div className={`banner ${d.acceptance.left.length ? 'warn' : 'info'}`} style={{ margin: '8px 0 0' }}>
            {ko
              ? `인수 시험 ${d.acceptance.round}회차: ${d.acceptance.passed}/${d.acceptance.total} 통과`
              : `Acceptance round ${d.acceptance.round}: ${d.acceptance.passed}/${d.acceptance.total} passed`}
            {d.acceptance.left.map((x) => (
              <div key={x} className="sub">
                {x}
              </div>
            ))}
          </div>
        )}
        {belowRank.length > 0 && (
          <div className="banner warn" style={{ margin: '8px 0 0' }}>
            {ko
              ? `하위 직급이 검수한 업무가 있습니다(${belowRank.join(', ')}). 더 꼼꼼히 보고 승인하세요.`
              : `Some tickets were reviewed by a lower rank (${belowRank.join(', ')}). Check them more closely.`}
          </div>
        )}
        <details className="note">
          <summary>{ko ? `바뀐 파일 ${d.changedPaths.length}개` : `${d.changedPaths.length} files changed`}</summary>
          <pre className="code" style={{ maxHeight: 200 }}>
            {d.changedPaths.join('\n')}
          </pre>
        </details>
        {d.checks.length > 0 && (
          <div className="ceo-checks">
            <b>{ko ? '대표 직접 확인' : 'Your own check'}</b>
            {d.checks.map((c) => (
              <label key={key(c)} className="check-row">
                <input
                  type="checkbox"
                  checked={checked.includes(key(c))}
                  disabled={later.includes(key(c))}
                  onChange={() => toggle(checked, setChecked, key(c))}
                />
                <span>
                  <b>
                    {c.ticketId} {c.id}
                  </b>{' '}
                  {c.text}{' '}
                  {!checked.includes(key(c)) && (
                    <button
                      type="button"
                      className={`btn small ${later.includes(key(c)) ? 'on' : ''}`}
                      onClick={(ev) => {
                        ev.preventDefault();
                        toggle(later, setLater, key(c));
                      }}
                    >
                      {later.includes(key(c))
                        ? ko
                          ? '✓ 나중에 확인 (할 일에 남김)'
                          : '✓ Check later'
                        : ko
                          ? '지금 확인 못 함 → 나중에'
                          : "Can't check now → later"}
                    </button>
                  )}
                </span>
              </label>
            ))}
          </div>
        )}
      </div>
      {rejecting && (
        <Modal
          title={t('reject')}
          onClose={() => setRejecting(false)}
          actions={
            <button
              className="btn danger"
              disabled={busy || !reason.trim()}
              onClick={() => decide('rejected').then(() => setRejecting(false))}
            >
              {t('reject')}
            </button>
          }
        >
          <div className="form">
            <label>
              {ko
                ? '무엇을 고쳐야 하나요? (이 내용으로 고칠 업무를 만들고, 끝나면 다시 승인을 받습니다)'
                : 'What needs to change? (A fix ticket is created; you approve again when it is done)'}
              <textarea value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
            </label>
          </div>
        </Modal>
      )}
    </div>
  );
}

function TicketApprovalItem({ a, full = false }: { a: Approval; full?: boolean }) {
  const { reload, state } = useCompany();
  const { t, lang } = useT();
  const { busy, run } = useAction();
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [deciding, setDeciding] = useState<{ id: string; text: string } | null>(null);
  const [recorded, setRecorded] = useState<string[]>([]);
  const d = (a.detail ?? {}) as Record<string, unknown>;
  const tk = a.ticketId ? state?.tickets.find((x) => x.id === a.ticketId) : undefined;
  // 대표 직접 확인 요구: 실행해 보고 체크해야 승인할 수 있다(체크 = 확인 기록).
  const ceoChecks =
    a.kind === 'integrate' && d.mode !== 'review' ? (tk?.requirements.filter((r) => r.evidenceType === 'human_attest') ?? []) : [];
  const [checked, setChecked] = useState<string[]>([]);
  // "지금 확인 못 함 → 나중에": 확인한 척 체크하지 않게(실측: 들어 볼 수 없는 소리를 체크하고 승인했다)
  const [later, setLater] = useState<string[]>([]);
  // 카드는 스크롤로, "크게 보기"는 넓은 창에서 요약 · 화면 점검 · 확인하고 승인 페이지로 나눠 본다.
  const [big, setBig] = useState(false);
  const [page, setPage] = useState<'summary' | 'screen' | 'check'>('summary');
  const unchecked = ceoChecks.some((r) => !checked.includes(r.id) && !later.includes(r.id));
  const ko = lang === 'ko';
  const proj = tk ? state?.projects.find((p) => p.id === tk.projectId) : undefined;
  // 결과물 종류: 화면이 아니면 "실행해 보기"·화면 점검 대신 결과물(문서·실행 결과)을 읽는다.
  const kind = proj?.profile?.deliverable ?? 'screen';
  // 이 승인을 기다리는 뒤 업무(실측: T-19가 T-18 승인 대기로 멈춘 줄 대표가 몰랐다)
  const waiting = tk
    ? (state?.tickets ?? []).filter((x) => x.dependsOn.includes(tk.id) && !['done', 'cancelled', 'failed'].includes(x.status))
    : [];
  const decide = (decision: 'approved' | 'rejected', mode?: string) =>
    run(
      () =>
        api(`approvals/${a.id}/decide`, {
          body: {
            decision,
            ...(mode ? { mode } : {}),
            reason,
            ...(decision === 'approved' ? { attested: checked, deferred: later.filter((x) => !checked.includes(x)) } : {}),
          },
        }),
      decision === 'approved' ? '승인했습니다.' : '반려했습니다.',
    ).then(reload);

  const paged = full && ceoChecks.length > 0;
  const showSummary = !paged || page === 'summary';
  const showScreen = !paged || page === 'screen';
  const showCheck = !paged || page === 'check';
  return (
    <div className="item">
      <div className="spread">
        <div>
          <div className="title">
            <span className={`approval-mark ${a.kind === 'tool_permission' ? 'perm' : ''}`}>
              <Icon name={a.kind === 'tool_permission' ? 'shield' : 'check'} size={13} />
            </span>
            {a.ticketId ? <Link to={`/tickets/${a.ticketId}`}>{a.summary}</Link> : a.summary}
          </div>
          <div className="meta">
            {a.kind === 'tool_permission'
              ? `${empName(state?.employees ?? [], a.requestedBy)} · ${String(d.tool)}`
              : d.mode === 'review'
                ? lang === 'ko'
                  ? '검토 결과 확인 (반영할 코드 없음)'
                  : 'Acknowledge review (no code to merge)'
                : `${lang === 'ko' ? '반영 방식' : 'Mode'}: ${d.mode === 'auto_after_approval' ? (lang === 'ko' ? '승인하면 내 폴더에 반영' : 'auto merge') : lang === 'ko' ? '따로 보관만' : 'branch only'}`}{' '}
            · {when(a.createdAt)}
          </div>
        </div>
        <div className="row">
          {!full && a.kind === 'integrate' && (
            <button
              className="btn small"
              onClick={() => setBig(true)}
              title={ko ? '넓은 창에서 페이지로 나눠 보기' : 'Open in a wide window'}
            >
              ⤢ {ko ? '크게 보기' : 'Expand'}
            </button>
          )}
          {a.kind === 'integrate' && d.mode === 'auto_after_approval' ? (
            <>
              <button className="btn ok small" disabled={busy || unchecked} onClick={() => decide('approved', 'auto_after_approval')}>
                {t('approveMerge')}
              </button>
              <button className="btn small" disabled={busy || unchecked} onClick={() => decide('approved', 'manual')}>
                {t('approveBranch')}
              </button>
            </>
          ) : (
            <button className="btn ok small" disabled={busy || unchecked} onClick={() => decide('approved')}>
              {t('approve')}
            </button>
          )}
          <button className="btn danger small" disabled={busy} onClick={() => setRejecting(true)}>
            {t('reject')}
          </button>
        </div>
      </div>
      {paged && (
        <div className="approval-pages">
          <Segmented
            value={page}
            onChange={(v) => setPage(v as typeof page)}
            options={[
              { value: 'summary', label: ko ? '1. 요약' : '1. Summary' },
              {
                value: 'screen',
                label:
                  kind === 'document'
                    ? ko
                      ? '2. 결과물 읽기'
                      : '2. Read results'
                    : kind === 'program'
                      ? ko
                        ? '2. 실행 결과'
                        : '2. Demo output'
                      : ko
                        ? '2. 화면 점검'
                        : '2. Screen check',
              },
              { value: 'check', label: ko ? `3. 확인하고 승인 (${ceoChecks.length})` : `3. Check & approve (${ceoChecks.length})` },
            ]}
          />
        </div>
      )}
      <div className={full ? '' : 'approval-scroll'}>
        {a.kind === 'tool_permission' && (
          <pre className="code" style={{ marginTop: 8, maxHeight: 240 }}>
            {toolInputText(d.input)}
          </pre>
        )}
        {showSummary && waiting.length > 0 && (
          <div className="banner info" style={{ margin: '8px 0 0' }}>
            {ko
              ? `⏳ ${waiting.map((x) => x.id).join(', ')} 업무가 이 승인을 기다리고 있습니다.`
              : `⏳ ${waiting.map((x) => x.id).join(', ')} wait for this approval.`}
            {!proj?.autoApprove && ceoChecks.length === 0 && (
              <span className="sub">
                {ko
                  ? " 프로젝트 설정에서 '검수를 통과하면 내 승인 없이 반영'을 켜면, 직접 볼 항목이 없는 업무는 기다리지 않습니다."
                  : ' Turn on auto-merge after review in project settings to skip this wait.'}
              </span>
            )}
          </div>
        )}
        {showSummary && a.kind === 'integrate' && typeof d.summary === 'string' && d.summary && (
          <div className="note">
            <b>{lang === 'ko' ? '담당' : 'Assignee'}</b> {d.summary}
          </div>
        )}
        {showSummary && a.kind === 'integrate' && d.mode !== 'review' && (
          <div className="note">
            <b>{lang === 'ko' ? '검수' : 'Review'}</b>{' '}
            {(d.review as { by: string; summary: string } | null)?.summary
              ? `${empName(state?.employees ?? [], (d.review as { by: string }).by)}: ${(d.review as { summary: string }).summary}`
              : lang === 'ko'
                ? '검수 의견 없음 (대표가 검수를 건너뛰었거나 이전 버전 승인 요청)'
                : 'No review verdict (review skipped by the CEO, or an older approval request)'}
          </div>
        )}
        {/* 결과물 보기: 문서·표·그림(문서 프로젝트·문서·조사 업무는 펼쳐서) */}
        {tk && a.kind === 'integrate' && d.mode !== 'review' && (paged ? page === 'screen' : showSummary) && (
          <DeliverableView
            ticketId={tk.id}
            open={paged || kind === 'document' || tk.type === 'doc' || tk.type === 'research'}
            version={a.id}
          />
        )}
        {tk && ceoChecks.length > 0 && (showScreen || showCheck) && (
          <div className="ceo-checks">
            <div className="spread">
              <b>{lang === 'ko' ? '대표 직접 확인' : 'Your own check'}</b>
              {kind === 'screen' && <PreviewButton projectId={tk.projectId} ticketId={tk.id} />}
            </div>
            {showScreen && kind !== 'document' && <ScreenCheckPanel ticketId={tk.id} />}
            {/* 직접 플레이는 게임만(실측: 메모 앱 승인 카드에 "고급 QA (직접 플레이)"가 떴다) */}
            {showScreen && kind === 'screen' && (proj?.profile?.game || state?.playtests?.[tk.id]) && <PlaytestPanel ticketId={tk.id} />}
            {paged && page === 'screen' && (
              <button className="btn small primary" onClick={() => setPage('check')}>
                {ko ? '다음: 확인하고 승인 →' : 'Next: check & approve →'}
              </button>
            )}
            {showCheck &&
              ceoChecks.map((r) => (
                <label key={r.id} className="check-row">
                  <input
                    type="checkbox"
                    checked={checked.includes(r.id)}
                    disabled={later.includes(r.id)}
                    onChange={() => setChecked(checked.includes(r.id) ? checked.filter((x) => x !== r.id) : [...checked, r.id])}
                  />
                  <span>
                    <b>{r.id}</b> {r.text}{' '}
                    {state?.checkNotes?.[tk.id]?.[r.id] && (
                      <span className="sub" style={{ display: 'block', marginTop: 2 }}>
                        💡 {lang === 'ko' ? '확인하는 법' : 'How to check'}: {state.checkNotes[tk.id]![r.id]}
                        {quickQueries(state.checkNotes[tk.id]![r.id]!).length > 0 && (
                          <span className="row" style={{ marginTop: 4, gap: 6 }}>
                            {quickQueries(state.checkNotes[tk.id]![r.id]!).map((q) => (
                              <QuickCheckLink key={q} projectId={tk.projectId} ticketId={tk.id} query={q} />
                            ))}
                          </span>
                        )}
                      </span>
                    )}
                    {!checked.includes(r.id) && (
                      <button
                        type="button"
                        className={`btn small ${later.includes(r.id) ? 'on' : ''}`}
                        onClick={(ev) => {
                          ev.preventDefault();
                          setLater(later.includes(r.id) ? later.filter((x) => x !== r.id) : [...later, r.id]);
                        }}
                      >
                        {later.includes(r.id)
                          ? lang === 'ko'
                            ? '✓ 나중에 확인 (할 일에 남김)'
                            : '✓ Check later'
                          : lang === 'ko'
                            ? '지금 확인 못 함 → 나중에'
                            : "Can't check now → later"}
                      </button>
                    )}
                  </span>
                </label>
              ))}
            {showCheck && (
              <div className="spread">
                <span className="hint">
                  {lang === 'ko'
                    ? `${kind === 'document' ? '결과물을 읽고' : kind === 'program' ? '실행 결과를 보고' : '실행해 보고'} 확인한 항목을 체크하세요. 지금 확인할 수 없으면 "나중에"를 누르세요(할 일에 남습니다).`
                    : 'Run it, then tick what you confirmed. All items must be ticked to approve.'}
                </span>
                {/* 체크한 바로 옆에서 승인(실측: 체크는 카드 맨 아래, 승인 버튼은 맨 위라 다시 올라가야 했다) */}
                <button
                  className="btn ok small"
                  disabled={busy || unchecked}
                  onClick={() => (d.mode === 'auto_after_approval' ? decide('approved', 'auto_after_approval') : decide('approved'))}
                >
                  {d.mode === 'auto_after_approval' ? t('approveMerge') : t('approve')}
                </button>
              </div>
            )}
          </div>
        )}
        {showSummary && a.kind === 'integrate' && tk?.reviewBelowRank && (
          <div className="banner warn" style={{ margin: '8px 0 0' }}>
            {lang === 'ko'
              ? `하위 직급 검수: ${empName(state?.employees ?? [], tk.assigneeId)}의 작업을 더 낮은 직급인 ${josa(empName(state?.employees ?? [], tk.reviewerId), '이/가')} 검수했습니다(같은 직급 이상 직원 없음). 변경 내용을 더 꼼꼼히 확인하고 승인하세요.`
              : `Lower-rank review: ${empName(state?.employees ?? [], tk.reviewerId)} reviewed work by a higher-ranked ${empName(state?.employees ?? [], tk.assigneeId)} (no peer available). Check the changes more closely before approving.`}
          </div>
        )}
        {showSummary && d.mode === 'review' && Array.isArray(d.escalated) && (d.escalated as { id: string; text: string }[]).length > 0 && (
          <div className="note">
            {lang === 'ko' ? '미해결 이견 (대표 판단 필요):' : 'Unresolved disputes:'}
            {(d.escalated as { id: string; text: string }[]).map((c) => (
              <div key={c.id} className="spread" style={{ marginTop: 6, gap: 8 }}>
                <span>• {c.text}</span>
                {tk && (
                  <button
                    className="btn small"
                    disabled={busy || recorded.includes(c.id)}
                    onClick={() => setDeciding({ id: c.id, text: c.text })}
                  >
                    {recorded.includes(c.id)
                      ? lang === 'ko'
                        ? '기록함'
                        : 'Recorded'
                      : lang === 'ko'
                        ? '규칙으로 남기기'
                        : 'Record decision'}
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
        {deciding && tk && (
          <Modal
            title={lang === 'ko' ? '규칙으로 남기기' : 'Record a decision'}
            onClose={() => setDeciding(null)}
            actions={
              <button
                className="btn primary"
                disabled={busy || !deciding.text.trim()}
                onClick={() =>
                  run(
                    () =>
                      api('decisions', {
                        body: { projectId: tk.projectId, text: deciding.text.trim(), sourceRefs: [deciding.id, tk.id] },
                      }),
                    lang === 'ko' ? '규칙으로 남겼습니다.' : 'Decision recorded.',
                  ).then((ok) => ok && (setRecorded([...recorded, deciding.id]), setDeciding(null), reload()))
                }
              >
                {t('save')}
              </button>
            }
          >
            <div className="form">
              <label>
                {lang === 'ko' ? '규칙 (이후 모든 업무의 직원이 따릅니다)' : 'Your decision (sent to later tickets as current)'}
                <textarea value={deciding.text} onChange={(e) => setDeciding({ ...deciding, text: e.target.value })} autoFocus />
              </label>
            </div>
          </Modal>
        )}
        {rejecting && (
          <Modal
            title={t('reject')}
            onClose={() => setRejecting(false)}
            actions={
              <button className="btn danger" disabled={busy} onClick={() => decide('rejected').then(() => setRejecting(false))}>
                {t('reject')}
              </button>
            }
          >
            <div className="form">
              <label>
                {lang === 'ko' ? '반려 사유 (담당 직원에게 전달됩니다)' : 'Reason (sent to the employee)'}
                <textarea value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
              </label>
            </div>
          </Modal>
        )}
      </div>
      {big && (
        <Modal wide title={a.summary} onClose={() => setBig(false)}>
          <ApprovalItem a={a} full />
        </Modal>
      )}
    </div>
  );
}

export function Dashboard({ onNewTicket }: { onNewTicket: () => void }) {
  const { state } = useCompany();
  const { t, lang } = useT();
  const { go } = useRoute();
  // 펼쳐 본 승인(그 자리에서 사진·확인 항목을 보고 승인한다)
  const [openApproval, setOpenApproval] = useState<string | null>(null);
  const [allActivity, setAllActivity] = useState(false);
  if (!state) return <Skeleton />;
  const ko = lang === 'ko';
  // 대시보드는 할 일 화면과 같은 방식: 한 줄에 하나, 바로 할 일은 그 줄에서, 긴 설명은 펼쳐야 보인다.
  // 대표 요청(2026-10-03): "대시보드도 같은 방식으로 정리해줘". 숫자 타일 넷·승인함·보류 목록·긴 안내문이 따로 있어 길었다.
  const todos = sortTodos(state.ceoTodos ?? []);
  const active = state.tickets.filter((x) => ACTIVE.includes(x.status) && !needsCeo(x));
  const done = state.tickets.filter((x) => x.status === 'done');
  const events = [...state.events]
    .reverse()
    // 직원이 대표 대신 허용한 명령 원문은 대시보드에서 뺀다(실측: 돌아와 보니 powershell 명령이 줄줄이). 차단(⛔)은 남긴다.
    .filter((e) => !isNoiseEvent(e, state) && !(e.type === 'approval.delegated' && (e.payload as { allow?: boolean } | null)?.allow));
  const PREVIEW = 6;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{t('nav_dashboard')}</h1>
          <div className="sub">
            {ko ? '회사가 지금 어떤지 한눈에. 대표 차례인 일은 맨 위에 있습니다.' : 'The company at a glance. What needs you is on top.'}
          </div>
        </div>
      </div>

      <AwaySummary />
      <SetupGuide onNewTicket={onNewTicket} />

      {/* 숫자는 한 줄로(누르면 그 화면으로) */}
      <div className="kpi-strip">
        <button className={`kpi ${todos.length ? 'hot' : ''}`} onClick={() => go('/inbox')}>
          <Icon name="inbox" size={14} /> {ko ? '할 일' : 'Inbox'} <b>{todos.length}</b>
        </button>
        <button className="kpi" onClick={() => go('/board')}>
          <Icon name="bolt" size={14} /> {t('inProgress')} <b>{active.length}</b>
        </button>
        <button className="kpi" onClick={() => go('/board')}>
          <Icon name="check" size={14} /> {t('done')} <b>{done.length}</b>
        </button>
        {state.usage && (
          <span className="kpi">
            <Icon name="spark" size={14} /> {ko ? '오늘 토큰' : 'Tokens today'} <b>{fmtTokens(state.usage.today.total, lang)}</b>
          </span>
        )}
      </div>

      <div className="grid cols-2">
        <div className="grid" style={{ alignContent: 'start' }}>
          <div className="card">
            <h2>
              <span className="row">
                <Icon name="inbox" /> {ko ? '지금 대표 차례' : 'Needs you'}{' '}
                {todos.length > 0 && <span className="chip warn">{todos.length}</span>}
              </span>
              {todos.length > PREVIEW && (
                <button className="btn small" onClick={() => go('/inbox')}>
                  {ko ? `모두 보기 (${todos.length})` : `All (${todos.length})`}
                </button>
              )}
            </h2>
            {todos.length === 0 ? (
              <EmptyState icon="inbox">{ko ? '지금 대표가 할 일은 없습니다.' : 'Nothing needs you right now.'}</EmptyState>
            ) : (
              <div className="list">
                {todos.slice(0, PREVIEW).map((x) => {
                  const approval = x.kind === 'approval' ? state.approvals.find((a) => `appr:${a.id}` === x.key) : null;
                  return (
                    <div key={x.key}>
                      <TodoRow
                        x={x}
                        expanded={Boolean(approval && openApproval === approval.id)}
                        onToggle={approval ? () => setOpenApproval(openApproval === approval.id ? null : approval.id) : undefined}
                      />
                      {approval && openApproval === approval.id && (
                        <div className="inbox-expand">
                          <ApprovalItem a={approval} />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          <RequestBox />
          <div className="card">
            <h2>
              <span className="row">
                <Icon name="activity" /> {t('activity')}
              </span>
            </h2>
            {events.length === 0 && <EmptyState icon="activity">{ko ? '아직 기록이 없습니다.' : 'Nothing yet.'}</EmptyState>}
            <ul className="timeline">
              {events.slice(0, allActivity ? 30 : 8).map((e) => (
                <li key={e.seq}>
                  <span className="when">{new Date(e.ts).toLocaleTimeString()}</span>
                  <span>{describeEvent(e, state, lang)}</span>
                </li>
              ))}
            </ul>
            {events.length > 8 && (
              <button className="link-btn" style={{ padding: '0 18px 12px' }} onClick={() => setAllActivity(!allActivity)}>
                {allActivity ? (ko ? '접기' : 'Less') : ko ? '더 보기' : 'More'}
              </button>
            )}
          </div>
        </div>

        <div className="grid" style={{ alignContent: 'start' }}>
          <TeamPanel />
          {/* 전권 위임 결정 기록: 최근 5개만(더 보기) */}
          {(state.delegation?.on || (state.delegation?.recent.length ?? 0) > 0) && <DelegationPanel />}
          <UsagePanel />
          <ProjectsPanel />
        </div>
      </div>
    </>
  );
}

/** 전권 위임으로 대신 결정한 일: 한 줄에 하나, 최근 5개(더 보기). */
function DelegationPanel() {
  const { state } = useCompany();
  const { lang } = useT();
  const [all, setAll] = useState(false);
  if (!state?.delegation) return null;
  const ko = lang === 'ko';
  const recent = state.delegation.recent;
  return (
    <div className="card">
      <h2>
        <span className="row">🧭 {ko ? '대신 결정한 일' : 'Delegated decisions'}</span>
        <span className="sub">{empName(state.employees, state.delegation.delegate)}</span>
      </h2>
      {recent.length === 0 ? (
        <div className="hint" style={{ padding: 12 }}>
          {ko ? '아직 대신 결정한 일이 없습니다.' : 'Nothing decided yet.'}
        </div>
      ) : (
        <ul className="timeline">
          {recent.slice(0, all ? 15 : 5).map((x, i) => (
            <li key={i}>
              <span className="when">{when(x.at)}</span>
              <span title={x.text}>{x.text.length > 140 ? `${x.text.slice(0, 140)}…` : x.text}</span>
            </li>
          ))}
        </ul>
      )}
      {recent.length > 5 && (
        <button className="link-btn" style={{ padding: '0 18px 12px' }} onClick={() => setAll(!all)}>
          {all ? (ko ? '접기' : 'Less') : ko ? '더 보기' : 'More'}
        </button>
      )}
    </div>
  );
}

/** 팀 현황: 직급·AI·지금 하는 일. */
function TeamPanel() {
  const { state } = useCompany();
  const { lang, rank, effort } = useT();
  const { go } = useRoute();
  const clis = useCliStatus();
  if (!state) return null;
  const ko = lang === 'ko';
  const active = state.employees.filter((e) => e.active);
  const order = { lead: 0, senior: 1, junior: 2 } as const;
  // 지금 실제로 돌고 있는 실행으로 판단한다. 실측(2026-10-03, 4777): 보류된 T-14·T-6을 "작업 중"으로 보여 줬다.
  const doing = (id: string) => {
    const live = state.runs.find((r) => r.employeeId === id && r.status === 'running');
    if (live?.kind === 'work')
      return { tone: 'info', text: ko ? `${live.ticketId} 작업 중` : `Working on ${live.ticketId}`, to: live.ticketId };
    if (live?.kind === 'review')
      return { tone: 'accent', text: ko ? `${live.ticketId} 검수 중` : `Reviewing ${live.ticketId}`, to: live.ticketId };
    if (live?.kind === 'analysis') return { tone: 'info', text: ko ? '업무 초안 작성 중' : 'Drafting tickets', to: null };
    if (live) return { tone: 'info', text: ko ? '대화 답하는 중' : 'Replying in chat', to: null };
    const held = state.tickets.find((x) => x.assigneeId === id && x.hold && !['done', 'failed', 'cancelled'].includes(x.status));
    if (held) return { tone: 'warn', text: ko ? `${held.id} 보류 · 대표 결정 기다림` : `${held.id} on hold`, to: held.id };
    const owns = state.tickets.filter((x) => x.ownerId === id && !['done', 'failed', 'cancelled'].includes(x.status)).length;
    if (owns) return { tone: '', text: ko ? `책임 업무 ${owns}개` : `Owns ${owns}`, to: null };
    return { tone: '', text: ko ? '대기 중' : 'Idle', to: null };
  };
  return (
    <div className="card">
      <h2>
        <span className="row">
          <Icon name="team" /> {ko ? '팀' : 'Team'}{' '}
          <span className="sub">
            {active.length}/{MAX_ACTIVE_EMPLOYEES}
          </span>
        </span>
        <button className="btn small" onClick={() => go('/org')}>
          {ko ? '조직 관리' : 'Manage'}
        </button>
      </h2>
      {active.length === 0 ? (
        <EmptyState icon="team">
          <div>{ko ? '아직 직원이 없습니다.' : 'No employees yet.'}</div>
          <button className="btn small primary" style={{ marginTop: 10 }} onClick={() => go('/org')}>
            <Icon name="plus" /> {ko ? '직원 채용' : 'Hire'}
          </button>
        </EmptyState>
      ) : (
        <div className="list">
          {[...active]
            .sort((a, b) => order[a.rank ?? 'senior'] - order[b.rank ?? 'senior'])
            .map((e) => {
              const d = doing(e.id);
              const login = clis?.find((c) => c.kind === e.cli);
              return (
                <div className="member" key={e.id}>
                  <Avatar employees={state.employees} id={e.id} />
                  <div className="who">
                    <div className="nm">
                      {e.name} <span className={`chip rank-${e.rank ?? 'senior'}`}>{rank(e.rank)}</span>
                    </div>
                    <div className="sub">
                      {state.adapters.find((a) => a.kind === e.cli)?.displayName ?? e.cli}
                      {e.model ? ` · ${e.model}` : ''}
                      {e.effort ? ` · ${effort(e.effort)}` : ''}
                      {login && login.found && login.login === 'missing' && (
                        <span className="chip warn" style={{ marginLeft: 6 }}>
                          {ko ? '로그인 필요' : 'Login needed'}
                        </span>
                      )}
                    </div>
                  </div>
                  {d.to ? (
                    <Link to={`/tickets/${d.to}`} className={`chip ${d.tone} ${d.tone === 'warn' ? '' : 'pulse'}`}>
                      {d.text}
                    </Link>
                  ) : (
                    <span className="chip">{d.text}</span>
                  )}
                </div>
              );
            })}
        </div>
      )}
      {/* 권한 요청 대신 처리: 긴 안내문 대신 한 줄(대시보드 정리, 2026-10-03) */}
      {state.permissionDelegate && (
        <div className="hint" style={{ padding: '8px 18px 12px' }}>
          {ko
            ? `권한 요청은 ${empName(state.employees, state.permissionDelegate)}이(가) 대신 처리합니다(치명적인 명령만 막음).`
            : `Permission requests are handled by ${empName(state.employees, state.permissionDelegate)} (only catastrophic commands blocked).`}
        </div>
      )}
    </div>
  );
}

/** 프로젝트 요약. */
function ProjectsPanel() {
  const { state } = useCompany();
  const { lang } = useT();
  const { go } = useRoute();
  if (!state || state.projects.length === 0) return null;
  const ko = lang === 'ko';
  return (
    <div className="card">
      <h2>
        <span className="row">
          <Icon name="folder" /> {ko ? '프로젝트' : 'Projects'}
        </span>
        <button className="btn small" onClick={() => go('/projects')}>
          {ko ? '관리' : 'Manage'}
        </button>
      </h2>
      <div className="list">
        {state.projects
          .filter((p) => !p.removedAt)
          .map((p) => {
            const open = state.tickets.filter((x) => x.projectId === p.id && !['done', 'failed', 'cancelled'].includes(x.status)).length;
            const done = state.tickets.filter((x) => x.projectId === p.id && x.status === 'done').length;
            return (
              // 한 줄에 하나(경로·반영 방식은 마우스를 올리면, 자세한 설정은 프로젝트 화면에서)
              <div className="item spread" key={p.id} title={p.originPath}>
                <span className="title">{p.name}</span>
                <span className="row" style={{ gap: 6 }}>
                  {open > 0 && <span className="chip info">{ko ? `진행 ${open}` : `${open} open`}</span>}
                  <span className="chip ok">{ko ? `완료 ${done}` : `${done} done`}</span>
                </span>
              </div>
            );
          })}
      </div>
    </div>
  );
}

/** 처음 쓰는 대표를 위한 3단계 안내. 모두 끝나면 사라진다. */
function SetupGuide({ onNewTicket }: { onNewTicket: () => void }) {
  const { state } = useCompany();
  const { lang } = useT();
  const { go } = useRoute();
  const clis = useCliStatus();
  if (!state) return null;
  const ko = lang === 'ko';
  const hasProject = state.projects.length > 0;
  const hasTeam = state.employees.filter((e) => e.active).length >= 2;
  const hasTicket = state.tickets.length > 0 || state.requests.length > 0;
  // 실측(첫 사용): 로그인 안 된 AI가 있어도 안내에 없어서, 기본 팀이 한 종류 AI로만 짜였다.
  const hasAi = hasTeam || (clis ?? []).some((c) => c.login === 'ok');
  if (hasProject && hasTeam && hasTicket) return null;
  const steps = [
    {
      done: hasAi,
      t: ko ? 'AI 연결' : 'Connect AIs',
      d: ko ? '직원이 될 AI에 로그인하세요. 두 종류 이상이면 서로 검수합니다.' : 'Log in to the AIs your employees will use.',
      cta: '',
      onClick: () => {},
    },
    {
      done: hasProject,
      t: ko ? '프로젝트 등록' : 'Register a project',
      d: ko ? '작업할 폴더를 고르세요. 빈 폴더를 새로 만들어도 됩니다.' : 'Point to a repository and its verify commands.',
      cta: ko ? '프로젝트로' : 'Projects',
      onClick: () => go('/projects'),
    },
    {
      done: hasTeam,
      t: ko ? '직원 2명 이상 채용' : 'Hire 2+ employees',
      d: ko ? '"기본 팀 한 번에 만들기"를 누르면 됩니다.' : 'Use "Create a standard team".',
      cta: ko ? '팀으로' : 'Team',
      onClick: () => go('/org'),
    },
    {
      done: hasTicket,
      t: ko ? '첫 업무 맡기기' : 'Assign the first ticket',
      d: ko ? '업무를 만들거나 비서실장에게 한 줄로 요청하세요.' : 'Create a ticket or ask the chief of staff in one line.',
      cta: ko ? '새 업무' : 'New ticket',
      onClick: onNewTicket,
    },
  ];
  const doneCount = steps.filter((x) => x.done).length;
  const next = steps.findIndex((x) => !x.done);
  return (
    <div className="card setup">
      <div className="body">
        <h2>{ko ? '회사를 차려 볼까요' : 'Set up your company'}</h2>
        <div className="sub">
          {ko ? `${doneCount}/4 완료 · 네 단계면 첫 일을 맡길 수 있습니다.` : `${doneCount}/4 done · four steps to your first ticket.`}
        </div>
        <div className="steps">
          {steps.map((x, i) => (
            <div key={i} className={`step ${x.done ? 'done' : i === next ? 'next' : ''}`}>
              <span className="num">{x.done ? <Icon name="check" size={14} /> : i + 1}</span>
              <span className="t">{x.t}</span>
              <span className="d">{x.d}</span>
              {!x.done && x.cta && (
                <button className={`btn small ${i === next ? 'primary' : ''}`} disabled={i === 3 && !hasProject} onClick={x.onClick}>
                  {x.cta} <Icon name="arrow" size={14} />
                </button>
              )}
            </div>
          ))}
        </div>
        {!hasTeam && (
          <div style={{ marginTop: 14 }}>
            <CliConnect />
          </div>
        )}
      </div>
    </div>
  );
}

/** 파일 변경 요청은 바뀔 파일과 diff를 그대로, 나머지는 JSON으로 보여준다. */
function toolInputText(input: unknown): string {
  const x = input as { files?: { path: string; kind: string }[]; diff?: unknown } | null;
  if (x && Array.isArray(x.files) && typeof x.diff === 'string')
    return `${x.files.map((f) => `${f.kind}  ${f.path}`).join('\n')}\n\n${x.diff}`;
  return JSON.stringify(input, null, 2);
}

/**
 * 자리 비운 사이 요약: 30분 넘게 대시보드를 안 봤으면, 그동안 끝난 일·생긴 일을 세 줄로 먼저 보여 준다.
 * 실측(2026-10-01, 눈 휴식): 돌아와 보니 "최근 활동"이 명령 기록뿐이라 무슨 일이 있었는지 알 수 없었다.
 * 근거: 끊긴 일로 돌아오는 데 평균 25분(Mark·Gudith 2008) — 다시 붙는 비용을 줄인다.
 */
const SEEN_KEY = 'ac_last_seen';
function AwaySummary() {
  const { state } = useCompany();
  const { lang } = useT();
  const { go } = useRoute();
  const ko = lang === 'ko';
  const [since, setSince] = useState<number | null>(() => {
    try {
      const v = Number(localStorage.getItem(SEEN_KEY) || 0);
      return v && Date.now() - v > 30 * 60_000 ? v : null;
    } catch {
      return null;
    }
  });
  const [events, setEvents] = useState<DomainEvent[] | null>(null);
  useEffect(() => {
    const mark = () => {
      try {
        if (document.visibilityState === 'visible') localStorage.setItem(SEEN_KEY, String(Date.now()));
      } catch {
        // 저장 못 해도 요약만 안 뜰 뿐
      }
    };
    if (since === null) mark();
    const t = setInterval(mark, 60_000);
    document.addEventListener('visibilitychange', mark);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', mark);
    };
  }, [since]);
  useEffect(() => {
    if (since !== null)
      void api<DomainEvent[]>('events?limit=1000')
        .then(setEvents)
        .catch(() => setEvents([]));
  }, [since]);
  if (since === null || !state || !events) return null;
  const after = events.filter((e) => Date.parse(e.ts) > since);
  const ids = (type: string) => [...new Set(after.filter((e) => e.type === type).map((e) => e.entityId))];
  const doneIds = ids('ticket.done');
  const drafted = ids('request.drafted').filter((id) => state.requests.find((r) => r.id === id)?.status === 'drafted');
  const waiting = state.approvals.filter((a) => a.kind === 'integrate' || a.kind === 'integrate_request');
  const stuck = state.tickets.filter(
    (t) => t.hold && t.hold.reason !== 'waiting_dependency' && !['done', 'cancelled', 'failed'].includes(t.status),
  );
  const notices = (state.notices ?? []).filter((n) => Date.parse(n.at) > since);
  const mins = Math.round((Date.now() - since) / 60_000);
  const away =
    mins >= 60
      ? ko
        ? `${Math.floor(mins / 60)}시간 ${mins % 60}분`
        : `${Math.floor(mins / 60)}h ${mins % 60}m`
      : ko
        ? `${mins}분`
        : `${mins}m`;
  const title = (id: string) => state.tickets.find((t) => t.id === id)?.title ?? '';
  const lines: { text: string; to?: string }[] = [
    ...(doneIds.length
      ? [
          {
            text: ko
              ? `✅ 끝난 업무 ${doneIds.length}개: ${doneIds.map((id) => `${id} ${title(id)}`).join(', ')}`
              : `✅ ${doneIds.length} done: ${doneIds.join(', ')}`,
          },
        ]
      : []),
    ...(waiting.length
      ? [{ text: ko ? `⏳ 대표 승인을 기다리는 업무 ${waiting.length}개` : `⏳ ${waiting.length} waiting for your approval`, to: '/' }]
      : []),
    ...(drafted.length ? [{ text: ko ? `📝 확인할 초안 ${drafted.length}개` : `📝 ${drafted.length} drafts to review`, to: '/' }] : []),
    ...(stuck.length
      ? [
          {
            text: ko
              ? `⚠ 멈춰서 대표를 기다리는 업무 ${stuck.length}개: ${stuck.map((t) => t.id).join(', ')}`
              : `⚠ ${stuck.length} on hold`,
            to: `/tickets/${stuck[0]!.id}`,
          },
        ]
      : []),
    ...notices.slice(-3).map((n) => ({ text: `🔔 ${n.title}`, to: n.link })),
  ];
  const close = () => {
    try {
      localStorage.setItem(SEEN_KEY, String(Date.now()));
    } catch {
      // 무시
    }
    setSince(null);
  };
  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="body">
        <div className="spread">
          <b>{ko ? `자리 비운 사이 (${away})` : `While you were away (${away})`}</b>
          <button className="btn small" onClick={close}>
            {ko ? '확인했어요' : 'Got it'}
          </button>
        </div>
        {lines.length === 0 ? (
          <div className="sub">{ko ? '그동안 새로 생긴 일은 없습니다.' : 'Nothing new.'}</div>
        ) : (
          lines.map((l, i) => (
            <div key={i} style={{ marginTop: 6, cursor: l.to ? 'pointer' : undefined }} onClick={() => l.to && go(l.to)}>
              {l.text}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

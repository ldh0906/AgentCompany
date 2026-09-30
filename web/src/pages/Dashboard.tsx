import { useState } from 'react';
import { api, type Approval, type DomainEvent, type State } from '../api.ts';
import { Link, useCompany, useRoute } from '../App.tsx';
import { ACCESS, josa, useT } from '../i18n.ts';
import { MAX_ACTIVE_EMPLOYEES } from '../../../src/core/types.ts';
import { Avatar, empName, EmptyState, HoldChip, Icon, Modal, needsCeo, StatusChip, useAction, when, Skeleton } from '../components/ui.tsx';
import { useCliStatus } from '../components/kit.tsx';
import { UsagePanel } from '../components/usage.tsx';
import { RequestBox } from './Requests.tsx';
import { PreviewButton, ScreenCheckPanel } from '../components/preview.tsx';

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
      return ko ? `결정 상태 변경 → ${String(p.to)}` : `Decision status → ${String(p.to)}`;
    case 'request.dismissed':
      return ko ? '대표 요청 초안을 버렸습니다' : 'Request drafts dismissed';
    case 'request.failed':
      return ko ? '비서실장 초안 작성 실패' : 'Chief of staff drafting failed';
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

export function ApprovalItem({ a }: { a: Approval }) {
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
  const unchecked = ceoChecks.length > checked.length;
  const decide = (decision: 'approved' | 'rejected', mode?: string) =>
    run(
      () =>
        api(`approvals/${a.id}/decide`, {
          body: { decision, ...(mode ? { mode } : {}), reason, ...(decision === 'approved' ? { attested: checked } : {}) },
        }),
      decision === 'approved' ? '승인했습니다.' : '반려했습니다.',
    ).then(reload);

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
                : `${lang === 'ko' ? '반영 방식' : 'Mode'}: ${d.mode === 'auto_after_approval' ? (lang === 'ko' ? '승인 후 자동 병합' : 'auto merge') : lang === 'ko' ? '브랜치만 생성' : 'branch only'}`}{' '}
            · {when(a.createdAt)}
          </div>
        </div>
        <div className="row">
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
      {a.kind === 'tool_permission' && (
        <pre className="code" style={{ marginTop: 8, maxHeight: 240 }}>
          {toolInputText(d.input)}
        </pre>
      )}
      {a.kind === 'integrate' && typeof d.summary === 'string' && d.summary && (
        <div className="note">
          <b>{lang === 'ko' ? '담당' : 'Assignee'}</b> {d.summary}
        </div>
      )}
      {a.kind === 'integrate' && d.mode !== 'review' && (
        <div className="note">
          <b>{lang === 'ko' ? '검수' : 'Review'}</b>{' '}
          {(d.review as { by: string; summary: string } | null)?.summary
            ? `${empName(state?.employees ?? [], (d.review as { by: string }).by)}: ${(d.review as { summary: string }).summary}`
            : lang === 'ko'
              ? '검수 의견 없음 (대표가 검수를 건너뛰었거나 이전 버전 승인 요청)'
              : 'No review verdict (review skipped by the CEO, or an older approval request)'}
        </div>
      )}
      {tk && ceoChecks.length > 0 && (
        <div className="ceo-checks">
          <div className="spread">
            <b>{lang === 'ko' ? '대표 직접 확인' : 'Your own check'}</b>
            <PreviewButton projectId={tk.projectId} ticketId={tk.id} />
          </div>
          <ScreenCheckPanel ticketId={tk.id} />
          {ceoChecks.map((r) => (
            <label key={r.id} className="check-row">
              <input
                type="checkbox"
                checked={checked.includes(r.id)}
                onChange={() => setChecked(checked.includes(r.id) ? checked.filter((x) => x !== r.id) : [...checked, r.id])}
              />
              <span>
                <b>{r.id}</b> {r.text}
              </span>
            </label>
          ))}
          <div className="spread">
            <span className="hint">
              {lang === 'ko'
                ? '실행해 보고 확인한 항목을 체크하세요. 모두 체크해야 승인할 수 있습니다.'
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
        </div>
      )}
      {a.kind === 'integrate' && tk?.reviewBelowRank && (
        <div className="banner warn" style={{ margin: '8px 0 0' }}>
          {lang === 'ko'
            ? `하위 직급 검수: ${empName(state?.employees ?? [], tk.assigneeId)}의 작업을 더 낮은 직급인 ${josa(empName(state?.employees ?? [], tk.reviewerId), '이/가')} 검수했습니다(같은 직급 이상 직원 없음). 변경 내용을 더 꼼꼼히 확인하고 승인하세요.`
            : `Lower-rank review: ${empName(state?.employees ?? [], tk.reviewerId)} reviewed work by a higher-ranked ${empName(state?.employees ?? [], tk.assigneeId)} (no peer available). Check the changes more closely before approving.`}
        </div>
      )}
      {d.mode === 'review' && Array.isArray(d.escalated) && (d.escalated as { id: string; text: string }[]).length > 0 && (
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
  );
}

export function Dashboard({ onNewTicket }: { onNewTicket: () => void }) {
  const { state, reload } = useCompany();
  const { t, lang, hold } = useT();
  const { busy, run } = useAction();
  if (!state) return <Skeleton />;
  const held = state.tickets.filter(needsCeo);
  const active = state.tickets.filter((x) => ACTIVE.includes(x.status) && !needsCeo(x));
  const done = state.tickets.filter((x) => x.status === 'done');
  const ko = lang === 'ko';

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{t('nav_dashboard')}</h1>
          <div className="sub">
            {ko
              ? '대표님이 결정할 일만 모았습니다. 나머지는 직원과 시스템이 처리합니다.'
              : 'Only what needs you. Employees and the system handle the rest.'}
          </div>
        </div>
      </div>

      <SetupGuide onNewTicket={onNewTicket} />

      <div className="grid cols-4" style={{ marginBottom: 16 }}>
        <div className={`card stat warn ${state.approvals.length > 0 ? 'hot' : ''}`}>
          <div className="label">
            <Icon name="inbox" /> {t('waitingApproval')}
          </div>
          <div className="value">{state.approvals.length}</div>
        </div>
        <div className="card stat bad">
          <div className="label">
            <Icon name="pause" /> {t('onHold')}
          </div>
          <div className="value">{held.length}</div>
        </div>
        <div className="card stat info">
          <div className="label">
            <Icon name="bolt" /> {t('inProgress')}
          </div>
          <div className="value">{active.length}</div>
        </div>
        <div className="card stat ok">
          <div className="label">
            <Icon name="check" /> {t('done')}
          </div>
          <div className="value">{done.length}</div>
        </div>
      </div>

      <div className="grid cols-2">
        <div className="grid" style={{ alignContent: 'start' }}>
          <RequestBox />
          <div className="card">
            <h2>
              <span className="row">
                <Icon name="inbox" /> {t('approvals')}
              </span>
              <span className="chip warn">{state.approvals.length}</span>
            </h2>
            {state.permissionDelegate && (
              <div className="note" style={{ margin: '10px 18px 0' }}>
                {ko
                  ? `권한 요청은 ${empName(state.employees, state.permissionDelegate)}(전체 자동)이 대신 처리합니다. 드라이브·시스템 폴더 삭제, 포맷, PC 종료 같은 치명적인 명령만 막고 나머지는 허용합니다. 결과는 최근 활동에 남습니다.`
                  : `Permission requests are handled by ${empName(state.employees, state.permissionDelegate)} (full auto): only catastrophic commands (drive/system deletes, formats, shutdown) are blocked. Results appear in recent activity.`}
              </div>
            )}
            <div className="list">
              {state.approvals.length === 0 ? (
                <EmptyState icon="inbox">{t('noApprovals')}</EmptyState>
              ) : (
                state.approvals.map((a) => <ApprovalItem key={a.id} a={a} />)
              )}
            </div>
          </div>
          <div className="card">
            <h2>
              <span className="row">
                <Icon name="pause" /> {t('held')}
              </span>
              <span className="chip bad">{held.length}</span>
            </h2>
            <div className="list">
              {held.length === 0 ? (
                <EmptyState icon="shield">{t('noHeld')}</EmptyState>
              ) : (
                held.map((x) => (
                  <div className="item" key={x.id}>
                    <div className="spread">
                      <div>
                        <div className="title">
                          <Link to={`/tickets/${x.id}`}>
                            {x.id} · {x.title}
                          </Link>
                        </div>
                        <div className="meta">
                          <StatusChip status={x.status} /> <span className="chip bad">{hold(x.hold!.reason)}</span> {when(x.hold!.since)}
                        </div>
                      </div>
                      {x.hold!.reason === 'needs_permission' && x.status === 'verifying' ? (
                        // 범위 밖 수정은 "허용/되돌리기"를 골라야 한다: 업무 화면에서 고른다.
                        <Link to={`/tickets/${x.id}`} className="btn small primary">
                          {ko ? '허용·되돌리기 고르기' : 'Allow or revert'}
                        </Link>
                      ) : (
                        <button
                          className="btn small"
                          disabled={busy}
                          onClick={() =>
                            run(() => api(`tickets/${x.id}/release`, { body: {} }), ko ? '보류를 해제했습니다.' : 'Released.').then(reload)
                          }
                        >
                          {t('release')}
                        </button>
                      )}
                    </div>
                    {x.hold!.note && <div className="note">{x.hold!.note}</div>}
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        <div className="grid" style={{ alignContent: 'start' }}>
          <TeamPanel />
          <UsagePanel />
          <div className="card">
            <h2>
              <span className="row">
                <Icon name="bolt" /> {t('inProgress')}
              </span>
            </h2>
            <div className="list">
              {active.length === 0 ? (
                <EmptyState icon="bolt">
                  <div>{t('empty')}</div>
                  {state.projects.length > 0 && (
                    <button className="btn small" style={{ marginTop: 10 }} onClick={onNewTicket}>
                      <Icon name="plus" /> {t('newTicket')}
                    </button>
                  )}
                </EmptyState>
              ) : (
                active.map((x) => (
                  <div className="item" key={x.id}>
                    <div className="title">
                      <Link to={`/tickets/${x.id}`}>
                        {x.id} · {x.title}
                      </Link>{' '}
                      <StatusChip status={x.status} /> <HoldChip ticket={x} />
                    </div>
                    <div className="meta">
                      {t('assignee')} {empName(state.employees, x.assigneeId)} · {t('reviewer')} {empName(state.employees, x.reviewerId)} ·{' '}
                      {x.ownerId ? `${ko ? '책임' : 'Owner'} ${empName(state.employees, x.ownerId)} · ` : ''}
                      {t('round')} {x.round}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
          <ProjectsPanel />
          <div className="card">
            <h2>
              <span className="row">
                <Icon name="activity" /> {t('activity')}
              </span>
            </h2>
            {state.events.length === 0 && <EmptyState icon="activity">{ko ? '아직 기록이 없습니다.' : 'Nothing yet.'}</EmptyState>}
            <ul className="timeline">
              {[...state.events]
                .reverse()
                .filter((e) => !isNoiseEvent(e, state))
                .slice(0, 25)
                .map((e) => (
                  <li key={e.seq}>
                    <span className="when">{new Date(e.ts).toLocaleTimeString()}</span>
                    <span>{describeEvent(e, state, lang)}</span>
                  </li>
                ))}
            </ul>
          </div>
        </div>
      </div>
    </>
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
  const doing = (id: string) => {
    const work = state.tickets.find((x) => x.assigneeId === id && ['in_progress', 'changes_requested'].includes(x.status));
    if (work) return { tone: 'info', text: ko ? `${work.id} 작업 중` : `Working on ${work.id}`, to: work.id };
    const review = state.tickets.find((x) => x.reviewerId === id && x.status === 'in_review');
    if (review) return { tone: 'accent', text: ko ? `${review.id} 검수 중` : `Reviewing ${review.id}`, to: review.id };
    const drafting = state.requests.filter((r) => r.employeeId === id && r.status === 'drafting').length;
    if (drafting)
      return { tone: 'info', text: ko ? `업무 초안 작성 중${drafting > 1 ? ` (${drafting}건)` : ''}` : `Drafting tickets`, to: null };
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
                    <Link to={`/tickets/${d.to}`} className={`chip ${d.tone} pulse`}>
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
        {state.projects.map((p) => {
          const open = state.tickets.filter((x) => x.projectId === p.id && !['done', 'failed', 'cancelled'].includes(x.status)).length;
          const done = state.tickets.filter((x) => x.projectId === p.id && x.status === 'done').length;
          return (
            <div className="item" key={p.id}>
              <div className="spread">
                <div className="title">{p.name}</div>
                <span className="row" style={{ gap: 6 }}>
                  <span className="chip info">{ko ? `진행 ${open}` : `${open} open`}</span>
                  <span className="chip ok">{ko ? `완료 ${done}` : `${done} done`}</span>
                </span>
              </div>
              <div className="meta mono">{p.originPath}</div>
              <div className="meta">
                {p.baseBranch} · {ko ? `검증 명령 ${p.verifyCommands.length}개` : `${p.verifyCommands.length} verify commands`} ·{' '}
                {p.integrationMode === 'auto_after_approval' ? (ko ? '승인 후 자동 병합' : 'auto merge') : ko ? '브랜치만' : 'branch only'}
              </div>
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
  if (!state) return null;
  const ko = lang === 'ko';
  const hasProject = state.projects.length > 0;
  const hasTeam = state.employees.filter((e) => e.active).length >= 2;
  const hasTicket = state.tickets.length > 0 || state.requests.length > 0;
  if (hasProject && hasTeam && hasTicket) return null;
  const steps = [
    {
      done: hasProject,
      t: ko ? '프로젝트 등록' : 'Register a project',
      d: ko ? '작업할 저장소와 검증 명령을 알려 주세요.' : 'Point to a repository and its verify commands.',
      cta: ko ? '프로젝트로' : 'Projects',
      onClick: () => go('/projects'),
    },
    {
      done: hasTeam,
      t: ko ? '직원 2명 이상 채용' : 'Hire 2+ employees',
      d: ko ? '구현과 검수는 서로 다른 CLI로 두는 것이 좋습니다.' : 'Use different CLIs for implementing and reviewing.',
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
          {ko ? `${doneCount}/3 완료 · 세 단계면 첫 업무를 맡길 수 있습니다.` : `${doneCount}/3 done · three steps to your first ticket.`}
        </div>
        <div className="steps">
          {steps.map((x, i) => (
            <div key={i} className={`step ${x.done ? 'done' : i === next ? 'next' : ''}`}>
              <span className="num">{x.done ? <Icon name="check" size={14} /> : i + 1}</span>
              <span className="t">{x.t}</span>
              <span className="d">{x.d}</span>
              {!x.done && (
                <button className={`btn small ${i === next ? 'primary' : ''}`} disabled={i === 2 && !hasProject} onClick={x.onClick}>
                  {x.cta} <Icon name="arrow" size={14} />
                </button>
              )}
            </div>
          ))}
        </div>
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

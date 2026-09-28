import { useState } from 'react';
import { api, type Approval, type DomainEvent, type State } from '../api.ts';
import { Link, useCompany } from '../App.tsx';
import { useT } from '../i18n.ts';
import { empName, HoldChip, Modal, StatusChip, useAction, when } from '../components/ui.tsx';
import { RequestBox } from './Requests.tsx';

const ACTIVE = ['assigned', 'in_progress', 'verifying', 'in_review', 'changes_requested', 'integrating'];

export function describeEvent(e: DomainEvent, s: State | null, lang: string): string {
  const p = (e.payload ?? {}) as Record<string, unknown>;
  const who = (id: unknown) => (s ? empName(s.employees, String(id)) : String(id));
  const ko = lang === 'ko';
  switch (e.type) {
    case 'ticket.created': return ko ? `${e.entityId} 업무 생성: ${p.title}` : `${e.entityId} created: ${p.title}`;
    case 'ticket.assigned': return ko ? `${e.entityId} 배정 — 담당 ${who(p.assigneeId)}, 검수 ${who(p.reviewerId)}` : `${e.entityId} assigned to ${who(p.assigneeId)}, reviewer ${who(p.reviewerId)}`;
    case 'ticket.in_progress': return ko ? `${e.entityId} 작업 시작 (${p.runCount}번째 실행)` : `${e.entityId} work started (run #${p.runCount})`;
    case 'ticket.verifying': return ko ? `${e.entityId} 제출 → 시스템 검증 중` : `${e.entityId} submitted → verifying`;
    case 'ticket.in_review': return ko ? `${e.entityId} 검증 통과 → 독립 검수` : `${e.entityId} verified → independent review`;
    case 'ticket.changes_requested': return ko ? `${e.entityId} 수정 요청: ${String(p.reason ?? '').split('\n')[0]}` : `${e.entityId} changes requested: ${String(p.reason ?? '').split('\n')[0]}`;
    case 'ticket.awaiting_approval': return ko ? `${e.entityId} 검수 승인 → 대표 승인 대기` : `${e.entityId} review approved → awaiting CEO`;
    case 'ticket.integrating': return ko ? `${e.entityId} 대표 승인 → 반영 중` : `${e.entityId} CEO approved → integrating`;
    case 'ticket.done': return ko ? `${e.entityId} 완료 (${String(p.commitSha ?? '').slice(0, 8)})` : `${e.entityId} done (${String(p.commitSha ?? '').slice(0, 8)})`;
    case 'ticket.held': return ko ? `${e.entityId} 보류: ${p.reason}` : `${e.entityId} on hold: ${p.reason}`;
    case 'ticket.scope_violation': return ko ? `⚠ ${e.entityId} 범위 밖 수정 탐지: ${(p.paths as string[]).join(', ')}` : `⚠ ${e.entityId} out-of-scope change: ${(p.paths as string[]).join(', ')}`;
    case 'ticket.run_aborted': return ko ? `${e.entityId} 실행 중단: ${p.reason}` : `${e.entityId} run aborted: ${p.reason}`;
    case 'ticket.waiting_lock': return ko ? `${e.entityId} 대기: ${p.conflictWith}와 쓰기 범위가 겹쳐 순서를 기다립니다` : `${e.entityId} waiting: write scope overlaps ${p.conflictWith}`;
    case 'ticket.released': return ko ? `${e.entityId} 보류 해제` : `${e.entityId} hold released`;
    case 'request.submitted': return ko ? `대표 요청 → 비서실장: ${String(p.text ?? '').slice(0, 60)}` : `Request to chief of staff: ${String(p.text ?? '').slice(0, 60)}`;
    case 'request.drafted': return ko ? `비서실장이 업무 초안 ${p.count}개 작성` : `Chief of staff drafted ${p.count} tickets`;
    case 'request.accepted': return ko ? `대표가 초안 확정: ${(p.tickets as string[]).join(', ')}` : `CEO accepted drafts: ${(p.tickets as string[]).join(', ')}`;
    case 'evidence.attested': return ko ? `${e.entityId} ${p.requirementId} 대표 직접 확인` : `${e.entityId} ${p.requirementId} attested by CEO`;
    case 'ticket.deliberation_done': return ko ? `${e.entityId} 교차 검토 종합: 주장 ${p.claims}개, 미해결 ${p.escalated}개` : `${e.entityId} deliberation: ${p.claims} claims, ${p.escalated} unresolved`;
    case 'employee.hired': return ko ? `직원 추가: ${p.name}` : `Hired ${p.name}`;
    case 'approval.requested': return ko ? `승인 요청: ${p.summary}` : `Approval requested: ${p.summary}`;
    case 'orchestrator.recovered': return ko ? '재시작 복구 완료' : 'Recovered after restart';
    default:
      if (e.type.startsWith('deliberation.')) return `${e.entityId} ${who(e.actor)} ${e.type.split('.')[1]} ${p.summary ?? ''}${p.error ? ` ✗ ${p.error}` : ''}`;
      if (e.type.startsWith('run.')) return `${e.entityId} ${e.type.replace('run.', '')}${p.failureClass ? ` (${p.failureClass})` : ''}`;
      return `${e.type} ${e.entityId}`;
  }
}

export function ApprovalItem({ a }: { a: Approval }) {
  const { reload, state } = useCompany();
  const { t, lang } = useT();
  const { busy, run } = useAction();
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const d = (a.detail ?? {}) as Record<string, unknown>;
  const decide = (decision: 'approved' | 'rejected', mode?: string) =>
    run(() => api(`approvals/${a.id}/decide`, { body: { decision, ...(mode ? { mode } : {}), reason } }), decision === 'approved' ? '승인했습니다.' : '반려했습니다.').then(reload);

  return (
    <div className="item">
      <div className="spread">
        <div>
          <div className="title">
            {a.kind === 'tool_permission' ? '🔐 ' : '✅ '}
            {a.ticketId ? <Link to={`/tickets/${a.ticketId}`}>{a.summary}</Link> : a.summary}
          </div>
          <div className="meta">
            {a.kind === 'tool_permission'
              ? `${empName(state?.employees ?? [], a.requestedBy)} · ${String(d.tool)}`
              : `${lang === 'ko' ? '반영 방식' : 'Mode'}: ${d.mode === 'auto_after_approval' ? (lang === 'ko' ? '승인 후 자동 병합' : 'auto merge') : lang === 'ko' ? '브랜치만 생성' : 'branch only'}`}{' '}
            · {when(a.createdAt)}
          </div>
        </div>
        <div className="row">
          {a.kind === 'integrate' && d.mode === 'auto_after_approval' ? (
            <>
              <button className="btn ok small" disabled={busy} onClick={() => decide('approved', 'auto_after_approval')}>{t('approveMerge')}</button>
              <button className="btn small" disabled={busy} onClick={() => decide('approved', 'manual')}>{t('approveBranch')}</button>
            </>
          ) : (
            <button className="btn ok small" disabled={busy} onClick={() => decide('approved')}>{t('approve')}</button>
          )}
          <button className="btn danger small" disabled={busy} onClick={() => setRejecting(true)}>{t('reject')}</button>
        </div>
      </div>
      {a.kind === 'tool_permission' && <pre className="code" style={{ marginTop: 8, maxHeight: 160 }}>{JSON.stringify(d.input, null, 2)}</pre>}
      {a.kind === 'integrate' && typeof d.summary === 'string' && d.summary && <div className="note">{d.summary}</div>}
      {d.mode === 'review' && Array.isArray(d.escalated) && (d.escalated as { id: string; text: string }[]).length > 0 && (
        <div className="note">{lang === 'ko' ? '미해결 이견 (대표 판단 필요):' : 'Unresolved disputes:'}{'\n'}{(d.escalated as { id: string; text: string }[]).map((c) => `• ${c.text}`).join('\n')}</div>
      )}
      {rejecting && (
        <Modal
          title={t('reject')}
          onClose={() => setRejecting(false)}
          actions={<button className="btn danger" disabled={busy} onClick={() => decide('rejected').then(() => setRejecting(false))}>{t('reject')}</button>}
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
  if (!state) return <div className="emptystate">{t('loading')}</div>;
  const held = state.tickets.filter((x) => x.hold);
  const active = state.tickets.filter((x) => ACTIVE.includes(x.status) && !x.hold);
  const done = state.tickets.filter((x) => x.status === 'done');
  const ko = lang === 'ko';

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{t('nav_dashboard')}</h1>
          <div className="sub">{ko ? '대표님이 결정할 일만 모았습니다. 나머지는 직원과 시스템이 처리합니다.' : 'Only what needs you. Employees and the system handle the rest.'}</div>
        </div>
      </div>

      {state.projects.length === 0 && (
        <div className="banner info">
          {ko ? '먼저 ' : 'Start by '}
          <Link to="/projects">{ko ? '프로젝트를 등록' : 'registering a project'}</Link>
          {ko ? '하고 ' : ' and '}
          <Link to="/org">{ko ? '직원을 2명 이상 추가' : 'adding at least 2 employees'}</Link>
          {ko ? '하세요.' : '.'}
        </div>
      )}

      <div className="grid cols-4" style={{ marginBottom: 16 }}>
        <div className="card stat"><div className="label">{t('waitingApproval')}</div><div className="value">{state.approvals.length}</div></div>
        <div className="card stat"><div className="label">{t('onHold')}</div><div className="value">{held.length}</div></div>
        <div className="card stat"><div className="label">{t('inProgress')}</div><div className="value">{active.length}</div></div>
        <div className="card stat"><div className="label">{t('done')}</div><div className="value">{done.length}</div></div>
      </div>

      <div className="grid cols-2">
        <div className="grid" style={{ alignContent: 'start' }}>
          <RequestBox />
          <div className="card">
            <h2>{t('approvals')} <span className="chip warn">{state.approvals.length}</span></h2>
            <div className="list">
              {state.approvals.length === 0 ? <div className="emptystate">{t('noApprovals')}</div> : state.approvals.map((a) => <ApprovalItem key={a.id} a={a} />)}
            </div>
          </div>
          <div className="card">
            <h2>{t('held')} <span className="chip bad">{held.length}</span></h2>
            <div className="list">
              {held.length === 0 ? (
                <div className="emptystate">{t('noHeld')}</div>
              ) : (
                held.map((x) => (
                  <div className="item" key={x.id}>
                    <div className="spread">
                      <div>
                        <div className="title"><Link to={`/tickets/${x.id}`}>{x.id} · {x.title}</Link></div>
                        <div className="meta"><StatusChip status={x.status} /> <span className="chip bad">{hold(x.hold!.reason)}</span> {when(x.hold!.since)}</div>
                      </div>
                      <button className="btn small" disabled={busy} onClick={() => run(() => api(`tickets/${x.id}/release`, { body: {} }), ko ? '보류를 해제했습니다.' : 'Released.').then(reload)}>{t('release')}</button>
                    </div>
                    {x.hold!.note && <div className="note">{x.hold!.note}</div>}
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        <div className="grid" style={{ alignContent: 'start' }}>
          <div className="card">
            <h2>{t('inProgress')}</h2>
            <div className="list">
              {active.length === 0 ? (
                <div className="emptystate">
                  {t('empty')}{' '}
                  {state.projects.length > 0 && <button className="btn small" onClick={onNewTicket}>+ {t('newTicket')}</button>}
                </div>
              ) : (
                active.map((x) => (
                  <div className="item" key={x.id}>
                    <div className="title"><Link to={`/tickets/${x.id}`}>{x.id} · {x.title}</Link> <StatusChip status={x.status} /> <HoldChip ticket={x} /></div>
                    <div className="meta">{t('assignee')} {empName(state.employees, x.assigneeId)} · {t('reviewer')} {empName(state.employees, x.reviewerId)} · {t('round')} {x.round}</div>
                  </div>
                ))
              )}
            </div>
          </div>
          <div className="card">
            <h2>{t('activity')}</h2>
            <ul className="timeline">
              {[...state.events].reverse().slice(0, 25).map((e) => (
                <li key={e.seq}><span className="when">{new Date(e.ts).toLocaleTimeString()}</span><span>{describeEvent(e, state, lang)}</span></li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </>
  );
}

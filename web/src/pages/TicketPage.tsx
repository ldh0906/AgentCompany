import { useCallback, useEffect, useState } from 'react';
import { api, type Approval, type Claim, type DomainEvent, type Evidence, type RunSummary, type Ticket } from '../api.ts';
import { Link, useCompany } from '../App.tsx';
import { useT } from '../i18n.ts';
import { fmtTokens } from '../components/usage.tsx';
import { CliChip, DiffView, empName, HoldChip, Icon, Modal, StatusChip, useAction, when, Skeleton } from '../components/ui.tsx';
import { ApprovalItem, describeEvent, isNoiseEvent } from './Dashboard.tsx';
import { PreviewButton } from '../components/preview.tsx';
import { DeliverableView } from '../components/deliverable.tsx';

interface Detail {
  ticket: Ticket;
  runs: (RunSummary & { report?: unknown; finalText?: string | null })[];
  evidence: Evidence[];
  claims: Claim[];
  approvals: Approval[];
  events: DomainEvent[];
  /** 담당자가 범위 밖 파일 수정 허가를 요청했으면 */
  scopeRequest?: { paths: string[]; reason: string } | null;
  /** 승인 때 "나중에 확인"으로 미룬 대표 직접 확인 */
  laterChecks?: { id: string; text: string; at: string }[];
}

export function TicketPage({ id }: { id: string }) {
  const { state, reload } = useCompany();
  const { t, lang, evidence: evLabel, role, hold: holdLabel, difficulty: difficultyLabel } = useT();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [tab, setTab] = useState<'timeline' | 'runs' | 'diff' | 'claims'>(() => {
    const q = new URLSearchParams(location.search).get('tab');
    return q === 'runs' || q === 'diff' || q === 'claims' ? q : 'timeline';
  });
  const [diff, setDiff] = useState<{ diff: string; changedPaths: string[] } | null>(null);
  const [log, setLog] = useState<{ id: string; text: string; reportError: string | null } | null>(null);
  const [assigning, setAssigning] = useState(false);
  const [answer, setAnswer] = useState('');
  const [scopeAdd, setScopeAdd] = useState('');
  const { busy, run } = useAction();
  const ko = lang === 'ko';

  const load = useCallback(() => {
    api<Detail>(`tickets/${id}`)
      .then(setDetail)
      .catch(() => setDetail(null));
  }, [id]);
  useEffect(load, [load, state]);
  useEffect(() => {
    if (tab === 'diff') api<{ diff: string; changedPaths: string[] }>(`tickets/${id}/diff`).then(setDiff);
  }, [tab, id, state]);

  if (!detail || !state) return <Skeleton />;
  const tk = detail.ticket;
  const pending = detail.approvals.filter((a) => a.state === 'pending');
  const budget = state.budgets?.[tk.id];
  const latestHead = detail.runs.filter((r) => r.kind === 'work' && r.headSha).at(-1)?.headSha;

  return (
    <>
      <div className="page-head">
        <div>
          <div className="sub">
            <Link to="/board">{t('nav_board')}</Link> / {tk.id}
          </div>
          <h1>
            {tk.title} <StatusChip status={tk.status} /> <HoldChip ticket={tk} />
            {tk.reviewBelowRank && <span className="chip warn">{ko ? '하위 직급 검수' : 'Lower-rank review'}</span>}
          </h1>
          <div className="sub">
            {tk.ownerId && (
              <>
                {ko ? '책임' : 'Owner'} <b>{empName(state.employees, tk.ownerId)}</b> ·{' '}
              </>
            )}
            {t('assignee')} <b>{empName(state.employees, tk.assigneeId)}</b> · {t('reviewer')}{' '}
            <b>{empName(state.employees, tk.reviewerId)}</b> · {ko ? '난이도' : 'Difficulty'} {difficultyLabel(tk.difficulty)} ·{' '}
            {t('round')} {tk.round}/{tk.budget.maxRounds} · {ko ? '실행' : 'runs'} {tk.runCount}/{tk.budget.maxRuns}
            {budget && ` · ${fmtTokens(budget.used, lang)} / ${fmtTokens(budget.budget, lang)} ${ko ? '토큰' : 'tokens'}`}
          </div>
          {budget && budget.used > 0 && (
            <div className="bar" style={{ marginTop: 6, maxWidth: 360 }} title={ko ? '토큰 예산 사용량' : 'Token budget used'}>
              <i
                style={{
                  width: `${Math.min(100, Math.round((budget.used / budget.budget) * 100))}%`,
                  background:
                    budget.used >= budget.budget ? 'var(--bad)' : budget.used >= budget.budget * 0.7 ? 'var(--warn)' : 'var(--ok)',
                }}
              />
            </div>
          )}
        </div>
        <div className="row">
          <Link to={`/chat/${encodeURIComponent(`t:${tk.id}`)}`} className="btn">
            {ko ? '업무방 대화' : 'Ticket chat'}
          </Link>
          {!tk.hold && !['done', 'failed', 'cancelled', 'integrating'].includes(tk.status) && (
            <button
              className="btn"
              disabled={busy}
              title={ko ? '이 업무를 멈춥니다. "보류 해제"로 다시 시작합니다.' : 'Pause this ticket; release the hold to resume.'}
              onClick={() => run(() => api(`tickets/${tk.id}/pause`, { body: {} }), ko ? '업무를 멈췄습니다.' : 'Paused.').then(reload)}
            >
              {ko ? '멈춤' : 'Pause'}
            </button>
          )}
          {latestHead && !['done', 'failed', 'cancelled'].includes(tk.status) && (
            <PreviewButton projectId={tk.projectId} ticketId={tk.id} />
          )}
          {latestHead && ['in_review', 'changes_requested'].includes(tk.status) && (
            <button
              className="btn"
              disabled={busy}
              title={
                ko
                  ? '직원에게 한 회차 더 시키지 않고, 마지막 제출물을 지금 검증 명령으로 다시 검증하고 검수합니다(검증 명령을 바꾼 뒤 등).'
                  : 'Re-run verification and review on the last submission without another work round (e.g. after changing verify commands).'
              }
              onClick={() =>
                run(() => api(`tickets/${tk.id}/reverify`, { body: {} }), ko ? '다시 검증합니다.' : 'Re-verifying.').then(reload)
              }
            >
              {ko ? '다시 검증' : 'Re-verify'}
            </button>
          )}
          {tk.hold?.reason === 'needs_decision' && ['in_review', 'changes_requested'].includes(tk.status) && (
            <button
              className="btn primary"
              disabled={busy}
              title={
                ko
                  ? '시스템 검증을 통과한 마지막 제출물을 대표 승인 단계로 보냅니다. 검수 결과는 참고만 합니다.'
                  : 'Send the last submission that passed verification to your approval. The review is advisory.'
              }
              onClick={() =>
                run(() => api(`tickets/${tk.id}/skip-review`, { body: {} }), ko ? '승인 단계로 보냈습니다.' : 'Sent to approval.').then(
                  reload,
                )
              }
            >
              {ko ? '검수 건너뛰고 승인 단계로' : 'Skip review → approval'}
            </button>
          )}
          {tk.hold && !(tk.hold.reason === 'needs_permission' && tk.status === 'verifying') && (
            <button
              className="btn"
              disabled={busy}
              title={
                ko
                  ? '보류 전 단계로 되돌립니다. 수정 요청 상태면 직원이 한 회차 더 작업합니다.'
                  : 'Resume. From changes requested, the employee works one more round.'
              }
              onClick={() => run(() => api(`tickets/${tk.id}/release`, { body: {} }), ko ? '보류를 풀었습니다.' : 'Released.').then(reload)}
            >
              {tk.status === 'changes_requested' ? (ko ? '한 회차 더 시키기' : 'One more round') : t('release')}
            </button>
          )}
          {tk.status === 'backlog' && (
            <button className="btn" onClick={() => setAssigning(true)}>
              {ko ? '직접 배정' : 'Assign'}
            </button>
          )}
          {!['done', 'failed', 'cancelled'].includes(tk.status) && (
            <button
              className="btn danger"
              disabled={busy}
              onClick={() =>
                confirm(ko ? '이 업무를 취소할까요?' : 'Cancel this ticket?') &&
                run(() => api(`tickets/${tk.id}/cancel`, { body: {} }), ko ? '업무를 취소했습니다.' : 'Ticket cancelled.').then(reload)
              }
            >
              {t('cancel')}
            </button>
          )}
        </div>
      </div>

      {(detail.laterChecks ?? []).length > 0 && (
        <div className="banner info">
          <b>{ko ? '나중에 확인하기로 한 것' : 'Checks you deferred'}</b>
          {detail.laterChecks!.map((x) => (
            <div key={x.id} style={{ marginTop: 8 }}>
              <div>
                <b>{x.id}</b> {x.text}
              </div>
              <div className="row" style={{ marginTop: 6 }}>
                <PreviewButton projectId={tk.projectId} ticketId={null} />
                <button
                  className="btn small ok"
                  disabled={busy}
                  onClick={() =>
                    run(
                      () => api(`tickets/${tk.id}/later-check`, { body: { requirementId: x.id, ok: true } }),
                      ko ? '확인했다고 기록했습니다.' : 'Recorded.',
                    ).then(() => (load(), reload()))
                  }
                >
                  {ko ? '확인했어요' : 'Looks right'}
                </button>
                <button
                  className="btn small"
                  disabled={busy}
                  onClick={() => {
                    const note = prompt(ko ? '무엇이 다른가요? (비워 둬도 됩니다)' : 'What is wrong? (optional)');
                    if (note === null) return;
                    void run(
                      () => api(`tickets/${tk.id}/later-check`, { body: { requirementId: x.id, ok: false, note } }),
                      ko ? '비서실장에게 고칠 일을 요청했습니다.' : 'Asked the chief of staff for a fix.',
                    ).then(() => (load(), reload()));
                  }}
                >
                  {ko ? '문제 있어요' : 'Something is wrong'}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {tk.hold && (
        <div className="banner warn">
          <b className="row" style={{ display: 'inline-flex' }}>
            <Icon name="pause" size={14} /> {holdLabel(tk.hold.reason)}
          </b>
          <div style={{ whiteSpace: 'pre-wrap', marginTop: 4 }}>{tk.hold.note}</div>
          {detail.scopeRequest && tk.hold.reason === 'needs_decision' && (
            <div style={{ marginTop: 8 }}>
              <div className="sub">
                {ko
                  ? '담당자가 이 업무에 허락된 파일 밖의 파일도 고쳐야 한다고 요청했습니다. 허용하면 바로 이어서 작업합니다.'
                  : 'The assignee asks to also edit files outside this ticket’s area. Allowing resumes the work.'}
              </div>
              <div className="row" style={{ marginTop: 6 }}>
                <button
                  className="btn small primary"
                  disabled={busy}
                  onClick={() =>
                    run(
                      () => api(`tickets/${tk.id}/scope-add`, { body: { paths: detail.scopeRequest!.paths } }),
                      ko ? '허용하고 계속합니다.' : 'Allowed.',
                    ).then(reload)
                  }
                >
                  {ko ? `${detail.scopeRequest.paths.join(', ')} 허용하고 계속` : 'Allow and continue'}
                </button>
              </div>
            </div>
          )}
          {tk.hold.reason === 'needs_permission' && tk.status === 'verifying' && (
            <div style={{ marginTop: 8 }}>
              <div className="sub">
                {ko
                  ? '직원이 이 업무에 허락된 파일 밖을 고쳤습니다. 괜찮은 변경이면 허용하고, 아니면 되돌리게 하세요.'
                  : 'The employee changed files outside this ticket’s allowed area. Allow it if fine, otherwise ask for a revert.'}
              </div>
              <div className="row" style={{ marginTop: 6 }}>
                <button
                  className="btn small primary"
                  disabled={busy}
                  onClick={() =>
                    run(() => api(`tickets/${tk.id}/scope`, { body: { allow: true } }), ko ? '허용하고 계속합니다.' : 'Allowed.').then(
                      reload,
                    )
                  }
                >
                  {ko ? '이 파일 변경 허용하고 계속' : 'Allow and continue'}
                </button>
                <button
                  className="btn small"
                  disabled={busy}
                  onClick={() =>
                    run(
                      () => api(`tickets/${tk.id}/scope`, { body: { allow: false } }),
                      ko ? '되돌리라고 했습니다.' : 'Revert requested.',
                    ).then(reload)
                  }
                >
                  {ko ? '직원에게 되돌리게 하기' : 'Ask to revert'}
                </button>
              </div>
            </div>
          )}
          {/토큰 예산|Token budget/.test(tk.hold.note) && (
            <div className="row" style={{ marginTop: 10, justifyContent: 'flex-end' }}>
              <button
                className="btn primary"
                disabled={busy}
                onClick={() =>
                  run(
                    () => api(`tickets/${tk.id}/budget`, { body: {} }),
                    ko ? '예산을 늘리고 다시 시작했습니다.' : 'Budget raised; resumed.',
                  ).then(reload)
                }
              >
                {ko ? '예산 50% 늘리고 계속' : 'Raise budget 50% and continue'}
              </button>
            </div>
          )}
          {tk.hold.reason === 'needs_decision' && tk.status === 'assigned' && !/토큰 예산|Token budget/.test(tk.hold.note) && (
            <div className="form" style={{ marginTop: 10 }}>
              <textarea
                value={answer}
                onChange={(e) => setAnswer(e.target.value)}
                placeholder={
                  ko
                    ? '직원의 질문에 답하세요. 답은 프로젝트 규칙으로 남아 모든 직원이 따릅니다.'
                    : 'Answer the questions. Recorded as a decision for everyone.'
                }
              />
              <div className="row" style={{ justifyContent: 'flex-end' }}>
                <button
                  className="btn"
                  disabled={busy}
                  onClick={() =>
                    run(
                      () => api(`tickets/${tk.id}/answer`, { body: {} }),
                      ko ? '직원 판단에 맡기고 재개했습니다.' : 'Left to the employee; resumed.',
                    ).then(reload)
                  }
                >
                  {ko ? '직원 판단에 맡기고 재개' : 'Let the employee decide'}
                </button>
                <button
                  className="btn primary"
                  disabled={busy || !answer.trim()}
                  onClick={() =>
                    run(
                      () => api(`tickets/${tk.id}/answer`, { body: { answer } }),
                      ko ? '답을 기록하고 재개했습니다.' : 'Answered; resumed.',
                    ).then((ok) => ok && (setAnswer(''), reload()))
                  }
                >
                  {ko ? '답하고 재개' : 'Answer and resume'}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
      {pending.length > 0 && (
        <div className="card" style={{ marginBottom: 16 }}>
          <h2>{t('approvals')}</h2>
          <div className="list">
            {pending.map((a) => (
              <ApprovalItem key={a.id} a={a} />
            ))}
          </div>
        </div>
      )}

      <div className="grid cols-2">
        <div className="card">
          <h2>
            {t('requirements')} × {t('evidence')}
          </h2>
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>{t('requirements')}</th>
                <th>{ko ? '필요 증거' : 'Needs'}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {tk.requirements.map((r) => {
                const attested = detail.evidence.some(
                  (e) => e.type === 'human_attest' && e.requirementId === r.id && e.headSha === latestHead,
                );
                return (
                  <tr key={r.id}>
                    <td className="mono">{r.id}</td>
                    <td>{r.text}</td>
                    <td>
                      <span className="chip">{evLabel(r.evidenceType)}</span>
                    </td>
                    <td>
                      {attested ? (
                        <span className="chip ok">✓ {ko ? '대표 확인' : 'Attested'}</span>
                      ) : (
                        latestHead &&
                        r.evidenceType === 'human_attest' &&
                        !['done', 'failed', 'cancelled', 'backlog', 'assigned'].includes(tk.status) && (
                          <button
                            className="btn small"
                            disabled={busy}
                            onClick={() => {
                              const note = prompt(
                                ko
                                  ? `${r.id}을(를) 직접 확인했습니다. 확인 내용을 남겨 주세요 (현재 제출 커밋 ${latestHead.slice(0, 8)}에 묶입니다):`
                                  : `Attest ${r.id} for commit ${latestHead.slice(0, 8)}. Note:`,
                              );
                              if (note !== null)
                                void run(
                                  () => api(`tickets/${tk.id}/attest`, { body: { requirementId: r.id, note } }),
                                  ko ? '직접 확인을 기록했습니다.' : 'Confirmation recorded.',
                                ).then(reload);
                            }}
                          >
                            {ko ? '직접 확인' : 'Attest'}
                          </button>
                        )
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="body">
            <div className="sub" style={{ marginBottom: 6 }}>
              {ko ? '시스템이 직접 만든 증거 (직원의 주장이 아님)' : 'Evidence produced by the system (not employee claims)'}
            </div>
            {detail.evidence.length === 0 ? (
              <div className="sub">{t('empty')}</div>
            ) : (
              <table>
                <tbody>
                  {detail.evidence.map((e) => (
                    <tr key={e.id} style={{ opacity: e.headSha === latestHead ? 1 : 0.55 }}>
                      <td className="mono">{e.id.slice(0, 9)}</td>
                      <td>
                        {e.passed ? <span className="chip ok">PASS</span> : <span className="chip bad">FAIL</span>} {evLabel(e.type)}
                      </td>
                      <td>
                        {e.label}
                        <div className="sub mono">{e.argv?.join(' ')}</div>
                        {!e.passed && (
                          <pre className="code" style={{ maxHeight: 120 }}>
                            {e.summary}
                          </pre>
                        )}
                      </td>
                      <td className="sub">{ko ? `${e.round}회차` : `round ${e.round}`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
        <div className="card">
          <h2>{ko ? '업무 정보' : 'Details'}</h2>
          <div className="body">
            <div>
              <b>{ko ? '목적' : 'Purpose'}</b>
              <div className="note">{tk.purpose || '—'}</div>
            </div>
            <div style={{ marginTop: 10 }}>
              <b>{ko ? '완료 조건' : 'Done criteria'}</b>
              <div className="note">{tk.doneCriteria}</div>
            </div>
            <div style={{ marginTop: 10 }}>
              <b>{ko ? '쓰기 허용 범위' : 'Write scope'}</b>
              <div className="row" style={{ marginTop: 4 }}>
                {tk.writeScope.map((g) => (
                  <code key={g} className="chip">
                    {g}
                  </code>
                ))}
              </div>
              {!['done', 'failed', 'cancelled'].includes(tk.status) && (
                // 대표가 파일을 더 허락한다(예: 담당자가 "이 테스트도 고쳐야 한다"고 할 때)
                <div className="row" style={{ marginTop: 6 }}>
                  <input
                    className="mono"
                    value={scopeAdd}
                    onChange={(e) => setScopeAdd(e.target.value)}
                    placeholder={ko ? '허락할 파일 경로 (예: tests/game/boss.test.ts)' : 'Path to allow'}
                    style={{ flex: 1 }}
                  />
                  <button
                    className="btn small"
                    disabled={busy || !scopeAdd.trim()}
                    onClick={() =>
                      run(
                        () => api(`tickets/${tk.id}/scope-add`, { body: { paths: [scopeAdd.trim()] } }),
                        ko ? '허락했습니다.' : 'Added.',
                      ).then((ok) => ok && (setScopeAdd(''), reload()))
                    }
                  >
                    {ko ? '허락' : 'Allow'}
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="tabs">
          <button className={tab === 'timeline' ? 'on' : ''} onClick={() => setTab('timeline')}>
            {t('timeline')}
          </button>
          <button className={tab === 'runs' ? 'on' : ''} onClick={() => setTab('runs')}>
            {t('runs')} ({detail.runs.length})
          </button>
          {tk.type !== 'review' && (
            <button className={tab === 'diff' ? 'on' : ''} onClick={() => setTab('diff')}>
              {t('diff')}
            </button>
          )}
          {detail.claims.length > 0 && (
            <button className={tab === 'claims' ? 'on' : ''} onClick={() => setTab('claims')}>
              {ko ? '주장 원장' : 'Claim ledger'} ({detail.claims.length})
            </button>
          )}
        </div>
        {tab === 'claims' && <ClaimLedger claims={detail.claims} />}
        {tab === 'timeline' && (
          <ul className="timeline">
            {detail.events
              .filter((e) => !isNoiseEvent(e, state))
              .map((e) => (
                <li key={e.seq}>
                  <span className="when">{new Date(e.ts).toLocaleString()}</span>
                  <span>
                    {describeEvent(e, state, lang)}
                    {e.type === 'ticket.changes_requested' && (
                      <div className="note">{String((e.payload as { reason?: string }).reason ?? '')}</div>
                    )}
                  </span>
                </li>
              ))}
          </ul>
        )}
        {tab === 'runs' && (
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>{ko ? '종류' : 'Kind'}</th>
                <th>{ko ? '직원' : 'Employee'}</th>
                <th>{ko ? '결과' : 'Result'}</th>
                <th>{ko ? '요약' : 'Summary'}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {detail.runs.map((r) => {
                const emp = state.employees.find((e) => e.id === r.employeeId);
                return (
                  <tr key={r.id}>
                    <td className="mono">
                      {r.id}
                      <div className="sub">
                        R{r.round} · {when(r.startedAt)}
                        {r.usage ? ` · ${fmtTokens(r.usage.total, lang)} ${ko ? '토큰' : 'tokens'}` : ''}
                      </div>
                    </td>
                    <td>{r.kind === 'work' ? (ko ? '작업' : 'work') : ko ? '검수' : 'review'}</td>
                    <td>
                      {emp?.name}
                      <div>{emp && <CliChip cli={emp.cli} model={emp.model} effort={emp.effort} />}</div>
                      <div className="sub">{emp?.roles.map(role).join(', ')}</div>
                    </td>
                    <td>
                      <span className={`chip ${r.status === 'succeeded' ? 'ok' : r.status === 'running' ? 'info pulse' : 'bad'}`}>
                        {r.status}
                      </span>
                      {r.failureClass && <div className="sub">{r.failureClass}</div>}
                    </td>
                    <td style={{ maxWidth: 420 }}>{r.summary || r.reportError}</td>
                    <td>
                      <button
                        className="btn small"
                        onClick={() =>
                          api<{ text: string; reportError: string | null }>(`runs/${r.id}/log`).then((l) => setLog({ id: r.id, ...l }))
                        }
                      >
                        {ko ? '로그' : 'Log'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {tab === 'diff' && (
          <div className="body">
            {diff?.changedPaths.length ? (
              <div className="row" style={{ marginBottom: 8 }}>
                {diff.changedPaths.map((p) => (
                  <code key={p} className="chip">
                    {p}
                  </code>
                ))}
              </div>
            ) : null}
            {/* 문서·표·그림은 읽기 좋게 먼저(원문 diff는 아래) */}
            <DeliverableView ticketId={tk.id} open version={latestHead ?? undefined} />
            <DiffView text={diff?.diff ?? ''} />
          </div>
        )}
      </div>

      {log && (
        <Modal title={`${log.id} ${ko ? '원본 출력' : 'raw output'}`} onClose={() => setLog(null)}>
          {log.reportError && (
            <div className="banner bad" style={{ whiteSpace: 'pre-wrap' }}>
              {log.reportError}
            </div>
          )}
          <pre className="code">{log.text || '(empty)'}</pre>
        </Modal>
      )}
      {assigning && <AssignModal ticket={tk} onClose={() => setAssigning(false)} />}
    </>
  );
}

function AssignModal({ ticket, onClose }: { ticket: Ticket; onClose: () => void }) {
  const { state, reload } = useCompany();
  const { t, lang, rank: rankName } = useT();
  const { busy, run } = useAction();
  const active = state?.employees.filter((e) => e.active) ?? [];
  const [a, setA] = useState(active[0]?.id ?? '');
  const [r, setR] = useState(active[1]?.id ?? '');
  return (
    <Modal
      title={lang === 'ko' ? '직접 배정' : 'Assign'}
      onClose={onClose}
      actions={
        <button
          className="btn primary"
          disabled={busy || a === r}
          onClick={() =>
            run(
              () => api(`tickets/${ticket.id}/assign`, { body: { assigneeId: a, reviewerId: r } }),
              lang === 'ko' ? '배정했습니다.' : 'Assigned.',
            ).then((ok) => ok && (reload(), onClose()))
          }
        >
          {t('save')}
        </button>
      }
    >
      <div className="form">
        <label>
          {t('assignee')}
          <select value={a} onChange={(e) => setA(e.target.value)}>
            {active.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name} · {rankName(e.rank)}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t('reviewer')}{' '}
          <span className="hint">
            {lang === 'ko'
              ? '담당자와 같거나 높은 직급만 검수할 수 있습니다. 그런 직원이 없을 때만 남은 최고 직급이 검수합니다.'
              : 'Same rank as the assignee or higher; only when none exists may the highest remaining rank review.'}
          </span>
          <select value={r} onChange={(e) => setR(e.target.value)}>
            {active.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name} · {rankName(e.rank)}
              </option>
            ))}
          </select>
        </label>
        {a === r && (
          <div className="banner warn">{lang === 'ko' ? '담당자와 검수자는 달라야 합니다.' : 'Assignee and reviewer must differ.'}</div>
        )}
      </div>
    </Modal>
  );
}

const VERDICT_TONE: Record<string, string> = { agree: 'ok', partial: 'warn', disagree: 'bad', insufficient: 'warn' };

function ClaimLedger({ claims }: { claims: Claim[] }) {
  const { state } = useCompany();
  const { lang } = useT();
  const ko = lang === 'ko';
  const verdictLabel: Record<string, string> = ko
    ? { agree: '동의', partial: '부분 동의', disagree: '반대', insufficient: '근거 부족' }
    : { agree: 'Agree', partial: 'Partial', disagree: 'Disagree', insufficient: 'Insufficient' };
  const responseLabel: Record<string, string> = ko
    ? { keep: '유지', narrow: '범위 축소', revise: '수정', withdraw: '철회', user_decision: '대표 결정 필요' }
    : { keep: 'Keep', narrow: 'Narrow', revise: 'Revise', withdraw: 'Withdraw', user_decision: 'CEO decides' };
  const ordered = [...claims].sort((a, b) => (a.status === 'escalated' ? -1 : 0) - (b.status === 'escalated' ? -1 : 0));
  return (
    <div className="body">
      <div className="sub" style={{ marginBottom: 8 }}>
        {ko
          ? '블라인드 분석 → 작성자를 가린 교차 판정 → 원 작성자 재답변 → 코드 종합. 다수결로 지우지 않으며, 유지된 이견은 대표에게 올라옵니다.'
          : 'Blind analysis → anonymized cross-verdicts → author rebuttal → code synthesis. No majority vote; unresolved disputes go to the CEO.'}
      </div>
      <table>
        <thead>
          <tr>
            <th>{ko ? '주장' : 'Claim'}</th>
            <th>{ko ? '판정' : 'Verdict'}</th>
            <th>{ko ? '재답변' : 'Rebuttal'}</th>
            <th>{ko ? '결과' : 'Outcome'}</th>
          </tr>
        </thead>
        <tbody>
          {ordered.map((c) => (
            <tr key={c.id} style={{ background: c.status === 'escalated' ? 'var(--bad-soft)' : undefined }}>
              <td style={{ maxWidth: 420 }}>
                <div>{c.text}</div>
                <div className="sub">
                  {empName(state?.employees ?? [], c.authorId)} · <span className="chip">{c.impact}</span> {Math.round(c.confidence * 100)}%
                </div>
                {c.sources.length > 0 && <div className="sub mono">{c.sources.map((s) => `${s.doc} ${s.loc}`).join(' · ')}</div>}
              </td>
              <td style={{ maxWidth: 280 }}>
                {c.verdict ? (
                  <span className={`chip ${VERDICT_TONE[c.verdict] ?? ''}`}>{verdictLabel[c.verdict]}</span>
                ) : (
                  <span className="chip info pulse">…</span>
                )}
                <div className="sub">{empName(state?.employees ?? [], c.reviewerId)}</div>
                {c.verdictReason && <div className="sub">{c.verdictReason}</div>}
              </td>
              <td style={{ maxWidth: 280 }}>
                {c.response ? (
                  <span className="chip accent">{responseLabel[c.response]}</span>
                ) : c.verdict && c.verdict !== 'agree' ? (
                  <span className="chip info pulse">…</span>
                ) : (
                  '—'
                )}
                {c.responseText && <div className="sub">{c.responseText}</div>}
              </td>
              <td>
                {c.status === 'escalated' ? (
                  <span className="chip bad">{ko ? '대표에게 상신' : 'Escalated'}</span>
                ) : c.status === 'resolved' ? (
                  <span className="chip ok">{ko ? '해결' : 'Resolved'}</span>
                ) : (
                  <span className="chip">{c.status}</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

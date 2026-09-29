import { useCallback, useEffect, useState } from 'react';
import { api, type Approval, type Claim, type DomainEvent, type Evidence, type RunSummary, type Ticket } from '../api.ts';
import { Link, useCompany } from '../App.tsx';
import { useT } from '../i18n.ts';
import { fmtTokens } from '../components/usage.tsx';
import { CliChip, DiffView, empName, HoldChip, Icon, Modal, StatusChip, useAction, when, Skeleton } from '../components/ui.tsx';
import { ApprovalItem, describeEvent } from './Dashboard.tsx';

interface Detail {
  ticket: Ticket;
  runs: (RunSummary & { report?: unknown; finalText?: string | null })[];
  evidence: Evidence[];
  claims: Claim[];
  approvals: Approval[];
  events: DomainEvent[];
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
            {(state.usage?.byTicket[tk.id]?.total ?? 0) > 0 &&
              ` · ${fmtTokens(state.usage!.byTicket[tk.id]!.total, lang)} ${ko ? '토큰' : 'tokens'}`}
          </div>
        </div>
        <div className="row">
          {tk.hold && (
            <button
              className="btn"
              disabled={busy}
              onClick={() => run(() => api(`tickets/${tk.id}/release`, { body: {} }), 'OK').then(reload)}
            >
              {t('release')}
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
                run(() => api(`tickets/${tk.id}/cancel`, { body: {} }), 'OK').then(reload)
              }
            >
              {t('cancel')}
            </button>
          )}
        </div>
      </div>

      {tk.hold && (
        <div className="banner warn">
          <b className="row" style={{ display: 'inline-flex' }}>
            <Icon name="pause" size={14} /> {holdLabel(tk.hold.reason)}
          </b>
          <div style={{ whiteSpace: 'pre-wrap', marginTop: 4 }}>{tk.hold.note}</div>
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
                        ['in_review', 'awaiting_approval', 'verifying'].includes(tk.status) && (
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
                                void run(() => api(`tickets/${tk.id}/attest`, { body: { requirementId: r.id, note } }), 'OK').then(reload);
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
                      <td className="sub">R{e.round}</td>
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
            {detail.events.map((e) => (
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
            run(() => api(`tickets/${ticket.id}/assign`, { body: { assigneeId: a, reviewerId: r } }), 'OK').then(
              (ok) => ok && (reload(), onClose()),
            )
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

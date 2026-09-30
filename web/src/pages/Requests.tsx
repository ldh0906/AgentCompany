import { useState } from 'react';
import { api, type CeoRequest } from '../api.ts';
import { Link, useCompany } from '../App.tsx';
import { EVIDENCE, useT } from '../i18n.ts';
import { empName, useAction, when } from '../components/ui.tsx';
import { Segmented } from '../components/kit.tsx';
import { fmtTokens } from '../components/usage.tsx';

/** 시스템 검증 명령만 만들 수 있는 증거. 프로젝트에 같은 종류의 명령이 없으면 아무도 채울 수 없다. */
const COMMAND_EVIDENCE = ['unit_test', 'static_check', 'runtime'];

/** 대표 요청 → 비서실장 초안 → 대표 확정. 비서실장은 티켓을 직접 만들 수 없다. */
export function RequestBox() {
  const { state, reload } = useCompany();
  const { lang } = useT();
  const { busy, run } = useAction();
  const [text, setText] = useState('');
  const [projectId, setProjectId] = useState('');
  if (!state || state.projects.length === 0) return null;
  const ko = lang === 'ko';
  const pid = projectId || state.projects[0]!.id;
  const open = state.requests.filter((r) => r.status === 'drafting' || r.status === 'drafted' || r.status === 'failed');
  const projectName = (id: string) => state.projects.find((p) => p.id === id)?.name ?? id;

  return (
    <div className="card">
      <h2>
        {ko ? '대표 요청' : 'Ask the team'}
        {state.chiefOfStaff ? (
          <span className="sub">
            {ko ? '비서실장' : 'Chief of staff'}: {empName(state.employees, state.chiefOfStaff)}
          </span>
        ) : (
          <span className="sub">{ko ? '비서실장 역할 직원이 없습니다' : 'No chief of staff'}</span>
        )}
      </h2>
      <div className="body form">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={
            ko ? '예: 모험가 피로도 규칙을 설계 문서와 코드에 반영해줘' : 'e.g. Add a fatigue rule to the design doc and the simulation'
          }
          disabled={!state.chiefOfStaff}
        />
        <div className="row">
          {state.projects.length > 1 && (
            <select value={pid} onChange={(e) => setProjectId(e.target.value)} style={{ width: 'auto' }}>
              {state.projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          )}
          <span className="sub" style={{ flex: 1 }}>
            {ko
              ? '비서실장이 읽기 전용으로 저장소를 보고 업무 초안을 만듭니다. 확정은 대표가 합니다.'
              : 'The chief of staff reads the repo (read-only) and drafts tickets. You confirm.'}
          </span>
          <button
            className="btn primary"
            disabled={busy || !text.trim() || !state.chiefOfStaff}
            onClick={() =>
              run(() => api('requests', { body: { projectId: pid, text } }), ko ? '비서실장에게 보냈습니다.' : 'Sent.').then(
                (ok) => ok && (setText(''), reload()),
              )
            }
          >
            {ko ? '초안 요청' : 'Draft tickets'}
          </button>
        </div>
      </div>
      <div className="list">
        {open.map((r) => (
          <div className="item request-item" key={r.id}>
            <div className="spread">
              <div className="title">
                <span className="chip accent">{projectName(r.projectId)}</span> {r.text.slice(0, 120)}
              </div>
              <span className={`chip ${r.status === 'drafted' ? 'warn' : r.status === 'failed' ? 'bad' : 'info pulse'}`}>
                {r.status === 'drafting'
                  ? ko
                    ? '초안 작성 중'
                    : 'Drafting'
                  : r.status === 'drafted'
                    ? ko
                      ? '확정 대기'
                      : 'Review drafts'
                    : ko
                      ? '실패'
                      : 'Failed'}
              </span>
            </div>
            <div className="meta">
              {when(r.createdAt)} · {r.summary}
            </div>
            {r.error && <div className="note">{r.error}</div>}
            {r.status === 'failed' && (
              <div className="row" style={{ justifyContent: 'flex-end' }}>
                <button
                  className="btn small"
                  disabled={busy}
                  onClick={() => run(() => api(`requests/${r.id}/dismiss`, { body: {} })).then(reload)}
                >
                  {ko ? '버리기' : 'Dismiss'}
                </button>
                <button
                  className="btn small primary"
                  disabled={busy}
                  onClick={() =>
                    run(() => api(`requests/${r.id}/retry`, { body: {} }), ko ? '다시 요청했습니다.' : 'Retried.').then(reload)
                  }
                >
                  {ko ? '다시 시도' : 'Retry'}
                </button>
              </div>
            )}
            {r.status === 'drafted' && <DraftReview r={r} />}
          </div>
        ))}
        {state.requests
          .filter((r) => r.status === 'accepted')
          .slice(0, 3)
          .map((r) => (
            <div className="item" key={r.id}>
              <div className="meta">
                ✓ <span className="chip">{projectName(r.projectId)}</span> {r.text.slice(0, 80)} →{' '}
                {r.ticketIds.map((id) => (
                  <Link key={id} to={`/tickets/${id}`}>
                    {id}{' '}
                  </Link>
                ))}
              </div>
            </div>
          ))}
      </div>
    </div>
  );
}

type Edit = { title: string; reqs: { text: string; evidenceType: string }[] };

function DraftReview({ r }: { r: CeoRequest }) {
  const { state, reload } = useCompany();
  const { lang, evidence, difficulty } = useT();
  const { busy, run } = useAction();
  const ko = lang === 'ko';
  const [excluded, setExcluded] = useState<number[]>([]);
  // 대표가 고친 제목·요구사항·증거 종류(초안 번호별). 없으면 비서실장 초안 그대로.
  const [edits, setEdits] = useState<Record<number, Edit>>({});
  const [editing, setEditing] = useState<number | null>(null);
  const [diffs, setDiffs] = useState<Record<number, 'easy' | 'normal' | 'hard'>>({});
  const [answerText, setAnswerText] = useState<Record<number, string>>({});
  const project = state?.projects.find((p) => p.id === r.projectId);
  if (!state || !project) return null;

  const editOf = (i: number): Edit => edits[i] ?? { title: r.drafts[i]!.title, reqs: r.drafts[i]!.requirements.map((q) => ({ ...q })) };
  const verifyTypes = new Set<string>(project.verifyCommands.map((v) => v.evidenceType));
  const missingType = (t: string) => COMMAND_EVIDENCE.includes(t) && !verifyTypes.has(t);
  const kept = r.drafts.map((_, i) => i).filter((i) => !excluded.includes(i));
  const mismatches = kept.flatMap((i) =>
    editOf(i)
      .reqs.map((q, j) => ({ i, j, type: q.evidenceType }))
      .filter((x) => missingType(x.type)),
  );
  const have = new Set(project.verifyCommands.map((v) => v.argv.join(' ')));
  const suggestions = (r.verifySuggestions ?? []).filter((s) => !have.has(s.argv.join(' ')));
  const unanswered = r.questions.map((_, i) => i).filter((i) => !r.answers?.[i]);
  const estimateOf = (i: number) => state.estimates?.[diffs[i] ?? r.drafts[i]!.difficulty ?? 'normal']?.tokens ?? 0;
  // 어려움 업무는 팀장만 맡는다: 구현 담당 팀장이 없으면 비서실장·검수 팀장이 떠맡거나 보류된다.
  const leads = state.employees.filter((e) => e.active && e.rank === 'lead');
  const hardImpl = kept.filter((i) => (diffs[i] ?? r.drafts[i]!.difficulty) === 'hard' && ['impl', 'doc'].includes(r.drafts[i]!.type));
  // 어려운 업무를 맡길 구현 팀장이 없으면: 가장 높은 직급의 구현 직원을 한 번에 올릴 수 있게.
  const promotable = state.employees
    .filter((e) => e.active && !e.removedAt && e.roles.includes('implementer') && e.rank !== 'lead')
    .sort((a, b) => (b.rank === 'senior' ? 1 : 0) - (a.rank === 'senior' ? 1 : 0))[0];
  const hardWarning =
    hardImpl.length === 0
      ? null
      : leads.length === 0
        ? ko
          ? `'어려움' 업무 ${hardImpl.length}개를 맡을 팀장이 없어 보류됩니다. 난이도를 낮추거나 팀장을 두세요.`
          : `No lead can take the ${hardImpl.length} hard ticket(s); they will be held. Lower the difficulty or promote someone.`
        : !leads.some((e) => e.roles.includes('implementer'))
          ? ko
            ? `'어려움' 업무 ${hardImpl.length}개는 팀장만 맡는데, 구현 담당 팀장이 없어 ${leads.map((e) => e.name).join(', ')}이(가) 구현까지 맡게 됩니다. 괜찮지 않다면 난이도를 낮추거나 구현 직원을 팀장으로 올리세요.`
            : `Hard tickets go to leads only, and no lead is an implementer, so ${leads.map((e) => e.name).join(', ')} will implement them. Lower the difficulty or promote an implementer.`
          : null;

  const addVerify = (s: { label: string; argv: string[]; evidenceType: string }) =>
    run(
      () =>
        api(`projects/${project.id}`, {
          method: 'PATCH',
          body: { verifyCommands: [...project.verifyCommands.map(({ label, argv, evidenceType }) => ({ label, argv, evidenceType })), s] },
        }),
      ko ? `검증 명령 "${s.label}"을(를) 프로젝트에 추가했습니다.` : `Added verify command "${s.label}".`,
    ).then(reload);
  const answer = (items: { index: number; answer: string | null }[]) =>
    run(() => api(`requests/${r.id}/answer`, { body: { items } }), ko ? '답을 결정으로 기록했습니다.' : 'Recorded as a decision.').then(
      reload,
    );
  const confirm = () => {
    const remap = new Map(kept.map((i, n) => [i, n]));
    const drafts = kept.map((i) => {
      const d = r.drafts[i]!;
      const ed = editOf(i);
      return {
        ...d,
        title: ed.title.trim() || d.title,
        requirements: ed.reqs.map((q, j) => ({ text: q.text.trim() || d.requirements[j]!.text, evidenceType: q.evidenceType })),
        difficulty: diffs[i] ?? d.difficulty ?? 'normal',
        dependsOn: d.dependsOn.filter((x) => remap.has(x)).map((x) => remap.get(x)!),
      };
    });
    void run(() => api(`requests/${r.id}/accept`, { body: { drafts } }), ko ? '업무를 만들었습니다.' : 'Tickets created.').then(reload);
  };

  return (
    <>
      <table style={{ marginTop: 8 }}>
        <tbody>
          {r.drafts.map((d, i) => {
            const off = excluded.includes(i);
            const ed = editOf(i);
            const setEd = (next: Edit) => setEdits({ ...edits, [i]: next });
            return (
              <tr key={i} style={{ opacity: off ? 0.4 : 1 }}>
                <td>
                  <input
                    type="checkbox"
                    checked={!off}
                    onChange={() => setExcluded(off ? excluded.filter((x) => x !== i) : [...excluded, i])}
                    style={{ width: 'auto' }}
                  />
                </td>
                <td>
                  {editing === i ? (
                    <div className="form" style={{ gap: 6 }}>
                      <input value={ed.title} onChange={(e) => setEd({ ...ed, title: e.target.value })} />
                      {ed.reqs.map((q, j) => (
                        <div className="req-row" key={j}>
                          <span className="req-id">R{j + 1}</span>
                          <input
                            value={q.text}
                            onChange={(e) => setEd({ ...ed, reqs: ed.reqs.map((x, k) => (k === j ? { ...x, text: e.target.value } : x)) })}
                          />
                          <select
                            value={q.evidenceType}
                            onChange={(e) =>
                              setEd({ ...ed, reqs: ed.reqs.map((x, k) => (k === j ? { ...x, evidenceType: e.target.value } : x)) })
                            }
                          >
                            {Object.keys(EVIDENCE.ko).map((k) => (
                              <option key={k} value={k}>
                                {evidence(k)}
                              </option>
                            ))}
                          </select>
                        </div>
                      ))}
                      <button className="btn small" style={{ justifySelf: 'start' }} onClick={() => setEditing(null)}>
                        {ko ? '완료' : 'Done'}
                      </button>
                    </div>
                  ) : (
                    <>
                      <b>
                        {i + 1}. {ed.title}
                      </b>{' '}
                      <span className="chip">{d.type}</span>
                      {d.dependsOn.length > 0 && <span className="sub"> ← {d.dependsOn.map((x) => x + 1).join(', ')}</span>}{' '}
                      <button className="btn small" onClick={() => setEditing(i)}>
                        {ko ? '수정' : 'Edit'}
                      </button>
                      <div className="sub draft-reqs">
                        {ed.reqs.map((q, j) => (
                          <span key={j}>
                            {q.text}{' '}
                            <span className={`chip ${missingType(q.evidenceType) ? 'bad' : ''}`}>
                              {evidence(q.evidenceType)}
                              {missingType(q.evidenceType) && (ko ? ' · 검증 명령 없음' : ' · no verify command')}
                            </span>
                          </span>
                        ))}
                      </div>
                    </>
                  )}
                  <div className="row" style={{ marginTop: 6 }}>
                    <span className="sub">{ko ? '난이도' : 'Difficulty'}</span>
                    <Segmented
                      small
                      value={diffs[i] ?? d.difficulty ?? 'normal'}
                      onChange={(v) => setDiffs({ ...diffs, [i]: v })}
                      options={(['easy', 'normal', 'hard'] as const).map((x) => ({ value: x, label: difficulty(x) }))}
                    />
                    {diffs[i] && diffs[i] !== (d.difficulty ?? 'normal') && (
                      <span className="sub">
                        {ko ? `비서실장 제안: ${difficulty(d.difficulty)}` : `Proposed: ${difficulty(d.difficulty)}`}
                      </span>
                    )}
                    <span
                      className="chip"
                      title={ko ? '같은 난이도 업무의 실제 평균(기록이 적으면 기본 예상치)' : 'Average of past tickets of this difficulty'}
                    >
                      {ko ? '예상' : 'est.'} ~{fmtTokens(estimateOf(i), lang)} {ko ? '토큰' : 'tokens'}
                    </span>
                  </div>
                  <div className="row" style={{ marginTop: 4 }}>
                    {d.writeScope.map((g) => (
                      <code key={g} className="chip">
                        {g}
                      </code>
                    ))}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {hardWarning && (
        <div className="banner warn" style={{ marginTop: 8 }}>
          {hardWarning}
          {promotable && (
            <button
              className="btn small primary"
              style={{ marginLeft: 8 }}
              disabled={busy}
              onClick={() =>
                run(
                  () => api(`employees/${promotable.id}/rank`, { body: { rank: 'lead' } }),
                  ko ? `${promotable.name}을(를) 팀장으로 올렸습니다.` : `Promoted ${promotable.name}.`,
                ).then(reload)
              }
            >
              {ko ? `${promotable.name}을(를) 팀장으로 올리기` : `Promote ${promotable.name} to lead`}
            </button>
          )}
        </div>
      )}
      {(mismatches.length > 0 || suggestions.length > 0) && (
        <div className={`banner ${mismatches.length ? 'bad' : 'warn'}`} style={{ marginTop: 8 }}>
          {mismatches.length > 0 && (
            <div>
              {ko
                ? `요구사항 ${mismatches.length}개가 이 프로젝트에 없는 검증 명령의 증거(${[...new Set(mismatches.map((m) => evidence(m.type)))].join(', ')})를 요구합니다. 그대로 두면 아무도 증거를 만들 수 없어 수정 요청이 반복됩니다. 검증 명령을 추가하거나, 요구사항의 증거 종류를 바꾸세요.`
                : `${mismatches.length} requirement(s) need evidence from a verify command this project doesn't have (${[...new Set(mismatches.map((m) => m.type))].join(', ')}). Nobody can produce it, so reviews will keep failing. Add a verify command or change the evidence type.`}
            </div>
          )}
          {suggestions.map((s) => (
            <div key={s.argv.join(' ')} className="row" style={{ marginTop: 6 }}>
              <span>
                {ko ? '비서실장 제안 검증 명령' : 'Suggested verify command'}: <code>{s.argv.join(' ')}</code> ({evidence(s.evidenceType)})
              </span>
              <button className="btn small" disabled={busy} onClick={() => void addVerify(s)}>
                {ko ? '프로젝트에 추가' : 'Add to project'}
              </button>
            </div>
          ))}
        </div>
      )}

      {r.questions.length > 0 && (
        <div className="questions">
          <div className="spread">
            <b>{ko ? `비서실장 질문 ${r.questions.length}개` : `${r.questions.length} questions`}</b>
            {unanswered.some((i) => r.proposals?.[i]) && (
              <button
                className="btn small"
                disabled={busy}
                onClick={() => void answer(unanswered.filter((i) => r.proposals?.[i]).map((index) => ({ index, answer: null })))}
              >
                {ko ? '남은 질문 모두 제안대로' : 'Accept all proposals'}
              </button>
            )}
          </div>
          {r.questions.map((q, i) => (
            <div key={i} className="question">
              <div>❓ {q}</div>
              {r.answers?.[i] ? (
                <div className="sub">✓ {r.answers[i]}</div>
              ) : (
                <div className="row">
                  <input
                    value={answerText[i] ?? ''}
                    onChange={(e) => setAnswerText({ ...answerText, [i]: e.target.value })}
                    placeholder={r.proposals?.[i] ? `${ko ? '제안' : 'Proposal'}: ${r.proposals[i]}` : ko ? '답을 적으세요' : 'Your answer'}
                  />
                  {answerText[i]?.trim() ? (
                    <button className="btn small" disabled={busy} onClick={() => void answer([{ index: i, answer: answerText[i]! }])}>
                      {ko ? '답하기' : 'Answer'}
                    </button>
                  ) : (
                    r.proposals?.[i] && (
                      <button className="btn small" disabled={busy} onClick={() => void answer([{ index: i, answer: null }])}>
                        {ko ? '제안대로' : 'Accept'}
                      </button>
                    )
                  )}
                </div>
              )}
            </div>
          ))}
          <div className="hint">
            {ko
              ? '답은 이 프로젝트의 현재 결정으로 기록되어 모든 직원에게 전달됩니다.'
              : 'Answers are recorded as current decisions and sent to every employee.'}
          </div>
        </div>
      )}

      <div className="row" style={{ marginTop: 8, justifyContent: 'flex-end' }}>
        {unanswered.length > 0 && (
          <span className="sub">{ko ? `답하지 않은 질문 ${unanswered.length}개` : `${unanswered.length} unanswered`}</span>
        )}
        <span className="sub">
          {ko ? '예상 합계' : 'Estimated total'} ~
          <b>
            {fmtTokens(
              kept.reduce((a, i) => a + estimateOf(i), 0),
              lang,
            )}
          </b>{' '}
          {ko ? '토큰' : 'tokens'}
        </span>
        <button className="btn" disabled={busy} onClick={() => run(() => api(`requests/${r.id}/dismiss`, { body: {} })).then(reload)}>
          {ko ? '버리기' : 'Dismiss'}
        </button>
        <button className={`btn ${mismatches.length ? 'danger' : 'ok'}`} disabled={busy || kept.length === 0} onClick={confirm}>
          {mismatches.length
            ? ko
              ? `경고 무시하고 ${project.name} 업무 ${kept.length}개 만들기`
              : `Create ${kept.length} anyway in ${project.name}`
            : ko
              ? `${project.name} 업무 ${kept.length}개 만들기`
              : `Create ${kept.length} tickets in ${project.name}`}
        </button>
      </div>
    </>
  );
}

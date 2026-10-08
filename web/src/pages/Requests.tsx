import { useState } from 'react';
import { api, type CeoRequest } from '../api.ts';
import { Link, useCompany } from '../App.tsx';
import { EVIDENCE, profileTraits, useT } from '../i18n.ts';
import { empName, useAction, when } from '../components/ui.tsx';
import { Segmented } from '../components/kit.tsx';
import { fmtTokens } from '../components/usage.tsx';
import { PlaytestPanel } from '../components/preview.tsx';

/** 시스템 검증 명령만 만들 수 있는 증거. 프로젝트에 같은 종류의 명령이 없으면 아무도 채울 수 없다. */
const COMMAND_EVIDENCE = ['unit_test', 'static_check', 'runtime'];

/** 대표 요청 → 비서실장 초안 → 대표 확정. 비서실장은 티켓을 직접 만들 수 없다. */
/** 인수 시험 한 번(직원 한 명이 합쳐진 결과를 확인)에 드는 토큰. 실측(2026-10-02, 4790 단어 퀴즈 요청): 32만. */
const ACCEPTANCE_TOKENS = 350_000;

export function RequestBox() {
  const { state, reload } = useCompany();
  const { lang } = useT();
  const { busy, run } = useAction();
  const [text, setText] = useState('');
  const [projectId, setProjectId] = useState('');
  // 작업 흐름(빈 값 = 비서실장이 알아서): 정해진 절차를 틀로 쓴다
  const [formula, setFormula] = useState('');
  // 확정 대기 초안은 하나만 펼친다(기본: 맨 위). 실측(2026-10-03, 4777): 초안 3개가 모두 펼쳐져 대시보드가 글자로 가득 찼다.
  const [shownDraft, setShownDraft] = useState<string | null>(null);
  if (!state || state.projects.length === 0) return null;
  const ko = lang === 'ko';
  // 기본값은 가장 최근에 요청한 프로젝트(실측: 늘 첫 프로젝트가 골라져 있어 매번 바꿔야 했다).
  const recent = [...state.requests]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .find((r) => state.projects.some((p) => p.id === r.projectId));
  // 그보다 나중에 새로 만든 프로젝트가 있으면 그쪽이 먼저(실측: 방금 "눈 휴식"을 만들고 왔는데 지난 요청의 메이플이 골라져 있었다).
  const newest = [...state.projects].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const pid =
    projectId ||
    (newest && (!recent || newest.createdAt > recent.createdAt) ? newest.id : null) ||
    recent?.projectId ||
    state.projects[0]!.id;
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
          <span className="sub">
            {state.employees.some((e) => e.active)
              ? ko
                ? '비서실장(팀장) 역할 직원이 없습니다 — 조직에서 한 명에게 맡기세요'
                : 'No chief of staff — assign one in Team'
              : ko
                ? '먼저 팀을 만드세요'
                : 'Create a team first'}
          </span>
        )}
      </h2>
      <div className="body form">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={
            // 결과물 종류에 맞는 예시(실측: 문서 프로젝트를 골랐는데 "할 일 목록 페이지" 예시가 나왔다)
            (
              {
                document: ko
                  ? '예: 신제품 출시 기획서 써줘. 시장 규모는 실제 자료 찾아서 출처 달고'
                  : 'e.g. Write a launch plan for the new product, with sourced market numbers',
                program: ko
                  ? '예: 거래내역 CSV를 월별로 정리하는 도구 만들어줘 / 주문 받는 API 만들어줘'
                  : 'e.g. A tool that sums a bank CSV by month / an API that takes orders',
              } as Record<string, string>
            )[state.projects.find((p) => p.id === pid)?.profile?.deliverable ?? ''] ??
            (ko
              ? '예: 할 일 목록 페이지를 만들어줘. 추가·완료 표시·삭제가 되게'
              : 'e.g. Make a to-do list page with add, check off and delete')
          }
          disabled={!state.chiefOfStaff}
        />
        <div className="row" style={{ flexWrap: 'wrap' }}>
          {state.projects.length > 1 && (
            <select value={pid} onChange={(e) => setProjectId(e.target.value)} style={{ width: 'auto' }}>
              {state.projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          )}
          {(state.formulas?.length ?? 0) > 0 && (
            <select
              value={formula}
              onChange={(e) => setFormula(e.target.value)}
              style={{ width: 'auto' }}
              aria-label={ko ? '작업 흐름' : 'Workflow'}
              title={state.formulas!.find((f) => f.name === formula)?.steps.join(' → ') ?? ''}
            >
              <option value="">{ko ? '작업 흐름: 알아서' : 'Workflow: free'}</option>
              {state.formulas!.map((f) => (
                <option key={f.name} value={f.name}>
                  {f.title} — {f.description}
                </option>
              ))}
            </select>
          )}
          <span className="sub" style={{ flex: 1, minWidth: 220 }}>
            {ko
              ? '비서실장이 프로젝트 폴더를 읽어 보고(고치지 않음) 할 일을 나눈 초안을 만듭니다. 확정은 대표가 합니다.'
              : 'The chief of staff reads the repo (read-only) and drafts tickets. You confirm.'}
          </span>
          <button
            className="btn primary"
            disabled={busy || !text.trim() || !state.chiefOfStaff}
            onClick={() =>
              run(
                () => api('requests', { body: { projectId: pid, text, ...(formula ? { formula } : {}) } }),
                ko ? '비서실장에게 보냈습니다.' : 'Sent.',
              ).then((ok) => ok && (setText(''), reload()))
            }
          >
            {ko ? '초안 요청' : 'Draft tickets'}
          </button>
        </div>
      </div>
      <div className="list">
        {open.map((r) => {
          // 일시적 오류(자동 재시도 예정)는 "실패"가 아니다: 차분하게 "곧 다시 시도"만 보여 준다(원문은 접어 둔다).
          // 실측(2026-10-01): 로그인 토큰 갱신이 겹친 일시 오류가 빨간 "실패"와 영어 문장으로 보여 대표가 놀랐다.
          const retrying = r.status === 'failed' && /자동으로 다시|retrying automatically/.test(r.error ?? '');
          return (
            <div className="item request-item" key={r.id}>
              <div className="spread">
                <div className="title">
                  <span className="chip accent">{projectName(r.projectId)}</span> {r.text.slice(0, 120)}
                </div>
                <span
                  className={`chip ${r.status === 'drafted' ? 'warn' : retrying ? 'info pulse' : r.status === 'failed' ? 'bad' : 'info pulse'}`}
                >
                  {retrying
                    ? ko
                      ? '잠깐 멈춤 · 곧 다시 시도'
                      : 'Retrying shortly'
                    : r.status === 'drafting'
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
                {when(r.createdAt)} ·{' '}
                {ko ? `초안 ${empName(state.employees, r.employeeId)}` : `drafted by ${empName(state.employees, r.employeeId)}`}
                {r.summary ? ` · ${r.summary}` : ''}
              </div>
              {r.error &&
                (retrying ? (
                  <details className="advanced">
                    <summary>
                      {ko ? 'AI 쪽에서 잠깐 문제가 있어 1분 뒤 저절로 다시 시도합니다.' : 'A brief AI-side hiccup; retrying in a minute.'}
                    </summary>
                    <div className="note">{r.error}</div>
                  </details>
                ) : (
                  <div className="note">{r.error}</div>
                ))}
              {/* 초안 작성 중에도 멈추고 버릴 수 있다(대표 요청 2026-10-03) */}
              {(r.status === 'drafting' || retrying) && (
                <div className="row" style={{ justifyContent: 'flex-end' }}>
                  <button
                    className="btn small danger"
                    disabled={busy}
                    onClick={() =>
                      confirm(ko ? '비서실장의 초안 작성을 멈추고 이 요청을 버릴까요?' : 'Stop drafting and dismiss this request?') &&
                      run(() => api(`requests/${r.id}/dismiss`, { body: {} }), ko ? '멈추고 버렸습니다.' : 'Stopped and dismissed.').then(
                        reload,
                      )
                    }
                  >
                    {ko ? '중단하고 버리기' : 'Stop and dismiss'}
                  </button>
                </div>
              )}
              {r.status === 'failed' && !retrying && (
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
              {r.debateId &&
                (() => {
                  // 비서실장이 표시한 갈림길: 팀 토론 결론이 규칙으로 남은 뒤 확정하는 것이 좋다
                  const d = state.debates?.find((x) => x.id === r.debateId);
                  if (!d) return null;
                  return (
                    <div className={`banner ${d.phase === 'done' ? 'ok' : 'info'}`} style={{ margin: '8px 0' }}>
                      🗣 {ko ? '갈림길 토론' : 'Fork debate'}: {d.topic}{' '}
                      {d.phase === 'done'
                        ? `→ ${d.decision}`
                        : d.phase === 'decide'
                          ? ko
                            ? '— 정리 끝, 결정을 기다립니다'
                            : '— waiting for your decision'
                          : ko
                            ? '— 토론 중 (확정은 결론 뒤가 좋습니다)'
                            : '— in progress'}{' '}
                      <Link to={`/chat/${encodeURIComponent(d.channelId)}`}>{ko ? '토론 방 보기' : 'Open'}</Link>
                    </div>
                  );
                })()}
              {r.status === 'drafted' &&
                ((shownDraft ?? open.find((x) => x.status === 'drafted')?.id) === r.id ? (
                  <DraftReview r={r} />
                ) : (
                  <button className="btn small" onClick={() => setShownDraft(r.id)}>
                    {ko ? `초안 펼쳐 보기 (업무 ${r.drafts.length}개)` : `Show draft (${r.drafts.length} tickets)`}
                  </button>
                ))}
            </div>
          );
        })}
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
              {/* 요청별 비용: 지금까지 든 토큰(초안·작업·검수·화면 QA), 업무별로도 */}
              {(state.requestTokens?.[r.id]?.total ?? 0) > 0 && (
                <div className="sub">
                  {ko ? '사용 토큰' : 'Tokens used'} {fmtTokens(state.requestTokens![r.id]!.total, lang)}
                  {' ('}
                  {Object.entries(state.requestTokens![r.id]!.byTicket)
                    .map(
                      ([id, n]) =>
                        `${({ acceptance: ko ? '인수 시험' : 'acceptance', debate: ko ? '토론' : 'debate' } as Record<string, string>)[id] ?? id} ${fmtTokens(n, lang)}`,
                    )
                    .join(' · ')}
                  {')'}
                </div>
              )}
              {/* V모델 인수 시험: 회차별 결과와 고칠 업무(대표 요청 2026-10-02) */}
              {(r.acceptanceRounds?.length ?? 0) > 0 && (
                <div className="acceptance">
                  {r.acceptanceRounds!.map((a) => {
                    const pass = a.results.filter((x) => x.mark === '✅').length;
                    return (
                      <details key={a.round}>
                        <summary>
                          ✔ {ko ? `인수 시험 ${a.round}회차` : `Acceptance round ${a.round}`}:{' '}
                          {a.state === 'running'
                            ? ko
                              ? '확인 중…'
                              : 'checking…'
                            : a.state === 'failed'
                              ? ko
                                ? '시험 담당이 답하지 못했습니다'
                                : 'no answer'
                              : `${pass}/${a.results.length} ${ko ? '통과' : 'passed'}`}
                          {a.fixTickets.length > 0 && (
                            <>
                              {' · '}
                              {ko ? '고칠 업무' : 'Fixes'}{' '}
                              {a.fixTickets.map((id) => (
                                <Link key={id} to={`/tickets/${id}`} className="chip">
                                  {id}
                                </Link>
                              ))}
                            </>
                          )}
                        </summary>
                        {a.results.map((x) => (
                          <div key={x.id} className={`verdict ${x.mark === '✅' ? 'ok' : x.mark === '⚠' ? 'bad' : 'unk'}`}>
                            <b>
                              {x.id} {x.mark}
                            </b>{' '}
                            {r.acceptance?.find((t) => t.id === x.id)?.check} — <span className="sub">{x.why}</span>
                          </div>
                        ))}
                      </details>
                    );
                  })}
                </div>
              )}
              {/* 고급 QA(직접 해 보기): 화면 프로젝트이고, 업무가 모두 끝났고, 반영된 업무가 실행할 수 있는 것을 바꿨을 때만.
                  게임이면 "직접 플레이", 아니면 "직접 써 보기". 프로그램·문서는 인수 시험이 마지막 확인이다.
                  실측(2026-10-03, 4777): 문서·스크립트 요청과 업무가 모두 취소된 요청에도 "직접 플레이해 보기"가 떴다. */}
              {(() => {
                const proj = state.projects.find((p) => p.id === r.projectId);
                const finished =
                  r.ticketIds.length > 0 &&
                  r.ticketIds.every((id) => ['done', 'failed', 'cancelled'].includes(state.tickets.find((t) => t.id === id)?.status ?? ''));
                const screen = (proj?.profile?.deliverable ?? 'screen') === 'screen';
                return state.playtests?.[`Q:${r.id}`] || (screen && finished && state.requestPlayable?.[r.id]) ? (
                  <PlaytestPanel requestId={r.id} game={Boolean(proj?.profile?.game)} />
                ) : null;
              })()}
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
  const [saveProfile, setSaveProfile] = useState(true);
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
  // 없는 검증 명령을 비서실장 제안이 모두 채우면: 확정할 때 함께 추가한다(실측: "경고 무시하고"만 보여 비개발자가 막혔다).
  const needed = suggestions.filter((sg) => mismatches.some((m) => m.type === sg.evidenceType));
  const fixable = mismatches.length > 0 && mismatches.every((m) => needed.some((sg) => sg.evidenceType === m.type));
  // 조사는 웹 페이지를 읽어 같은 난이도의 약 3배가 든다(실측 2026-10-02: 보통 조사 한 번 629만, src/app/cost.ts).
  const estimateOf = (i: number) =>
    (state.estimates?.[diffs[i] ?? r.drafts[i]!.difficulty ?? 'normal']?.tokens ?? 0) * (r.drafts[i]!.type === 'research' ? 3 : 1);
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
    run(() => api(`requests/${r.id}/answer`, { body: { items } }), ko ? '답을 규칙으로 남겼습니다.' : 'Recorded as a decision.').then(
      reload,
    );
  // withVerify=false: 제안된 검사 명령을 켜지 않고, 그 검사가 있어야 하는 요구사항은 검수자 판단(inspection)으로 바꿔 만든다.
  // 대표 요청(2026-10-03): "자동 검사도 함께 켜고 만들기" 하나뿐이라 선택지가 없었다.
  const confirm = (withVerify = true) => {
    const remap = new Map(kept.map((i, n) => [i, n]));
    const drafts = kept.map((i) => {
      const d = r.drafts[i]!;
      const ed = editOf(i);
      return {
        ...d,
        title: ed.title.trim() || d.title,
        requirements: ed.reqs.map((q, j) => ({
          text: q.text.trim() || d.requirements[j]!.text,
          evidenceType: !withVerify && missingType(q.evidenceType) ? 'inspection' : q.evidenceType,
        })),
        difficulty: diffs[i] ?? d.difficulty ?? 'normal',
        dependsOn: d.dependsOn.filter((x) => remap.has(x)).map((x) => remap.get(x)!),
      };
    });
    // 칸에 적어 두고 "답하기"를 안 누른 답도 함께 보낸다. 빈 질문은 서버가 제안대로 처리한다.
    const typed = unanswered.filter((i) => answerText[i]?.trim()).map((index) => ({ index, answer: answerText[index]!.trim() }));
    void run(
      async () => {
        // 비서실장이 제안한 프로젝트 프로필: 대표가 확정하면 저장해 모든 직원이 기억하게 한다.
        if (r.profile && !project.profile && saveProfile)
          await api(`projects/${project.id}`, { method: 'PATCH', body: { profile: r.profile } });
        if (fixable && withVerify)
          await api(`projects/${project.id}`, {
            method: 'PATCH',
            body: {
              verifyCommands: [
                ...project.verifyCommands.map(({ label, argv, evidenceType }) => ({ label, argv, evidenceType })),
                ...needed,
              ],
            },
          });
        if (typed.length) await api(`requests/${r.id}/answer`, { body: { items: typed } });
        return api(`requests/${r.id}/accept`, { body: { drafts } });
      },
      ko ? '업무를 만들었습니다.' : 'Tickets created.',
    ).then(reload);
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
                      <span className="chip">{d.type}</span> {d.step && <span className="chip info">{d.step}</span>}{' '}
                      {d.contract && i === 0 && (
                        <span
                          className="chip warn"
                          title={
                            ko
                              ? '여러 업무가 함께 쓸 이름·값을 먼저 정합니다. 끝나면 이 파일들은 고정되고, 바꾸려면 대표 허락이 필요합니다.'
                              : 'Fixes the names and values the other tickets share. Its files are frozen afterwards; changing them needs you.'
                          }
                        >
                          {ko ? '공유 계약' : 'Shared contract'}
                        </span>
                      )}
                      {d.dependsOn.length > 0 && <span className="sub"> ← {d.dependsOn.map((x) => x + 1).join(', ')}</span>}{' '}
                      <button className="btn small" onClick={() => setEditing(i)}>
                        {ko ? '수정' : 'Edit'}
                      </button>
                      {/* 대표가 읽을 것만 먼저: 무엇을 하는지 한 줄 + 내가 확인할 것. 기술 명세는 접는다.
                          실측(2026-10-01, 눈 휴식): 초안 59줄이 직원용 명세라 요약 두 줄과 질문만 읽혔다. */}
                      {d.purpose && <div style={{ marginTop: 4 }}>{d.purpose}</div>}
                      {ed.reqs.some((q) => q.evidenceType === 'human_attest') && (
                        <div className="sub" style={{ marginTop: 4 }}>
                          👀 {ko ? '내가 확인할 것' : 'You will check'}:{' '}
                          {ed.reqs
                            .filter((q) => q.evidenceType === 'human_attest')
                            .map((q) => q.text)
                            .join(' / ')}
                        </div>
                      )}
                    </>
                  )}
                  <details className="advanced" open={editing === i}>
                    <summary>{ko ? `자세히 (직원용 세부 ${ed.reqs.length}개 · 난이도 · 예상 토큰)` : 'Details for the team'}</summary>
                    {editing !== i && (
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
                        title={
                          ko ? '같은 난이도 업무의 실제 평균(기록이 적으면 기본 예상치)' : 'Average of past tickets of this difficulty'
                        }
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
                  </details>
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
        <div className={`banner ${mismatches.length && !fixable ? 'bad' : 'warn'}`} style={{ marginTop: 8 }}>
          {fixable ? (
            <div>
              {ko
                ? `이 프로젝트에는 아직 자동 검사가 없어, 비서실장이 제안한 검사(${needed.map((sg) => sg.argv.join(' ')).join(', ')})를 업무와 함께 켭니다. 직원 결과를 기계가 먼저 확인하는 장치입니다.`
                : `${mismatches.length} requirement(s) need a verify command the project lacks. The suggested command is added when you create the tickets.`}
            </div>
          ) : (
            mismatches.length > 0 && (
              <div>
                {ko
                  ? `요구사항 ${mismatches.length}개가 이 프로젝트에 없는 검증 명령의 증거(${[...new Set(mismatches.map((m) => evidence(m.type)))].join(', ')})를 요구합니다. 그대로 두면 아무도 증거를 만들 수 없어 수정 요청이 반복됩니다. 검증 명령을 추가하거나, 요구사항의 증거 종류를 바꾸세요.`
                  : `${mismatches.length} requirement(s) need evidence from a verify command this project doesn't have (${[...new Set(mismatches.map((m) => m.type))].join(', ')}). Nobody can produce it, so reviews will keep failing. Add a verify command or change the evidence type.`}
              </div>
            )
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

      {r.profile && !project.profile && (
        <div className="banner info" style={{ marginTop: 8 }}>
          <b>{ko ? '프로젝트 프로필 제안' : 'Suggested project profile'}</b> {r.profile.summary}
          <div className="sub">
            {profileTraits(r.profile, lang)}
            {ko ? ' — 모든 직원이 이 성격을 기억하고, 앱의 점검 방식도 이에 맞춥니다.' : ''}
          </div>
          <label className="check-row" style={{ marginTop: 4 }}>
            <input type="checkbox" checked={saveProfile} onChange={(e) => setSaveProfile(e.target.checked)} />
            <span>
              {ko ? '업무를 만들 때 이 프로필을 저장(나중에 프로젝트 설정에서 고칠 수 있음)' : 'Save this profile when creating tickets'}
            </span>
          </label>
        </div>
      )}
      {(r.acceptance?.length ?? 0) > 0 && (
        <div className="note" style={{ marginTop: 8 }}>
          <b>✔ {ko ? '다 끝나면 이렇게 확인합니다 (인수 시험)' : 'Acceptance tests (checked at the end)'}</b>{' '}
          <span className="sub">
            {ko
              ? `시험 한 번에 약 ${fmtTokens(ACCEPTANCE_TOKENS, lang)} 토큰 더`
              : `about ${fmtTokens(ACCEPTANCE_TOKENS, lang)} more tokens per round`}
          </span>
          {r.acceptance!.map((a) => (
            <div key={a.id} className="sub">
              {a.id} {a.check}
              {a.how ? ` — ${a.how}` : ''}
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
              {!r.answers?.[i] && r.proposals?.[i] && (
                <div className="sub">
                  {ko ? '제안' : 'Proposal'}: {r.proposals[i]}
                </div>
              )}
              {r.answers?.[i] ? (
                <div className="sub">✓ {r.answers[i]}</div>
              ) : (
                <div className="row">
                  <input
                    value={answerText[i] ?? ''}
                    onChange={(e) => setAnswerText({ ...answerText, [i]: e.target.value })}
                    placeholder={
                      r.proposals?.[i]
                        ? ko
                          ? '제안과 다르게 하려면 적으세요'
                          : 'Type to answer differently'
                        : ko
                          ? '답을 적으세요'
                          : 'Your answer'
                    }
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
              ? '비워 두면 제안대로 진행합니다. 답은 프로젝트의 규칙으로 남아 모든 직원이 따릅니다.'
              : 'Leave blank to go with the proposal. Answers become project rules every employee follows.'}
          </div>
        </div>
      )}

      <div className="row" style={{ marginTop: 8, justifyContent: 'flex-end' }}>
        {unanswered.length > 0 && (
          <span className="sub">
            {unanswered.every((i) => r.proposals?.[i] || answerText[i]?.trim())
              ? ko
                ? `질문 ${unanswered.length}개는 제안대로 진행`
                : `${unanswered.length} question(s) will follow the proposal`
              : ko
                ? `답하지 않은 질문 ${unanswered.length}개 (직원이 판단)`
                : `${unanswered.length} unanswered (employee decides)`}
          </span>
        )}
        <span className="sub">
          {ko ? '예상 합계' : 'Estimated total'} ~
          <b>{fmtTokens(kept.reduce((a, i) => a + estimateOf(i), 0) + (r.acceptance?.length ? ACCEPTANCE_TOKENS : 0), lang)}</b>{' '}
          {ko ? '토큰' : 'tokens'}
        </span>
        <button className="btn" disabled={busy} onClick={() => run(() => api(`requests/${r.id}/dismiss`, { body: {} })).then(reload)}>
          {ko ? '버리기' : 'Dismiss'}
        </button>
        {fixable && !r.formula && (
          <button
            className="btn"
            disabled={busy || kept.length === 0}
            onClick={() => confirm(false)}
            title={
              ko
                ? '자동 검사를 켜지 않습니다. 그 검사가 있어야 하는 요구사항은 검수 직원이 읽고 판단하는 것으로 바꿉니다.'
                : 'Skip the verify command; requirements that needed it are judged by the reviewer instead.'
            }
          >
            {ko ? `검사 없이 ${kept.length}개 만들기` : `Create ${kept.length} without it`}
          </button>
        )}
        <button
          className={`btn ${mismatches.length && !fixable ? 'danger' : 'ok'}`}
          disabled={busy || kept.length === 0}
          onClick={() => confirm()}
        >
          {fixable
            ? ko
              ? `자동 검사도 함께 켜고 ${project.name} 업무 ${kept.length}개 만들기`
              : `Add verify command and create ${kept.length} tickets`
            : mismatches.length
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

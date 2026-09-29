import { useState } from 'react';
import { api } from '../api.ts';
import { Link, useCompany } from '../App.tsx';
import { useT } from '../i18n.ts';
import { empName, useAction, when } from '../components/ui.tsx';
import { Segmented } from '../components/kit.tsx';

/** 대표 요청 → 비서실장 초안 → 대표 확정. 비서실장은 티켓을 직접 만들 수 없다. */
export function RequestBox() {
  const { state, reload } = useCompany();
  const { lang, evidence, difficulty } = useT();
  const { busy, run } = useAction();
  const [text, setText] = useState('');
  const [projectId, setProjectId] = useState('');
  const [excluded, setExcluded] = useState<Record<string, number[]>>({});
  // 대표가 바꾼 난이도(요청 → 초안 번호 → 난이도). 없으면 비서실장 제안값.
  const [edits, setEdits] = useState<Record<string, { title: string; reqs: string[] }>>({});
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [diffs, setDiffs] = useState<Record<string, Record<number, 'easy' | 'normal' | 'hard'>>>({});
  if (!state || state.projects.length === 0) return null;
  const ko = lang === 'ko';
  const pid = projectId || state.projects[0]!.id;
  const open = state.requests.filter((r) => r.status === 'drafting' || r.status === 'drafted' || r.status === 'failed');

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
          <div className="item" key={r.id}>
            <div className="spread">
              <div className="title">{r.text.slice(0, 120)}</div>
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
            {r.status === 'drafted' && (
              <>
                <table style={{ marginTop: 8 }}>
                  <tbody>
                    {r.drafts.map((d, i) => {
                      const off = excluded[r.id]?.includes(i);
                      const key = `${r.id}:${i}`;
                      const ed = edits[key] ?? { title: d.title, reqs: d.requirements.map((q) => q.text) };
                      const setEd = (next: typeof ed) => setEdits({ ...edits, [key]: next });
                      return (
                        <tr key={i} style={{ opacity: off ? 0.4 : 1 }}>
                          <td>
                            <input
                              type="checkbox"
                              checked={!off}
                              onChange={() =>
                                setExcluded({
                                  ...excluded,
                                  [r.id]: off ? (excluded[r.id] ?? []).filter((x) => x !== i) : [...(excluded[r.id] ?? []), i],
                                })
                              }
                              style={{ width: 'auto' }}
                            />
                          </td>
                          <td>
                            {editingKey === key ? (
                              <div className="form" style={{ gap: 6 }}>
                                <input value={ed.title} onChange={(e) => setEd({ ...ed, title: e.target.value })} />
                                {d.requirements.map((q, j) => (
                                  <div className="req-row" key={j}>
                                    <span className="req-id">R{j + 1}</span>
                                    <input
                                      value={ed.reqs[j] ?? ''}
                                      onChange={(e) => setEd({ ...ed, reqs: ed.reqs.map((x, k) => (k === j ? e.target.value : x)) })}
                                    />
                                    <span className="sub">{evidence(q.evidenceType)}</span>
                                  </div>
                                ))}
                                <button className="btn small" style={{ justifySelf: 'start' }} onClick={() => setEditingKey(null)}>
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
                                <button className="btn small" onClick={() => setEditingKey(key)}>
                                  {ko ? '수정' : 'Edit'}
                                </button>
                                <div className="sub">
                                  {d.requirements.map((q, j) => `${ed.reqs[j] ?? q.text} [${evidence(q.evidenceType)}]`).join(' · ')}
                                </div>
                              </>
                            )}
                            <div className="row" style={{ marginTop: 6 }}>
                              <span className="sub">{ko ? '난이도' : 'Difficulty'}</span>
                              <Segmented
                                small
                                value={diffs[r.id]?.[i] ?? d.difficulty ?? 'normal'}
                                onChange={(v) => setDiffs({ ...diffs, [r.id]: { ...diffs[r.id], [i]: v } })}
                                options={(['easy', 'normal', 'hard'] as const).map((x) => ({ value: x, label: difficulty(x) }))}
                              />
                              {diffs[r.id]?.[i] && diffs[r.id]![i] !== (d.difficulty ?? 'normal') && (
                                <span className="sub">
                                  {ko ? `비서실장 제안: ${difficulty(d.difficulty)}` : `Proposed: ${difficulty(d.difficulty)}`}
                                </span>
                              )}
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
                {r.questions.length > 0 && <div className="note">❓ {r.questions.join('\n❓ ')}</div>}
                <div className="row" style={{ marginTop: 8, justifyContent: 'flex-end' }}>
                  <button
                    className="btn"
                    disabled={busy}
                    onClick={() => run(() => api(`requests/${r.id}/dismiss`, { body: {} })).then(reload)}
                  >
                    {ko ? '버리기' : 'Dismiss'}
                  </button>
                  <button
                    className="btn ok"
                    disabled={busy}
                    onClick={() => {
                      const keep = r.drafts.map((d, i) => ({ d, i })).filter(({ i }) => !excluded[r.id]?.includes(i));
                      const remap = new Map(keep.map(({ i }, n) => [i, n]));
                      const drafts = keep.map(({ d, i }) => ({
                        ...d,
                        title: edits[`${r.id}:${i}`]?.title.trim() || d.title,
                        requirements: d.requirements.map((q, j) => ({
                          ...q,
                          text: edits[`${r.id}:${i}`]?.reqs[j]?.trim() || q.text,
                        })),
                        difficulty: diffs[r.id]?.[i] ?? d.difficulty ?? 'normal',
                        dependsOn: d.dependsOn.filter((x) => remap.has(x)).map((x) => remap.get(x)!),
                      }));
                      void run(
                        () => api(`requests/${r.id}/accept`, { body: { drafts } }),
                        ko ? '업무를 만들었습니다.' : 'Tickets created.',
                      ).then(reload);
                    }}
                  >
                    {ko ? '확정해서 업무 만들기' : 'Create tickets'}
                  </button>
                </div>
              </>
            )}
          </div>
        ))}
        {state.requests
          .filter((r) => r.status === 'accepted')
          .slice(0, 3)
          .map((r) => (
            <div className="item" key={r.id}>
              <div className="meta">
                ✓ {r.text.slice(0, 80)} →{' '}
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

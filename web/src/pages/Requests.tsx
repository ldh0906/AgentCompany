import { useState } from 'react';
import { api } from '../api.ts';
import { Link, useCompany } from '../App.tsx';
import { useT } from '../i18n.ts';
import { empName, useAction, when } from '../components/ui.tsx';

/** 대표 요청 → 비서실장 초안 → 대표 확정. 비서실장은 티켓을 직접 만들 수 없다. */
export function RequestBox() {
  const { state, reload } = useCompany();
  const { lang, evidence } = useT();
  const { busy, run } = useAction();
  const [text, setText] = useState('');
  const [projectId, setProjectId] = useState('');
  const [excluded, setExcluded] = useState<Record<string, number[]>>({});
  if (!state || state.projects.length === 0) return null;
  const ko = lang === 'ko';
  const pid = projectId || state.projects[0]!.id;
  const open = state.requests.filter((r) => r.status === 'drafting' || r.status === 'drafted' || r.status === 'failed');

  return (
    <div className="card">
      <h2>
        {ko ? '대표 요청' : 'Ask the team'}
        {state.chiefOfStaff ? <span className="sub">{ko ? '비서실장' : 'Chief of staff'}: {empName(state.employees, state.chiefOfStaff)}</span> : <span className="sub">{ko ? '비서실장 역할 직원이 없습니다' : 'No chief of staff'}</span>}
      </h2>
      <div className="body form">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={ko ? '예: 모험가 피로도 규칙을 설계 문서와 코드에 반영해줘' : 'e.g. Add a fatigue rule to the design doc and the simulation'}
          disabled={!state.chiefOfStaff}
        />
        <div className="row">
          {state.projects.length > 1 && (
            <select value={pid} onChange={(e) => setProjectId(e.target.value)} style={{ width: 'auto' }}>
              {state.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          )}
          <span className="sub" style={{ flex: 1 }}>{ko ? '비서실장이 읽기 전용으로 저장소를 보고 업무 초안을 만듭니다. 확정은 대표가 합니다.' : 'The chief of staff reads the repo (read-only) and drafts tickets. You confirm.'}</span>
          <button className="btn primary" disabled={busy || !text.trim() || !state.chiefOfStaff} onClick={() => run(() => api('requests', { body: { projectId: pid, text } }), ko ? '비서실장에게 보냈습니다.' : 'Sent.').then((ok) => ok && (setText(''), reload()))}>
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
                {r.status === 'drafting' ? (ko ? '초안 작성 중' : 'Drafting') : r.status === 'drafted' ? (ko ? '확정 대기' : 'Review drafts') : ko ? '실패' : 'Failed'}
              </span>
            </div>
            <div className="meta">{when(r.createdAt)} · {r.summary}</div>
            {r.error && <div className="note">{r.error}</div>}
            {r.status === 'drafted' && (
              <>
                <table style={{ marginTop: 8 }}>
                  <tbody>
                    {r.drafts.map((d, i) => {
                      const off = excluded[r.id]?.includes(i);
                      return (
                        <tr key={i} style={{ opacity: off ? 0.4 : 1 }}>
                          <td><input type="checkbox" checked={!off} onChange={() => setExcluded({ ...excluded, [r.id]: off ? (excluded[r.id] ?? []).filter((x) => x !== i) : [...(excluded[r.id] ?? []), i] })} style={{ width: 'auto' }} /></td>
                          <td>
                            <b>{i + 1}. {d.title}</b> <span className="chip">{d.type}</span>
                            {d.dependsOn.length > 0 && <span className="sub"> ← {d.dependsOn.map((x) => x + 1).join(', ')}</span>}
                            <div className="sub">{d.requirements.map((q) => `${q.text} [${evidence(q.evidenceType)}]`).join(' · ')}</div>
                            <div className="row" style={{ marginTop: 4 }}>{d.writeScope.map((g) => <code key={g} className="chip">{g}</code>)}</div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {r.questions.length > 0 && <div className="note">❓ {r.questions.join('\n❓ ')}</div>}
                <div className="row" style={{ marginTop: 8, justifyContent: 'flex-end' }}>
                  <button className="btn" disabled={busy} onClick={() => run(() => api(`requests/${r.id}/dismiss`, { body: {} })).then(reload)}>{ko ? '버리기' : 'Dismiss'}</button>
                  <button className="btn ok" disabled={busy} onClick={() => {
                    const keep = r.drafts.map((d, i) => ({ d, i })).filter(({ i }) => !excluded[r.id]?.includes(i));
                    const remap = new Map(keep.map(({ i }, n) => [i, n]));
                    const drafts = keep.map(({ d }) => ({ ...d, dependsOn: d.dependsOn.filter((x) => remap.has(x)).map((x) => remap.get(x)!) }));
                    void run(() => api(`requests/${r.id}/accept`, { body: { drafts } }), ko ? '업무를 만들었습니다.' : 'Tickets created.').then(reload);
                  }}>{ko ? '확정해서 업무 만들기' : 'Create tickets'}</button>
                </div>
              </>
            )}
          </div>
        ))}
        {state.requests.filter((r) => r.status === 'accepted').slice(0, 3).map((r) => (
          <div className="item" key={r.id}>
            <div className="meta">✓ {r.text.slice(0, 80)} → {r.ticketIds.map((id) => <Link key={id} to={`/tickets/${id}`}>{id} </Link>)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// 토론 모드 화면: 토론 방 위쪽의 진행 상황·선택지·결정, 그리고 토론 열기 창. 대표 요청(2026-10-02).
import { useState } from 'react';
import { api, type Debate } from '../api.ts';
import { useCompany } from '../App.tsx';
import { useT } from '../i18n.ts';
import { ChipToggles } from './kit.tsx';
import { empName, Modal, useAction } from './ui.tsx';

const PHASES = ['opening', 'rebuttal', 'summary', 'decide', 'done'] as const;

export function DebatePanel({ debate: d }: { debate: Debate }) {
  const { state, reload } = useCompany();
  const { lang } = useT();
  const ko = lang === 'ko';
  const { busy, run } = useAction();
  const [own, setOwn] = useState('');
  if (!state) return null;
  const name = (id: string) => empName(state.employees, id);
  const label: Record<string, string> = ko
    ? { opening: '1. 각자 입장', rebuttal: '2. 서로 반박', summary: '3. 사회자 정리', decide: '4. 결정', done: '결정됨' }
    : { opening: '1. Positions', rebuttal: '2. Rebuttals', summary: '3. Summary', decide: '4. Decide', done: 'Decided' };
  const now = PHASES.indexOf(d.phase);
  const answered = d.phase === 'opening' ? Object.keys(d.positions).length : d.phase === 'rebuttal' ? Object.keys(d.rebuttals).length : 0;
  const decide = (body: { option?: number; text?: string }) =>
    run(() => api(`debates/${d.id}/decide`, { body }), ko ? '결정했습니다. 규칙으로 남겼습니다.' : 'Decided and recorded.').then(reload);
  return (
    <div className="debate">
      <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
        {PHASES.slice(0, 4).map((p, i) => (
          <span key={p} className={`chip ${i < now ? 'ok' : i === now ? 'accent' : ''}`}>
            {label[p]}
            {i === now && (p === 'opening' || p === 'rebuttal') ? ` (${answered}/${d.participants.length})` : ''}
          </span>
        ))}
        <span className="sub">
          {ko ? '사회' : 'Moderator'}: {name(d.moderator)}
        </span>
      </div>
      {d.phase === 'decide' && (
        <>
          <div className="debate-options">
            {d.options.map((o, i) => (
              <div key={i} className={`debate-option ${d.recommendation === i ? 'recommended' : ''}`}>
                <div className="spread">
                  <b>{o.title}</b>
                  {d.recommendation === i && <span className="chip accent">{ko ? '사회자 추천' : 'Recommended'}</span>}
                </div>
                {o.supporters.length > 0 && (
                  <div className="sub">
                    {ko ? '지지' : 'Supported by'}: {o.supporters.join(', ')}
                  </div>
                )}
                <ul>
                  {o.pros.map((x, j) => (
                    <li key={`p${j}`}>👍 {x}</li>
                  ))}
                  {o.cons.map((x, j) => (
                    <li key={`c${j}`}>👎 {x}</li>
                  ))}
                </ul>
                <button
                  className={`btn small ${d.recommendation === i ? 'primary' : ''}`}
                  disabled={busy}
                  onClick={() => void decide({ option: i })}
                >
                  {ko ? '이 안으로 결정' : 'Decide this'}
                </button>
              </div>
            ))}
          </div>
          {d.dissent && (
            <div className="hint">
              {ko ? '반대 의견' : 'Dissent'}: {d.dissent}
            </div>
          )}
          <div className="row">
            <input
              value={own}
              onChange={(e) => setOwn(e.target.value)}
              placeholder={ko ? '직접 결론 쓰기 (선택)' : 'Or write your own conclusion'}
            />
            <button className="btn small" disabled={busy || !own.trim()} onClick={() => void decide({ text: own })}>
              {ko ? '이걸로 결정' : 'Decide'}
            </button>
          </div>
        </>
      )}
      {d.phase === 'done' && d.decision && (
        <div className="banner ok" style={{ margin: 0 }}>
          ✅ {d.decision}{' '}
          <span className="sub">
            ({d.decidedBy?.startsWith('delegate:') ? (ko ? `전권 위임: ${name(d.decidedBy.slice(9))}` : 'delegated') : ko ? '대표' : 'CEO'})
          </span>
        </div>
      )}
    </div>
  );
}

export function NewDebateModal({ onClose, onCreated }: { onClose: () => void; onCreated: (channelId: string) => void }) {
  const { state, reload } = useCompany();
  const { lang } = useT();
  const ko = lang === 'ko';
  const { busy, run } = useAction();
  const [topic, setTopic] = useState('');
  const [context, setContext] = useState('');
  const [members, setMembers] = useState<string[]>([]);
  const [projectId, setProjectId] = useState('');
  if (!state) return null;
  return (
    <Modal
      title={ko ? '🗣 토론 열기' : '🗣 Open a debate'}
      onClose={onClose}
      actions={
        <button
          className="btn primary"
          disabled={busy || !topic.trim()}
          onClick={() =>
            run(async () => {
              const d = await api<Debate>('debates', { body: { topic, context, participants: members, projectId: projectId || null } });
              reload();
              onCreated(d.channelId);
            })
          }
        >
          {ko ? '토론 시작' : 'Start'}
        </button>
      }
    >
      <div className="form">
        <label>
          {ko ? '주제 (무엇을 정할지 한 줄로)' : 'Topic (what to decide)'}
          <input
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder={ko ? '예: 저장은 파일로 할까 SQLite로 할까' : 'e.g. Store data in files or SQLite?'}
            autoFocus
          />
        </label>
        <label>
          {ko ? '배경 (선택)' : 'Background (optional)'}
          <textarea value={context} onChange={(e) => setContext(e.target.value)} rows={2} />
        </label>
        <label>
          {ko ? '프로젝트 (직원이 읽을 폴더, 선택)' : 'Project (optional)'}
          <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            <option value="">{ko ? '없음' : 'None'}</option>
            {state.projects
              .filter((p) => !p.removedAt)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
          </select>
        </label>
        <label>
          {ko ? '참가자 (비우면 서로 다른 AI에서 최대 4명)' : 'Debaters (empty: up to 4 across AIs)'}
          <ChipToggles
            options={state.employees.filter((e) => e.active && !e.removedAt).map((e) => ({ value: e.id, label: e.name }))}
            selected={members}
            onToggle={(v) => setMembers(members.includes(v) ? members.filter((x) => x !== v) : [...members, v])}
          />
        </label>
        <div className="hint">
          {ko
            ? '각자 입장 → 서로 반박 → 사회자(최고 직급)가 선택지·장단점·추천을 정리합니다. 결정은 대표가 한 번에, 전권 위임 중이면 추천안으로 바로 정해집니다. 참가자 수만큼 실행이 세 번 돌아 토큰이 듭니다.'
            : 'Positions → rebuttals → the moderator summarizes options and a recommendation. You decide in one click.'}
        </div>
      </div>
    </Modal>
  );
}

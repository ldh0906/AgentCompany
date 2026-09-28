import { useState } from 'react';
import { api } from '../api.ts';
import { useCompany } from '../App.tsx';
import { useT } from '../i18n.ts';
import { useAction, when, Skeleton } from '../components/ui.tsx';

const STATUS_KO: Record<string, string> = {
  current: '현재 유효',
  past: '과거 결정',
  superseded: '대체됨',
  withdrawn: '철회됨',
  needs_verification: '검증 필요',
  draft: '임시 초안',
};
const STATUS_EN: Record<string, string> = {
  current: 'Current',
  past: 'Past',
  superseded: 'Superseded',
  withdrawn: 'Withdrawn',
  needs_verification: 'Needs verification',
  draft: 'Draft',
};

export function Decisions() {
  const { state, reload } = useCompany();
  const { t, lang } = useT();
  const { busy, run } = useAction();
  const [filter, setFilter] = useState('current');
  const [text, setText] = useState('');
  const [projectId, setProjectId] = useState('');
  if (!state) return <Skeleton />;
  const ko = lang === 'ko';
  const label = ko ? STATUS_KO : STATUS_EN;
  const list = state.decisions.filter((d) => filter === 'all' || d.status === filter);
  const pid = projectId || state.projects[0]?.id || '';

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{t('nav_decisions')}</h1>
          <div className="sub">
            {ko
              ? '대표가 확정한 결정만 "현재 유효"가 되며, 직원에게는 현재 유효한 결정만 구속력 있게 전달됩니다. 과거 결정은 삭제하지 않고 상태만 바꿉니다.'
              : 'Only CEO decisions become current; only current decisions bind employees. Nothing is deleted.'}
          </div>
        </div>
      </div>
      {state.projects.length > 0 && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="body form">
            <div className="row">
              <select value={pid} onChange={(e) => setProjectId(e.target.value)} style={{ width: 'auto' }}>
                {state.projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <input
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={ko ? '새 결정 (예: 파티 최대 인원은 4명)' : 'New decision'}
                style={{ flex: 1 }}
              />
              <button
                className="btn primary"
                disabled={busy || !text.trim()}
                onClick={() =>
                  run(() => api('decisions', { body: { projectId: pid, text } }), 'OK').then((ok) => ok && (setText(''), reload()))
                }
              >
                {ko ? '확정' : 'Record'}
              </button>
            </div>
          </div>
        </div>
      )}
      <div className="row" style={{ marginBottom: 10 }}>
        {['current', 'needs_verification', 'draft', 'superseded', 'past', 'withdrawn', 'all'].map((s) => (
          <button key={s} className={`btn small ${filter === s ? 'primary' : ''}`} onClick={() => setFilter(s)}>
            {s === 'all' ? (ko ? '전체' : 'All') : label[s]}
          </button>
        ))}
      </div>
      <div className="card">
        <div className="list">
          {list.length === 0 ? (
            <div className="emptystate">{t('empty')}</div>
          ) : (
            list.map((d) => (
              <div className="item" key={d.id}>
                <div className="spread">
                  <div>
                    <div className="title">{d.text}</div>
                    <div className="meta">
                      <span className="mono">{d.id}</span> · {state.projects.find((p) => p.id === d.projectId)?.name} · {when(d.createdAt)}{' '}
                      {d.supersedes && `· ${ko ? '대체' : 'supersedes'} ${d.supersedes}`}
                    </div>
                  </div>
                  <select
                    value={d.status}
                    onChange={(e) => run(() => api(`decisions/${d.id}/status`, { body: { status: e.target.value } }), 'OK').then(reload)}
                    style={{ width: 'auto' }}
                  >
                    {Object.keys(label).map((s) => (
                      <option key={s} value={s}>
                        {label[s]}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </>
  );
}

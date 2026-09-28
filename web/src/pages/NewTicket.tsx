import { useState } from 'react';
import { api, type Ticket } from '../api.ts';
import { useCompany, useRoute } from '../App.tsx';
import { EVIDENCE, useT } from '../i18n.ts';
import { Modal, useAction } from '../components/ui.tsx';

export function NewTicket({ onClose }: { onClose: () => void }) {
  const { state, reload } = useCompany();
  const { go } = useRoute();
  const { t, lang, evidence } = useT();
  const { busy, run } = useAction();
  const ko = lang === 'ko';
  const [projectId, setProjectId] = useState(state?.projects[0]?.id ?? '');
  const [type, setType] = useState<Ticket['type']>('impl');
  const [title, setTitle] = useState('');
  const [purpose, setPurpose] = useState('');
  const [reqs, setReqs] = useState([{ text: '', evidenceType: 'unit_test' }]);
  const [doneCriteria, setDone] = useState('');
  const [scope, setScope] = useState('src/**');

  const submit = () =>
    run(
      async () => {
        const tk = await api<Ticket>('tickets', {
          body: {
            projectId,
            type,
            title,
            purpose,
            requirements: reqs.filter((r) => r.text.trim()),
            doneCriteria,
            writeScope: scope
              .split('\n')
              .map((s) => s.trim())
              .filter(Boolean),
          },
        });
        reload();
        onClose();
        go(`/tickets/${tk.id}`);
      },
      ko ? '업무를 만들었습니다.' : 'Ticket created.',
    );

  return (
    <Modal
      title={t('newTicket')}
      onClose={onClose}
      actions={
        <button
          className="btn primary"
          disabled={busy || !title.trim() || !doneCriteria.trim() || !reqs.some((r) => r.text.trim())}
          onClick={submit}
        >
          {t('create')}
        </button>
      }
    >
      <div className="form">
        <div className="row">
          <label style={{ flex: 1 }}>
            {t('nav_projects')}
            <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              {state?.projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label style={{ width: 180 }}>
            {ko ? '종류' : 'Type'}
            <select
              value={type}
              onChange={(e) => {
                const v = e.target.value as Ticket['type'];
                setType(v);
                if (v === 'doc') {
                  setScope('docs/**');
                  setReqs((r) => r.map((x) => ({ ...x, evidenceType: 'inspection' })));
                }
                if (v === 'review' || v === 'research') {
                  setScope('');
                  setReqs((r) => r.map((x) => ({ ...x, evidenceType: 'inspection' })));
                }
                if (v === 'impl') setScope('src/**');
              }}
            >
              <option value="impl">{ko ? '구현' : 'Implementation'}</option>
              <option value="doc">{ko ? '문서' : 'Document'}</option>
              <option value="review">{ko ? '교차 검토 (블라인드)' : 'Blind cross-review'}</option>
              <option value="research">{ko ? '조사' : 'Research'}</option>
            </select>
          </label>
        </div>
        <label>
          {ko ? '제목' : 'Title'}
          <input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
        </label>
        <label>
          {ko ? '목적' : 'Purpose'}
          <textarea value={purpose} onChange={(e) => setPurpose(e.target.value)} />
        </label>
        <label>
          {t('requirements')}{' '}
          <span className="hint">
            {ko
              ? '요구사항마다 필요한 최소 증거를 고르세요. 시안은 구현 증거가 아니고, 정적 검사는 런타임 증거가 아닙니다.'
              : 'Pick the minimum evidence per requirement.'}
          </span>
          {reqs.map((r, i) => (
            <div className="row" key={i}>
              <input
                value={r.text}
                onChange={(e) => setReqs(reqs.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))}
                placeholder={`R${i + 1}`}
                style={{ flex: 1 }}
              />
              <select
                value={r.evidenceType}
                onChange={(e) => setReqs(reqs.map((x, j) => (j === i ? { ...x, evidenceType: e.target.value } : x)))}
                style={{ width: 170 }}
              >
                {Object.keys(EVIDENCE.ko).map((k) => (
                  <option key={k} value={k}>
                    {evidence(k)}
                  </option>
                ))}
              </select>
            </div>
          ))}
          <button
            className="btn small"
            type="button"
            onClick={() => setReqs([...reqs, { text: '', evidenceType: reqs.at(-1)?.evidenceType ?? 'unit_test' }])}
            style={{ justifySelf: 'start' }}
          >
            + {ko ? '요구사항' : 'Requirement'}
          </button>
        </label>
        <label>
          {ko ? '완료 조건' : 'Done criteria'}
          <input value={doneCriteria} onChange={(e) => setDone(e.target.value)} />
        </label>
        <label>
          {ko ? '쓰기 허용 범위 (glob, 한 줄에 하나)' : 'Write scope (glob, one per line)'}{' '}
          <span className="hint">{ko ? '이 밖을 수정하면 제출물이 격리됩니다.' : 'Changes outside are quarantined.'}</span>
          <textarea className="mono" value={scope} onChange={(e) => setScope(e.target.value)} />
        </label>
      </div>
    </Modal>
  );
}

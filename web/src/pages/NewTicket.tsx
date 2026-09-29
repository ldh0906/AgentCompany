import { useEffect, useState } from 'react';
import { api, type Ticket } from '../api.ts';
import { useCompany, useRoute } from '../App.tsx';
import { EVIDENCE, useT } from '../i18n.ts';
import { Icon, Modal, useAction } from '../components/ui.tsx';
import { ChipToggles, Segmented } from '../components/kit.tsx';

type Req = { text: string; evidenceType: string };
type Difficulty = 'easy' | 'normal' | 'hard';

interface Template {
  key: string;
  ko: string;
  en: string;
  type: Ticket['type'];
  difficulty: Difficulty;
  reqs: { ko: string; en: string; evidenceType: string }[];
  done: { ko: string; en: string };
  scope: 'code' | 'docs' | 'none';
  purpose: { ko: string; en: string };
}

const TEMPLATES: Template[] = [
  {
    key: 'feature',
    ko: '기능 추가',
    en: 'New feature',
    type: 'impl',
    difficulty: 'normal',
    reqs: [
      { ko: '', en: '', evidenceType: 'unit_test' },
      { ko: '새 동작을 확인하는 단위 테스트 추가', en: 'Unit tests covering the new behavior', evidenceType: 'unit_test' },
    ],
    done: { ko: '검증 명령이 통과하고 검수자가 승인', en: 'Verify commands pass and the reviewer approves' },
    scope: 'code',
    purpose: { ko: '무엇을, 왜 만드는지 적어 주세요.', en: 'What to build and why.' },
  },
  {
    key: 'bug',
    ko: '버그 수정',
    en: 'Bug fix',
    type: 'impl',
    difficulty: 'normal',
    reqs: [
      { ko: '', en: '', evidenceType: 'unit_test' },
      {
        ko: '버그를 재현하는 회귀 테스트 추가(수정 전 실패, 수정 후 통과)',
        en: 'A regression test that fails before the fix and passes after',
        evidenceType: 'unit_test',
      },
    ],
    done: { ko: '회귀 테스트와 기존 테스트가 모두 통과', en: 'The regression test and existing tests pass' },
    scope: 'code',
    purpose: { ko: '증상, 재현 방법, 기대 동작을 적어 주세요.', en: 'Symptom, how to reproduce, expected behavior.' },
  },
  {
    key: 'small',
    ko: '간단한 수정',
    en: 'Small change',
    type: 'impl',
    difficulty: 'easy',
    reqs: [{ ko: '', en: '', evidenceType: 'static_check' }],
    done: { ko: '검증 명령이 통과', en: 'Verify commands pass' },
    scope: 'code',
    purpose: { ko: '바꿀 내용을 한두 줄로 적어 주세요.', en: 'Describe the change in a line or two.' },
  },
  {
    key: 'docs',
    ko: '문서 정리',
    en: 'Docs',
    type: 'doc',
    difficulty: 'easy',
    reqs: [{ ko: '', en: '', evidenceType: 'inspection' }],
    done: { ko: '검수자가 문서를 확인', en: 'The reviewer checks the document' },
    scope: 'docs',
    purpose: { ko: '어떤 문서를 어떻게 정리할지 적어 주세요.', en: 'Which document and how to tidy it.' },
  },
  {
    key: 'review',
    ko: '코드·설계 검토',
    en: 'Code / design review',
    type: 'review',
    difficulty: 'normal',
    reqs: [
      {
        ko: '구현자가 임의로 정해야 하는 빈칸과 충돌 목록',
        en: 'Gaps and conflicts an implementer would have to guess',
        evidenceType: 'inspection',
      },
    ],
    done: { ko: '미해결 이견은 대표에게 상신', en: 'Unresolved disputes go to the CEO' },
    scope: 'none',
    purpose: { ko: '무엇을 검토할지(문서·폴더·기능) 적어 주세요.', en: 'What to review (docs, folders, features).' },
  },
  {
    key: 'research',
    ko: '조사',
    en: 'Research',
    type: 'research',
    difficulty: 'normal',
    reqs: [{ ko: '', en: '', evidenceType: 'inspection' }],
    done: { ko: '근거와 함께 결론을 보고', en: 'Report a conclusion with sources' },
    scope: 'none',
    purpose: { ko: '알고 싶은 질문을 적어 주세요.', en: 'The question to answer.' },
  },
];

export function NewTicket({ onClose }: { onClose: () => void }) {
  const { state, reload } = useCompany();
  const { go } = useRoute();
  const { t, lang, evidence, difficulty: diffLabel } = useT();
  const { busy, run } = useAction();
  const ko = lang === 'ko';
  const [tpl, setTpl] = useState('feature');
  const [projectId, setProjectId] = useState(state?.projects[0]?.id ?? '');
  const [type, setType] = useState<Ticket['type']>('impl');
  const [difficulty, setDifficulty] = useState<Difficulty>('normal');
  const [title, setTitle] = useState('');
  const [purpose, setPurpose] = useState('');
  const [reqs, setReqs] = useState<Req[]>([]);
  const [doneCriteria, setDone] = useState('');
  const [scope, setScope] = useState<string[]>([]);
  const [customScope, setCustomScope] = useState('');
  const [dirs, setDirs] = useState<string[] | null>(null);

  const template = TEMPLATES.find((x) => x.key === tpl)!;
  const applyTemplate = (key: string) => {
    const x = TEMPLATES.find((y) => y.key === key)!;
    setTpl(key);
    setType(x.type);
    setDifficulty(x.difficulty);
    setReqs(x.reqs.map((r) => ({ text: ko ? r.ko : r.en, evidenceType: r.evidenceType })));
    setDone(ko ? x.done.ko : x.done.en);
    setScope(x.scope === 'docs' ? ['docs/**'] : x.scope === 'none' ? [] : dirs?.includes('src') ? ['src/**'] : []);
  };
  useEffect(() => applyTemplate('feature'), []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!projectId) return;
    setDirs(null);
    api<string[]>(`projects/${projectId}/dirs`)
      .then((d) => {
        setDirs(d);
        if (template.scope === 'code' && scope.length === 0 && d.includes('src')) setScope(['src/**']);
      })
      .catch(() => setDirs([]));
  }, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  const needsScope = type === 'impl' || type === 'doc';
  const writeScope = [
    ...scope,
    ...customScope
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean),
  ];
  const submit = () =>
    run(
      async () => {
        const tk = await api<Ticket>('tickets', {
          body: {
            projectId,
            type,
            difficulty,
            title,
            purpose,
            requirements: reqs.filter((r) => r.text.trim()),
            doneCriteria,
            writeScope: needsScope ? writeScope : [],
          },
        });
        reload();
        onClose();
        go(`/tickets/${tk.id}`);
      },
      ko ? '업무를 만들었습니다.' : 'Ticket created.',
    );
  const scopeOptions = [
    { value: '**', label: ko ? '저장소 전체' : 'Whole repository' },
    ...(dirs ?? []).map((d) => ({ value: `${d}/**`, label: `${d}/` })),
  ];
  const needRank = difficulty === 'hard' ? 'lead' : difficulty === 'normal' ? 'senior' : 'junior';
  const order = { junior: 1, senior: 2, lead: 3 } as const;
  const capable = (state?.employees ?? []).filter((e) => e.active && order[e.rank ?? 'senior'] >= order[needRank]).length;

  return (
    <Modal
      title={t('newTicket')}
      onClose={onClose}
      actions={
        <button
          className="btn primary"
          disabled={
            busy || !title.trim() || !doneCriteria.trim() || !reqs.some((r) => r.text.trim()) || (needsScope && writeScope.length === 0)
          }
          onClick={submit}
        >
          <Icon name="plus" /> {t('create')}
        </button>
      }
    >
      <div className="form">
        <div className="field-label">{ko ? '어떤 일인가요?' : 'What kind of work?'}</div>
        <div className="template-row">
          {TEMPLATES.map((x) => (
            <button key={x.key} type="button" className={`chip-toggle ${tpl === x.key ? 'on' : ''}`} onClick={() => applyTemplate(x.key)}>
              {ko ? x.ko : x.en}
            </button>
          ))}
        </div>

        <div className="row" style={{ alignItems: 'flex-start' }}>
          {(state?.projects.length ?? 0) > 1 && (
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
          )}
          <label>
            {ko ? '난이도' : 'Difficulty'}
            <Segmented
              value={difficulty}
              onChange={setDifficulty}
              options={(['easy', 'normal', 'hard'] as const).map((d) => ({ value: d, label: diffLabel(d) }))}
            />
            <span className={`hint ${capable === 0 ? 'bad-text' : ''}`}>
              {ko
                ? `${needRank === 'lead' ? '팀장' : needRank === 'senior' ? '선임' : '사원'} 이상이 맡습니다 · 가능한 직원 ${capable}명`
                : `Needs ${needRank} or higher · ${capable} eligible`}
            </span>
          </label>
        </div>

        <label>
          {ko ? '제목' : 'Title'}
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            autoFocus
            placeholder={ko ? '예: 파티 탈퇴 기능' : 'e.g. Leave a party'}
          />
        </label>
        <label>
          {ko ? '설명' : 'Description'}
          <textarea
            value={purpose}
            onChange={(e) => setPurpose(e.target.value)}
            placeholder={ko ? template.purpose.ko : template.purpose.en}
          />
        </label>

        <div className="field-label">
          {t('requirements')}{' '}
          <span className="hint">
            {ko ? '요구사항마다 필요한 최소 증거를 고르세요.' : 'Pick the minimum evidence for each requirement.'}
          </span>
        </div>
        <div className="verify-rows">
          {reqs.map((r, i) => (
            <div className="req-row" key={i}>
              <span className="req-id">R{i + 1}</span>
              <input
                value={r.text}
                onChange={(e) => setReqs(reqs.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))}
                placeholder={ko ? '무엇이 되어야 하나요?' : 'What must be true?'}
              />
              <select
                value={r.evidenceType}
                onChange={(e) => setReqs(reqs.map((x, j) => (j === i ? { ...x, evidenceType: e.target.value } : x)))}
              >
                {Object.keys(EVIDENCE.ko)
                  .filter((k) => (type === 'review' ? k === 'inspection' || k === 'mockup' : true))
                  .map((k) => (
                    <option key={k} value={k}>
                      {evidence(k)}
                    </option>
                  ))}
              </select>
              <button
                type="button"
                className="btn small"
                disabled={reqs.length <= 1}
                onClick={() => setReqs(reqs.filter((_, j) => j !== i))}
                aria-label="remove"
              >
                ✕
              </button>
            </div>
          ))}
          <button
            className="btn small"
            type="button"
            onClick={() => setReqs([...reqs, { text: '', evidenceType: reqs.at(-1)?.evidenceType ?? 'unit_test' }])}
            style={{ justifySelf: 'start' }}
          >
            <Icon name="plus" size={13} /> {ko ? '요구사항' : 'Requirement'}
          </button>
        </div>

        <label>
          {ko ? '완료 조건' : 'Done criteria'}
          <input value={doneCriteria} onChange={(e) => setDone(e.target.value)} />
        </label>

        {needsScope && (
          <label>
            {ko ? '수정해도 되는 곳' : 'Where changes are allowed'}{' '}
            <span className="hint">{ko ? '이 밖을 고치면 제출물이 격리됩니다.' : 'Changes outside are quarantined.'}</span>
            {dirs === null ? (
              <span className="hint">{ko ? '폴더 목록 불러오는 중…' : 'Loading folders…'}</span>
            ) : (
              <ChipToggles
                options={scopeOptions}
                selected={scope}
                onToggle={(v) => setScope(scope.includes(v) ? scope.filter((x) => x !== v) : [...scope, v])}
              />
            )}
            <details className="advanced">
              <summary>{ko ? '직접 입력 (glob, 한 줄에 하나)' : 'Custom globs (one per line)'}</summary>
              <textarea className="mono" value={customScope} onChange={(e) => setCustomScope(e.target.value)} placeholder="src/party/**" />
            </details>
          </label>
        )}
      </div>
    </Modal>
  );
}

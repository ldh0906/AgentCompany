import { useEffect, useState } from 'react';
import { api, type Employee } from '../api.ts';
import { useCompany } from '../App.tsx';
import { ACCESS, ROLE, useT } from '../i18n.ts';
import { Avatar, CliChip, EmptyState, Icon, Modal, useAction, Skeleton } from '../components/ui.tsx';
import { ChipToggles, ModelPicker, Segmented, useCliStatus } from '../components/kit.tsx';
import { fmtTokens } from '../components/usage.tsx';

const ROLES = Object.keys(ROLE.ko);

export function Org() {
  const { state, reload } = useCompany();
  const { t, lang, role, access, rank: rankLabel } = useT();
  const { busy, run } = useAction();
  const [hiring, setHiring] = useState(false);
  const [editing, setEditing] = useState<Employee | null>(null);
  const [modeling, setModeling] = useState<Employee | null>(null);
  const [removing, setRemoving] = useState<Employee | null>(null);
  if (!state) return <Skeleton />;
  const ko = lang === 'ko';
  const activeCount = state.employees.filter((e) => e.active).length;
  const staff = state.employees.filter((e) => !e.removedAt);
  const removedCount = state.employees.length - staff.length;
  const workload = (id: string) =>
    state.tickets.filter((x) => (x.assigneeId === id || x.reviewerId === id) && !['done', 'failed', 'cancelled'].includes(x.status)).length;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{t('nav_org')}</h1>
          <div className="sub">
            {t('activeLimit')} ({activeCount}/4) ·{' '}
            {ko ? '역할은 프롬프트 장식이 아니라 권한과 배정 규칙입니다.' : 'Roles are enforced permissions, not prompt decoration.'}
            {removedCount > 0 && (ko ? ` · 삭제한 직원 ${removedCount}명(기록에만 남음)` : ` · ${removedCount} removed (kept in history)`)}
          </div>
        </div>
        <button className="btn primary" disabled={activeCount >= 4} onClick={() => setHiring(true)}>
          <Icon name="plus" /> {t('hire')}
        </button>
      </div>

      <div className="grid cols-3">
        <div className="card" style={{ gridColumn: '1 / -1' }}>
          <div className="item">
            <div className="title row">
              <Icon name="shield" /> {ko ? '대표 (나)' : 'CEO (you)'}
            </div>
            <div className="meta">
              {ko
                ? '최종 승인 · 병합·삭제 승인 · 권한 변경 · 결정 확정. 어떤 직원도 이 권한을 가질 수 없습니다.'
                : 'Final approval, merges, deletions, permission changes, decisions. No employee can hold these.'}
            </div>
          </div>
        </div>
        {staff.length === 0 && (
          <div className="card" style={{ gridColumn: '1 / -1' }}>
            <EmptyState icon="team">
              <div style={{ color: 'var(--text)', fontWeight: 600, fontSize: 14 }}>{ko ? '아직 직원이 없습니다' : 'No employees yet'}</div>
              <div style={{ marginTop: 4 }}>
                {ko
                  ? '구현 담당과 검수 담당을 서로 다른 CLI로 두 명 이상 뽑으세요. 예: 구현 Claude Code, 검수 Codex.'
                  : 'Hire at least two, on different CLIs for implementing and reviewing — e.g. Claude Code builds, Codex reviews.'}
              </div>
              <button className="btn primary" style={{ marginTop: 14 }} onClick={() => setHiring(true)}>
                <Icon name="plus" /> {t('hire')}
              </button>
            </EmptyState>
          </div>
        )}
        {staff.map((e) => (
          <div className="card" key={e.id} style={{ opacity: e.active ? 1 : 0.55 }}>
            <div className="card-head">
              <span className="row">
                <Avatar employees={state.employees} id={e.id} /> {e.name}
              </span>
              <span className={`chip ${e.active ? 'ok' : ''}`}>{e.active ? t('active') : t('inactive')}</span>
            </div>
            <div className="body">
              <div className="row">
                <span className={`chip rank-${e.rank ?? 'senior'}`}>{rankLabel(e.rank)}</span>
                <CliChip cli={e.cli} model={e.model} effort={e.effort} />
              </div>
              <div className="sub" style={{ marginTop: 8 }}>
                {e.roles.map(role).join(' · ')}
              </div>
              <div style={{ marginTop: 8 }}>
                <span className={`chip ${e.accessLevel === 'full-auto' ? 'bad' : e.accessLevel === 'read-only' ? '' : 'info'}`}>
                  {access(e.accessLevel)}
                </span>
              </div>
              <div className="sub" style={{ marginTop: 8 }}>
                {ko ? '맡은 업무' : 'Workload'}: {workload(e.id)}
                {(state.usage?.byEmployee[e.id]?.total ?? 0) > 0 &&
                  ` · ${ko ? '토큰' : 'tokens'} ${fmtTokens(state.usage!.byEmployee[e.id]!.total, lang)}`}
              </div>
              <div className="row" style={{ marginTop: 12 }}>
                <button className="btn small" onClick={() => setEditing(e)}>
                  {t('access')}
                </button>
                <button className="btn small" onClick={() => setModeling(e)}>
                  {ko ? '모델' : 'Model'}
                </button>
                <select
                  className="small-select"
                  value={e.rank ?? 'senior'}
                  disabled={busy}
                  aria-label={ko ? '직급' : 'Rank'}
                  onChange={(ev) =>
                    run(
                      () => api(`employees/${e.id}/rank`, { body: { rank: ev.target.value } }),
                      ko ? '직급을 바꿨습니다.' : 'Rank changed.',
                    ).then(reload)
                  }
                >
                  {(['junior', 'senior', 'lead'] as const).map((r) => (
                    <option key={r} value={r}>
                      {rankLabel(r)}
                    </option>
                  ))}
                </select>
                <button
                  className="btn small"
                  disabled={busy}
                  onClick={() => run(() => api(`employees/${e.id}/active`, { body: { active: !e.active } }), 'OK').then(reload)}
                >
                  {e.active ? (ko ? '비활성화' : 'Deactivate') : ko ? '활성화' : 'Activate'}
                </button>
                <button className="btn small danger" onClick={() => setRemoving(e)}>
                  {ko ? '삭제' : 'Remove'}
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h2>{ko ? 'CLI별 지원 현황 (실측 기반)' : 'CLI capabilities (measured)'}</h2>
        <table>
          <thead>
            <tr>
              <th>CLI</th>
              <th>{t('access')}</th>
              <th>{ko ? '실행 중 승인 중계' : 'Permission relay'}</th>
              <th>{ko ? '메모' : 'Notes'}</th>
            </tr>
          </thead>
          <tbody>
            {state.adapters.map((a) => (
              <tr key={a.kind}>
                <td>
                  <b>{a.displayName}</b>
                </td>
                <td>
                  {a.capabilities.accessLevels.map((l) => (
                    <div key={l} className="sub">
                      {access(l)}
                    </div>
                  ))}
                </td>
                <td>{a.capabilities.permissionRelay ? <span className="chip ok">✓</span> : <span className="chip">—</span>}</td>
                <td>
                  {a.capabilities.notes.map((n) => (
                    <div key={n} className="sub">
                      {n}
                    </div>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {hiring && <HireModal onClose={() => setHiring(false)} />}
      {editing && <AccessModal employee={editing} onClose={() => setEditing(null)} />}
      {modeling && <ModelModal employee={modeling} onClose={() => setModeling(null)} />}
      {removing && (
        <Modal
          title={ko ? `${removing.name}을(를) 삭제할까요?` : `Remove ${removing.name}?`}
          onClose={() => setRemoving(null)}
          actions={
            <button
              className="btn danger"
              disabled={busy}
              onClick={() =>
                run(() => api(`employees/${removing.id}/remove`, { body: {} }), ko ? '직원을 삭제했습니다.' : 'Employee removed.').then(
                  (ok) => (reload(), ok && setRemoving(null)),
                )
              }
            >
              {ko ? '삭제' : 'Remove'}
            </button>
          }
        >
          <div className="sub" style={{ lineHeight: 1.7 }}>
            {ko
              ? '조직에서 빠지고 다시 활성화할 수 없습니다. 지난 업무·실행 기록에는 이름이 그대로 남습니다. 진행 중인 업무를 맡고 있으면 먼저 재배정하거나 취소해야 합니다.'
              : 'They leave the team and cannot be reactivated. Past tickets and runs keep their name. Reassign or cancel their open tickets first.'}
          </div>
        </Modal>
      )}
    </>
  );
}

const PRESETS: {
  key: string;
  roles: string[];
  rank: 'junior' | 'senior' | 'lead';
  ko: [string, string];
  en: [string, string];
}[] = [
  {
    key: 'impl',
    roles: ['implementer'],
    rank: 'senior',
    ko: ['구현 담당', '코드를 작성하고 고칩니다'],
    en: ['Implementer', 'Writes and fixes code'],
  },
  {
    key: 'qa',
    roles: ['qa'],
    rank: 'senior',
    ko: ['검수 담당 (QA)', '다른 직원의 작업을 검수하고 반박합니다'],
    en: ['Reviewer (QA)', 'Reviews and challenges others’ work'],
  },
  {
    key: 'lead',
    roles: ['chief-of-staff', 'planner', 'qa'],
    rank: 'lead',
    ko: ['팀장 · 비서실장', '요청을 업무로 나누고, 맡기고, 책임집니다'],
    en: ['Lead · chief of staff', 'Splits requests into tickets, delegates, owns the result'],
  },
  {
    key: 'docs',
    roles: ['recorder', 'planner'],
    rank: 'junior',
    ko: ['문서 · 기록', '설계 문서와 결정 기록을 정리합니다'],
    en: ['Docs · records', 'Keeps design docs and decisions tidy'],
  },
];
const CLI_SHORT: Record<string, string> = { claude: 'Claude', codex: 'Codex', agy: 'Antigravity', fake: 'Demo' };

function HireModal({ onClose }: { onClose: () => void }) {
  const { state, reload } = useCompany();
  const { t, lang, role, access, rank: rankLabel } = useT();
  const { busy, run } = useAction();
  const ko = lang === 'ko';
  const clis = useCliStatus();
  const [preset, setPreset] = useState('impl');
  const [cli, setCli] = useState<Employee['cli']>('claude');
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState('');
  const [roles, setRoles] = useState<string[]>(['implementer']);
  const [rank, setRank] = useState<'junior' | 'senior' | 'lead'>('senior');
  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const levels: Employee['accessLevel'][] =
    state?.adapters.find((a) => a.kind === cli)?.capabilities.accessLevels.filter((l) => l !== 'full-auto') ?? [];
  const [level, setLevel] = useState<string>('write-ask');

  useEffect(() => {
    if (!levels.includes(level as Employee['accessLevel']))
      setLevel(levels.includes('write-ask') ? 'write-ask' : (levels[0] ?? 'read-only'));
    setModel('');
    setEffort('');
  }, [cli]); // eslint-disable-line react-hooks/exhaustive-deps

  // 이름 자동 제안: "Claude 구현", 겹치면 번호
  const p = PRESETS.find((x) => x.key === preset);
  const baseName = `${CLI_SHORT[cli] ?? cli} ${p ? (ko ? p.ko[0] : p.en[0]).split(' ')[0] : ko ? '직원' : 'Employee'}`;
  const taken = new Set(state?.employees.map((e) => e.name));
  let suggested = baseName;
  for (let i = 2; taken.has(suggested); i++) suggested = `${baseName} ${i}`;
  const finalName = nameTouched ? name : suggested;

  const pickPreset = (key: string) => {
    setPreset(key);
    const x = PRESETS.find((y) => y.key === key);
    if (x) {
      setRoles(x.roles);
      setRank(x.rank);
    }
  };
  const status = (kind: string) => clis?.find((c) => c.kind === kind);
  const realClis = state?.adapters.filter((a) => a.kind !== 'fake') ?? [];

  return (
    <Modal
      title={t('hire')}
      onClose={onClose}
      actions={
        <button
          className="btn primary"
          disabled={busy || !finalName.trim() || !roles.length}
          onClick={() =>
            run(
              () =>
                api('employees', {
                  body: { name: finalName.trim(), cli, model: model || null, effort: effort || null, roles, rank, accessLevel: level },
                }),
              ko ? `${finalName}을(를) 채용했습니다.` : `Hired ${finalName}.`,
            ).then((ok) => ok && (reload(), onClose()))
          }
        >
          <Icon name="plus" /> {ko ? '채용하기' : 'Hire'}
        </button>
      }
    >
      <div className="form">
        <div className="field-label">{ko ? '어떤 직원이 필요하세요?' : 'What do you need?'}</div>
        <div className="preset-grid">
          {PRESETS.map((x) => (
            <button key={x.key} type="button" className={`preset ${preset === x.key ? 'on' : ''}`} onClick={() => pickPreset(x.key)}>
              <b>{ko ? x.ko[0] : x.en[0]}</b>
              <span>{ko ? x.ko[1] : x.en[1]}</span>
              <span className="chip">{rankLabel(x.rank)}</span>
            </button>
          ))}
        </div>

        <div className="field-label">{ko ? '어떤 AI로 할까요?' : 'Which AI?'}</div>
        <div className="cli-grid">
          {realClis.map((a) => {
            const s = status(a.kind);
            const tone = !clis ? '' : !s?.found ? 'bad' : s.login === 'ok' ? 'ok' : s.login === 'missing' ? 'warn' : '';
            const label = !clis
              ? ko
                ? '확인 중…'
                : 'Checking…'
              : !s?.found
                ? ko
                  ? '설치 안 됨'
                  : 'Not installed'
                : s.login === 'ok'
                  ? ko
                    ? '준비됨'
                    : 'Ready'
                  : s.login === 'missing'
                    ? ko
                      ? '로그인 필요'
                      : 'Login needed'
                    : ko
                      ? '첫 실행 때 확인'
                      : 'Checked on first run';
            return (
              <button
                key={a.kind}
                type="button"
                className={`cli-card ${cli === a.kind ? 'on' : ''}`}
                disabled={Boolean(clis && s && !s.found)}
                onClick={() => setCli(a.kind)}
              >
                <span className={`avatar ${a.kind}`}>{a.displayName[0]}</span>
                <b>{a.displayName}</b>
                <span className={`chip ${tone}`}>{label}</span>
              </button>
            );
          })}
        </div>

        <div className="row" style={{ alignItems: 'flex-start' }}>
          <label style={{ flex: 1 }}>
            {t('model')}
            <ModelPicker
              autoSelect
              cli={cli}
              model={model}
              effort={effort}
              onChange={(m, e) => {
                setModel(m);
                setEffort(e);
              }}
            />
          </label>
          <label>
            {ko ? '직급' : 'Rank'}
            <Segmented
              value={rank}
              onChange={setRank}
              options={(['junior', 'senior', 'lead'] as const).map((r) => ({ value: r, label: rankLabel(r) }))}
            />
          </label>
        </div>
        <div className="hint" style={{ marginTop: -6 }}>
          {ko
            ? '팀장이 일을 맡기고 책임지며 어려운 업무를 맡습니다. 검수는 같거나 높은 직급이 합니다.'
            : 'Leads delegate, own results and take hard tickets. Reviews come from the same rank or higher.'}
        </div>

        <label>
          {t('roles')}{' '}
          <span className="hint">{ko ? '어떤 종류의 업무를 맡길지 정합니다.' : 'Which kinds of tickets this employee takes.'}</span>
          <ChipToggles
            options={ROLES.map((r) => ({ value: r, label: role(r) }))}
            selected={roles}
            onToggle={(r) => setRoles(roles.includes(r) ? roles.filter((x) => x !== r) : [...roles, r])}
          />
        </label>

        <div className="row" style={{ alignItems: 'flex-start' }}>
          <label style={{ flex: 1 }}>
            {t('name')}
            <input
              value={finalName}
              onChange={(e) => {
                setNameTouched(true);
                setName(e.target.value);
              }}
            />
          </label>
          <label style={{ flex: 1 }}>
            {t('access')}
            <select value={level} onChange={(e) => setLevel(e.target.value)}>
              {levels.map((l) => (
                <option key={l} value={l}>
                  {access(l)}
                </option>
              ))}
            </select>
            <span className="hint">{ko ? '전체 자동은 채용 후 따로 올릴 수 있습니다.' : 'Full auto can be granted later.'}</span>
          </label>
        </div>
      </div>
    </Modal>
  );
}

function ModelModal({ employee, onClose }: { employee: Employee; onClose: () => void }) {
  const { reload } = useCompany();
  const { lang } = useT();
  const { busy, run } = useAction();
  const ko = lang === 'ko';
  const [model, setModel] = useState(employee.model ?? '');
  const [effort, setEffort] = useState(employee.effort ?? '');
  return (
    <Modal
      title={`${employee.name} · ${ko ? '모델' : 'Model'}`}
      onClose={onClose}
      actions={
        <button
          className="btn primary"
          disabled={busy}
          onClick={() =>
            run(
              () => api(`employees/${employee.id}/model`, { body: { model, effort } }),
              ko ? '모델을 바꿨습니다.' : 'Model updated.',
            ).then((ok) => ok && (reload(), onClose()))
          }
        >
          {ko ? '저장' : 'Save'}
        </button>
      }
    >
      <div className="form">
        <ModelPicker
          cli={employee.cli}
          model={model}
          effort={effort}
          onChange={(m, e) => {
            setModel(m);
            setEffort(e);
          }}
        />
        <div className="hint">
          {ko ? '다음 실행부터 적용됩니다. 진행 중인 실행은 그대로 끝납니다.' : 'Applies from the next run; running work finishes as is.'}
        </div>
      </div>
    </Modal>
  );
}

function AccessModal({ employee, onClose }: { employee: Employee; onClose: () => void }) {
  const { state, reload } = useCompany();
  const { t, lang, access } = useT();
  const { busy, run } = useAction();
  const [level, setLevel] = useState<string>(employee.accessLevel);
  const [confirmText, setConfirmText] = useState('');
  const levels = state?.adapters.find((a) => a.kind === employee.cli)?.capabilities.accessLevels ?? [];
  const ko = lang === 'ko';
  return (
    <Modal
      title={`${employee.name} · ${t('access')}`}
      onClose={onClose}
      actions={
        <button
          className="btn primary"
          disabled={busy || (level === 'full-auto' && confirmText !== 'full-auto')}
          onClick={() =>
            run(() => api(`employees/${employee.id}/access`, { body: { accessLevel: level, confirm: confirmText } }), 'OK').then(
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
          {t('access')}
          <select value={level} onChange={(e) => setLevel(e.target.value)}>
            {levels.map((l) => (
              <option key={l} value={l}>
                {access(l)}
              </option>
            ))}
          </select>
        </label>
        {level === 'full-auto' && (
          <div className="banner bad">
            {ko
              ? '전체 자동은 직원이 묻지 않고 명령을 실행합니다. CLI에 따라 브라우저 조작·웹 검색·메시지 보내기 같은 도구까지 허용됩니다(agy 실측). 사후 범위 검사는 그대로 적용되지만, 실행 중 차단은 되지 않습니다. 계속하려면 full-auto 를 입력하세요.'
              : 'Full auto runs commands without asking. Depending on the CLI this also allows tools like browser control, web search and sending messages (measured on agy). Post-run scope checks still apply, but nothing is blocked during the run. Type full-auto to confirm.'}
            <input style={{ marginTop: 8 }} value={confirmText} onChange={(e) => setConfirmText(e.target.value)} />
          </div>
        )}
      </div>
    </Modal>
  );
}

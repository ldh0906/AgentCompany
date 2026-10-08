import { useEffect, useState } from 'react';
import { api, type Employee } from '../api.ts';
import { useCompany, useRoute } from '../App.tsx';
import { ACCESS, josa, ROLE, useT } from '../i18n.ts';
import { MAX_ACTIVE_EMPLOYEES } from '../../../src/core/types.ts';
import { Avatar, CliChip, EmptyState, Icon, Modal, useAction, Skeleton } from '../components/ui.tsx';
import { ChipToggles, CliConnect, ModelPicker, Segmented, useCliStatus } from '../components/kit.tsx';
import { fmtTokens } from '../components/usage.tsx';

const ROLES = Object.keys(ROLE.ko);

export function Org() {
  const { state, reload } = useCompany();
  const { go } = useRoute();
  const { t, lang, role, access, rank: rankLabel } = useT();
  const { busy, run } = useAction();
  const [hiring, setHiring] = useState(false);
  const [editing, setEditing] = useState<Employee | null>(null);
  const [modeling, setModeling] = useState<Employee | null>(null);
  const [removing, setRemoving] = useState<Employee | null>(null);
  const [profiling, setProfiling] = useState<Employee | null>(null);
  const [quickTeam, setQuickTeam] = useState(false);
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
            {t('activeLimit')} ({activeCount}/{MAX_ACTIVE_EMPLOYEES}) ·{' '}
            {ko ? '역할에 따라 할 수 있는 일과 맡는 업무가 정해집니다.' : 'Roles decide what each employee may do and gets assigned.'}
            {removedCount > 0 && (ko ? ` · 삭제한 직원 ${removedCount}명(기록에만 남음)` : ` · ${removedCount} removed (kept in history)`)}
          </div>
        </div>
        <button className="btn primary" disabled={activeCount >= MAX_ACTIVE_EMPLOYEES} onClick={() => setHiring(true)}>
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
                  ? '"기본 팀 한 번에 만들기"를 누르면 팀장·구현·검수 담당을 연결된 AI로 섞어 한 번에 뽑습니다.'
                  : 'Hire at least two, on different CLIs for implementing and reviewing — e.g. Claude Code builds, Codex reviews.'}
              </div>
              <div className="row" style={{ marginTop: 14, justifyContent: 'center' }}>
                <button className="btn primary" onClick={() => setQuickTeam(true)}>
                  <Icon name="team" /> {ko ? '기본 팀 한 번에 만들기' : 'Create a standard team'}
                </button>
                <button className="btn" onClick={() => setHiring(true)}>
                  <Icon name="plus" /> {t('hire')}
                </button>
              </div>
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
              {/* 한 달 예산: 넘으면 하던 실행만 마치고 멈춘다(Paperclip처럼 직원 단위 한도) */}
              {(() => {
                const b = state.employeeBudgets?.[e.id];
                const over = b && b.used >= b.limit;
                return (
                  <div className="row" style={{ marginTop: 6 }}>
                    <span className={`chip ${over ? 'bad' : ''}`}>
                      {b
                        ? `${ko ? '이번 달' : 'This month'} ${fmtTokens(b.used, lang)} / ${fmtTokens(b.limit, lang)}${over ? (ko ? ' · 멈춤' : ' · stopped') : ''}`
                        : ko
                          ? '월 예산 없음'
                          : 'No monthly budget'}
                    </span>
                    <button
                      className="btn small"
                      disabled={busy}
                      onClick={() => {
                        const cur = b ? String(Math.round(b.limit / 10_000)) : '';
                        const v = window.prompt(
                          ko
                            ? `${e.name}의 한 달 토큰 한도(만 단위, 0이면 없음). 넘으면 하던 실행만 마치고 멈춥니다.`
                            : `${e.name}'s monthly token limit in units of 10k (0 = none). When reached, running work finishes and new work stops.`,
                          cur,
                        );
                        if (v === null) return;
                        void run(
                          () => api(`employees/${e.id}/budget`, { body: { monthlyTokenLimit: Math.max(0, Number(v) || 0) * 10_000 } }),
                          ko ? '예산을 바꿨습니다.' : 'Budget updated.',
                        ).then(reload);
                      }}
                    >
                      {ko ? '월 예산' : 'Budget'}
                    </button>
                  </div>
                );
              })()}
              <div className="row" style={{ marginTop: 12 }}>
                <button
                  className="btn small primary"
                  onClick={() => void api<{ id: string }>(`dm/${e.id}`, { body: {} }).then((c) => go(`/chat/${encodeURIComponent(c.id)}`))}
                >
                  {ko ? '1:1 대화' : 'Chat'}
                </button>
                <button className="btn small" onClick={() => setProfiling(e)}>
                  {ko ? '정보 수정' : 'Edit'}
                </button>
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
                  onClick={() =>
                    run(
                      () => api(`employees/${e.id}/active`, { body: { active: !e.active } }),
                      e.active ? (ko ? '비활성화했습니다.' : 'Deactivated.') : ko ? '활성화했습니다.' : 'Activated.',
                    ).then(reload)
                  }
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

      <details className="card advanced" style={{ marginTop: 16 }}>
        <summary>{ko ? 'CLI별 지원 현황 (개발자용 세부 정보)' : 'CLI capabilities (developer details)'}</summary>
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
      </details>

      {hiring && <HireModal onClose={() => setHiring(false)} />}
      {quickTeam && <QuickTeamModal onClose={() => setQuickTeam(false)} />}
      {editing && <AccessModal employee={editing} onClose={() => setEditing(null)} />}
      {modeling && <ModelModal employee={modeling} onClose={() => setModeling(null)} />}
      {profiling && <ProfileModal employee={profiling} onClose={() => setProfiling(null)} />}
      {removing && (
        <Modal
          title={ko ? `${josa(removing.name, '을/를')} 삭제할까요?` : `Remove ${removing.name}?`}
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
              ko ? `${josa(finalName, '을/를')} 채용했습니다.` : `Hired ${finalName}.`,
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

/** 기본 팀 한 번에: 팀장(비서실장) + 구현 2 + 검수 2, 준비된 CLI를 섞어서. 실측: 채용 창을 5번 여는 게 가장 번거로웠다. */
function QuickTeamModal({ onClose }: { onClose: () => void }) {
  const { state, reload } = useCompany();
  const { lang } = useT();
  const ko = lang === 'ko';
  const { busy, run } = useAction();
  const clis = useCliStatus();
  const [fullAuto, setFullAuto] = useState(true);
  // 로그인 확인된 AI를 먼저(첫 실행 때 확인하는 AI는 뒤로).
  const ready = (clis ?? [])
    .filter((c) => c.found && c.login !== 'missing')
    .sort((x, y) => Number(y.login === 'ok') - Number(x.login === 'ok'))
    .map((c) => c.kind);
  const a = ready.includes('claude') ? 'claude' : ready[0];
  const notReady = (clis ?? []).some((c) => c.found && c.login !== 'ok');
  const b = ready.find((k) => k !== a) ?? a;
  const label = (k: string | undefined) => CLI_SHORT[k ?? ''] ?? k ?? '';
  // 허용 목록 등급이 없는 AI(Antigravity: 읽기 전용·전체 자동뿐)는 전체 자동으로만 일할 수 있다.
  // 실측(첫 사용): 연결된 AI가 Antigravity뿐이면 첫 채용부터 "등급을 지원하지 않습니다"로 실패했다.
  const onlyFullAuto = (cli: string) =>
    !(state?.adapters.find((x) => x.kind === cli)?.capabilities.accessLevels ?? []).includes('write-allowlist');
  const plan =
    a === undefined
      ? []
      : [
          { name: `${label(a)} 팀장`, cli: a, roles: ['chief-of-staff', 'planner', 'qa'], rank: 'lead', lead: true },
          { name: `${label(a)} 구현`, cli: a, roles: ['implementer'], rank: 'senior' },
          ...(b !== a ? [{ name: `${label(b)} 구현`, cli: b, roles: ['implementer'], rank: 'senior' }] : []),
          { name: `${label(b)} 검수`, cli: b, roles: ['qa'], rank: 'senior' },
          ...(b !== a ? [{ name: `${label(a)} 검수`, cli: a, roles: ['qa'], rank: 'senior' }] : []),
        ];
  const create = () =>
    run(
      async () => {
        // 채용 폼과 같게: CLI마다 쓸 수 있는 첫 모델의 정확한 이름과 기본 effort, 흔한 읽기 명령 허용 목록.
        const pick: Record<string, { id: string; defaultEffort?: string } | undefined> = {};
        for (const cli of new Set(plan.map((p) => p.cli))) {
          const list = await api<{ models: { id: string; defaultEffort?: string; unavailable?: string }[] }>(`models?cli=${cli}`).catch(
            () => ({ models: [] }),
          );
          pick[cli] = list.models.find((m) => !m.unavailable);
        }
        for (const p of plan) {
          const e = await api<Employee>('employees', {
            body: {
              name: p.name,
              cli: p.cli,
              model: pick[p.cli]?.id ?? null,
              effort: pick[p.cli]?.defaultEffort ?? null,
              roles: p.roles,
              rank: p.rank,
              accessLevel: onlyFullAuto(p.cli) ? 'read-only' : 'write-allowlist',
              allowedCommands: [
                ['git', 'status'],
                ['git', 'diff'],
                ['git', 'log'],
              ],
            },
          });
          if (('lead' in p && fullAuto) || onlyFullAuto(p.cli))
            await api(`employees/${e.id}/access`, { body: { accessLevel: 'full-auto', confirm: 'full-auto' } });
        }
      },
      ko ? `직원 ${plan.length}명을 채용했습니다.` : `Hired ${plan.length} employees.`,
    ).then((ok) => ok && (reload(), onClose()));
  return (
    <Modal
      title={ko ? '기본 팀 한 번에 만들기' : 'Create a standard team'}
      onClose={onClose}
      actions={
        <button className="btn primary" disabled={busy || !plan.length} onClick={() => void create()}>
          <Icon name="plus" /> {ko ? `${plan.length}명 채용` : `Hire ${plan.length}`}
        </button>
      }
    >
      <div className="form">
        {clis === null ? (
          <div className="sub">{ko ? 'AI 확인 중…' : 'Checking AIs…'}</div>
        ) : !plan.length ? (
          <div className="banner bad">
            {clis.some((c) => c.found)
              ? ko
                ? '연결된 AI가 없습니다. 아래에서 로그인하세요.'
                : 'No AI is connected yet. Log in below.'
              : ko
                ? '설치된 AI(Claude Code·Codex·Antigravity)가 없습니다. 하나 이상 설치한 뒤 다시 여세요.'
                : 'No AI CLI (Claude Code, Codex, Antigravity) is installed.'}
          </div>
        ) : (
          <div className="list">
            {plan.map((p) => (
              <div className="item" key={p.name}>
                <b>{p.name}</b>{' '}
                <span className="sub">
                  {p.roles.map((r) => ROLE[lang][r] ?? r).join(' · ')} · {RANK_LABEL(ko, p.rank)}
                </span>
                {onlyFullAuto(p.cli) && (
                  <span
                    className="chip bad"
                    title={ko ? '이 AI는 읽기 전용과 전체 자동만 지원합니다.' : 'This AI supports only read-only and full-auto.'}
                  >
                    {ko ? '전체 자동' : 'Full auto'}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
        <label className="check-row">
          <input type="checkbox" checked={fullAuto} onChange={() => setFullAuto(!fullAuto)} />
          <span>
            {ko
              ? '팀장을 전체 자동으로 두고, 다른 직원의 권한 요청을 대표 대신 처리하게 합니다(치명적인 명령만 차단). 끄면 권한 요청마다 대표가 허용을 눌러야 합니다.'
              : 'Make the lead full-auto so it answers the others’ permission requests for you (only catastrophic commands are blocked). Otherwise you click Allow for each request.'}
          </span>
        </label>
        <div className="hint">
          {b !== a
            ? ko
              ? '서로 다른 AI가 구현과 검수를 나눠 맡습니다. 모델·이름은 채용 뒤 바꿀 수 있습니다.'
              : 'Different AIs build and review. Models and names can be changed later.'
            : ko
              ? '지금은 한 종류 AI만 연결되어 같은 AI끼리 검수합니다. 다른 AI에 로그인한 뒤 만들면 서로 다른 AI가 검수해 실수를 더 잘 잡습니다.'
              : 'Only one kind of AI is connected, so it reviews its own kind. Log in to another AI first for cross-checking.'}
        </div>
        {clis && notReady && (
          <details className="advanced" open={b === a}>
            <summary>{ko ? 'AI 연결 상태' : 'AI connections'}</summary>
            <CliConnect />
          </details>
        )}
      </div>
    </Modal>
  );
}

const RANK_LABEL = (ko: boolean, r: string) =>
  ko ? (({ lead: '팀장', senior: '선임', junior: '사원' } as Record<string, string>)[r] ?? r) : r;

function ProfileModal({ employee, onClose }: { employee: Employee; onClose: () => void }) {
  const { reload } = useCompany();
  const { t, lang, role } = useT();
  const { busy, run } = useAction();
  const ko = lang === 'ko';
  const [name, setName] = useState(employee.name);
  const [roles, setRoles] = useState<string[]>(employee.roles);
  return (
    <Modal
      title={`${employee.name} · ${ko ? '정보 수정' : 'Edit profile'}`}
      onClose={onClose}
      actions={
        <button
          className="btn primary"
          disabled={busy || !name.trim() || !roles.length}
          onClick={() =>
            run(
              () => api(`employees/${employee.id}/profile`, { body: { name: name.trim(), roles } }),
              ko ? '직원 정보를 바꿨습니다.' : 'Profile updated.',
            ).then((ok) => ok && (reload(), onClose()))
          }
        >
          {t('save')}
        </button>
      }
    >
      <div className="form">
        <label>
          {t('name')}
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          {t('roles')}
          <ChipToggles
            options={ROLES.map((r) => ({ value: r, label: role(r) }))}
            selected={roles}
            onToggle={(r) => setRoles(roles.includes(r) ? roles.filter((x) => x !== r) : [...roles, r])}
          />
        </label>
        <div className="hint">
          {ko
            ? '이미 맡은 업무는 그대로 두고, 다음 배정부터 적용됩니다.'
            : 'Open tickets keep their assignee; applies to the next assignment.'}
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
  // 비어 있으면 프로젝트 검증 명령과 흔한 읽기 명령을 제안으로 채운다(빈 허용 목록은 등급 2와 같다).
  const suggestedAllow = [
    ...new Set([
      ...(state?.projects ?? []).flatMap((p) => p.verifyCommands.map((v) => v.argv.join(' '))),
      'git status',
      'git diff',
      'git log',
    ]),
  ];
  const [allowText, setAllowText] = useState(
    employee.allowedCommands.length ? employee.allowedCommands.map((a) => a.join(' ')).join('\n') : suggestedAllow.join('\n'),
  );
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
            run(
              () =>
                api(`employees/${employee.id}/access`, {
                  body: {
                    accessLevel: level,
                    confirm: confirmText,
                    ...(level === 'write-allowlist'
                      ? {
                          allowedCommands: allowText
                            .split('\n')
                            .map((l) => l.trim())
                            .filter(Boolean),
                        }
                      : {}),
                  },
                }),
              ko ? '접근 등급을 바꿨습니다.' : 'Access level changed.',
            ).then((ok) => ok && (reload(), onClose()))
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
        {level === 'write-allowlist' && (
          <label>
            {ko ? '자동 허용할 명령 (한 줄에 하나)' : 'Commands to allow automatically (one per line)'}{' '}
            <span className="hint">
              {ko
                ? '이 명령으로 시작하는 실행은 묻지 않고 허용합니다. ; & | $ 같은 셸 연결 문자는 넣을 수 없습니다. 예: npm test'
                : 'Runs starting with these are allowed without asking. No shell operators (; & | $). e.g. npm test'}
            </span>
            <textarea
              className="mono"
              value={allowText}
              onChange={(e) => setAllowText(e.target.value)}
              placeholder={'npm test\ngit status\ndotnet build'}
            />
          </label>
        )}
        {level === 'full-auto' && (
          <div className="banner bad">
            {ko
              ? '전체 자동은 직원이 묻지 않고 명령을 실행합니다(드라이브 삭제·포맷 같은 치명적 명령만 막음). AI에 따라 브라우저 조작·웹 검색 같은 도구까지 허용됩니다. 전체 자동 직원 중 직급이 가장 높은 사람이 다른 직원들의 권한 요청도 대표 대신 처리하므로, 보통 팀장 한 명을 전체 자동으로 두면 일일이 허용을 누를 필요가 없습니다. 계속하려면 full-auto 를 입력하세요.'
              : "Full auto runs commands without asking (only catastrophic ones like drive wipes are blocked). Depending on the CLI this includes tools like browser control and web search. The highest-ranked full-auto employee also answers the other employees' permission requests for you, so one full-auto lead usually means no more clicking Allow. Type full-auto to confirm."}
            <input style={{ marginTop: 8 }} value={confirmText} onChange={(e) => setConfirmText(e.target.value)} />
          </div>
        )}
      </div>
    </Modal>
  );
}

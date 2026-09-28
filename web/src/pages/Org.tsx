import { useEffect, useState } from 'react';
import { api, type Employee } from '../api.ts';
import { useCompany } from '../App.tsx';
import { ACCESS, ROLE, useT } from '../i18n.ts';
import { CliChip, Modal, useAction } from '../components/ui.tsx';

const ROLES = Object.keys(ROLE.ko);
const MODEL_HINT: Record<string, string> = {
  claude: 'opus / sonnet / (비우면 CLI 기본값)',
  codex: 'gpt-6-astra (비우면 CLI 기본값)',
  agy: 'agy models 로 확인 (비우면 기본값)',
  fake: 'diligent · lazy · rogue · slow',
};

export function Org() {
  const { state, reload } = useCompany();
  const { t, lang, role, access } = useT();
  const { busy, run } = useAction();
  const [hiring, setHiring] = useState(false);
  const [editing, setEditing] = useState<Employee | null>(null);
  if (!state) return <div className="emptystate">{t('loading')}</div>;
  const ko = lang === 'ko';
  const activeCount = state.employees.filter((e) => e.active).length;
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
          </div>
        </div>
        <button className="btn primary" disabled={activeCount >= 4} onClick={() => setHiring(true)}>
          + {t('hire')}
        </button>
      </div>

      <div className="grid cols-3">
        <div className="card" style={{ gridColumn: '1 / -1' }}>
          <div className="item">
            <div className="title">👤 {ko ? '대표 (나)' : 'CEO (you)'}</div>
            <div className="meta">
              {ko
                ? '최종 승인 · 병합·삭제 승인 · 권한 변경 · 결정 확정. 어떤 직원도 이 권한을 가질 수 없습니다.'
                : 'Final approval, merges, deletions, permission changes, decisions. No employee can hold these.'}
            </div>
          </div>
        </div>
        {state.employees.map((e) => (
          <div className="card" key={e.id} style={{ opacity: e.active ? 1 : 0.55 }}>
            <div className="card-head">
              <span>{e.name}</span>
              <span className={`chip ${e.active ? 'ok' : ''}`}>{e.active ? t('active') : t('inactive')}</span>
            </div>
            <div className="body">
              <div className="row">
                <CliChip cli={e.cli} model={e.model} />
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
              </div>
              <div className="row" style={{ marginTop: 12 }}>
                <button className="btn small" onClick={() => setEditing(e)}>
                  {t('access')}
                </button>
                <button
                  className="btn small"
                  disabled={busy}
                  onClick={() => run(() => api(`employees/${e.id}/active`, { body: { active: !e.active } }), 'OK').then(reload)}
                >
                  {e.active ? (ko ? '비활성화' : 'Deactivate') : ko ? '활성화' : 'Activate'}
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
    </>
  );
}

function HireModal({ onClose }: { onClose: () => void }) {
  const { state, reload } = useCompany();
  const { t, lang, role, access } = useT();
  const { busy, run } = useAction();
  const [name, setName] = useState('');
  const [cli, setCli] = useState<Employee['cli']>('claude');
  const [model, setModel] = useState('');
  const [roles, setRoles] = useState<string[]>(['implementer']);
  const levels: Employee['accessLevel'][] =
    state?.adapters.find((a) => a.kind === cli)?.capabilities.accessLevels.filter((l) => l !== 'full-auto') ?? [];
  const [level, setLevel] = useState<string>('write-ask');
  useEffect(() => {
    if (!levels.includes(level as Employee['accessLevel']))
      setLevel(levels.includes('write-ask') ? 'write-ask' : (levels[0] ?? 'read-only'));
  }, [cli]); // eslint-disable-line react-hooks/exhaustive-deps
  const ko = lang === 'ko';

  return (
    <Modal
      title={t('hire')}
      onClose={onClose}
      actions={
        <button
          className="btn primary"
          disabled={busy || !name.trim() || !roles.length}
          onClick={() =>
            run(
              () => api('employees', { body: { name, cli, model: model || null, roles, accessLevel: level } }),
              ko ? '직원을 추가했습니다.' : 'Hired.',
            ).then((ok) => ok && (reload(), onClose()))
          }
        >
          {t('create')}
        </button>
      }
    >
      <div className="form">
        <label>
          {t('name')}
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={ko ? '예: 코덱스 QA' : 'e.g. Codex QA'} autoFocus />
        </label>
        <label>
          {t('cli')}
          <select value={cli} onChange={(e) => setCli(e.target.value as Employee['cli'])}>
            {state?.adapters.map((a) => (
              <option key={a.kind} value={a.kind}>
                {a.displayName}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t('model')} <span className="hint">{MODEL_HINT[cli]}</span>
          <input value={model} onChange={(e) => setModel(e.target.value)} />
        </label>
        <label>
          {t('roles')}
          <div className="checks">
            {ROLES.map((r) => (
              <label key={r}>
                <input
                  type="checkbox"
                  checked={roles.includes(r)}
                  onChange={(e) => setRoles(e.target.checked ? [...roles, r] : roles.filter((x) => x !== r))}
                />
                {role(r)}
              </label>
            ))}
          </div>
        </label>
        <label>
          {t('access')}{' '}
          <span className="hint">{ko ? '전체 자동은 직원을 만든 뒤 따로 올릴 수 있습니다.' : 'Full auto can be granted later.'}</span>
          <select value={level} onChange={(e) => setLevel(e.target.value)}>
            {levels.map((l) => (
              <option key={l} value={l}>
                {access(l)}
              </option>
            ))}
          </select>
        </label>
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
              ? '전체 자동은 직원이 묻지 않고 명령을 실행합니다. 사후 범위 검사는 그대로 적용되지만, 실행 중 차단은 되지 않습니다. 계속하려면 full-auto 를 입력하세요.'
              : 'Full auto runs commands without asking. Post-run scope checks still apply. Type full-auto to confirm.'}
            <input style={{ marginTop: 8 }} value={confirmText} onChange={(e) => setConfirmText(e.target.value)} />
          </div>
        )}
      </div>
    </Modal>
  );
}

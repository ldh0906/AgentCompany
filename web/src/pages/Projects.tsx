import { useEffect, useState } from 'react';
import { api, type Project } from '../api.ts';
import { useCompany } from '../App.tsx';
import { EVIDENCE, useT } from '../i18n.ts';
import { EmptyState, Icon, Modal, useAction, Skeleton } from '../components/ui.tsx';
import { ChipToggles, FolderPicker, Segmented } from '../components/kit.tsx';

export function Projects() {
  const { state } = useCompany();
  const { t, lang } = useT();
  const [editing, setEditing] = useState<Project | 'new' | null>(null);
  if (!state) return <Skeleton />;
  const ko = lang === 'ko';
  return (
    <>
      <div className="page-head">
        <div>
          <h1>{t('nav_projects')}</h1>
          <div className="sub">
            {ko
              ? '원본 저장소는 대표 승인 전까지 절대 수정되지 않습니다. 직원은 격리된 미러의 작업공간에서만 일합니다.'
              : 'Your repo is never modified before your approval. Employees work in isolated mirror worktrees.'}
          </div>
        </div>
        <button className="btn primary" onClick={() => setEditing('new')}>
          <Icon name="plus" /> {ko ? '프로젝트 등록' : 'Register project'}
        </button>
      </div>
      {state.projects.length === 0 && (
        <div className="card">
          <EmptyState icon="folder">
            <div style={{ color: 'var(--text)', fontWeight: 600, fontSize: 14 }}>
              {ko ? '아직 등록된 프로젝트가 없습니다' : 'No projects yet'}
            </div>
            <div style={{ marginTop: 4 }}>
              {ko
                ? '로컬 git 저장소 경로와 검증 명령(예: npm test)만 있으면 됩니다.'
                : 'All you need is a local git repository and a verify command (e.g. npm test).'}
            </div>
            <button className="btn primary" style={{ marginTop: 14 }} onClick={() => setEditing('new')}>
              <Icon name="plus" /> {ko ? '첫 프로젝트 등록' : 'Register your first project'}
            </button>
          </EmptyState>
        </div>
      )}
      <div className="grid cols-2">
        {state.projects.map((p) => (
          <div className="card" key={p.id}>
            <div className="card-head">
              <span>{p.name}</span>
              <button className="btn small" onClick={() => setEditing(p)}>
                {ko ? '설정' : 'Settings'}
              </button>
            </div>
            <div className="body">
              <div className="sub mono">{p.originPath}</div>
              <div className="row" style={{ marginTop: 8 }}>
                <span className="chip">{p.baseBranch}</span>
                <span className={`chip ${p.integrationMode === 'auto_after_approval' ? 'warn' : 'info'}`}>
                  {p.integrationMode === 'auto_after_approval'
                    ? ko
                      ? '승인 후 자동 병합'
                      : 'Auto merge after approval'
                    : ko
                      ? '브랜치만 (수동 병합)'
                      : 'Branch only (manual merge)'}
                </span>
              </div>
              <div style={{ marginTop: 10 }}>
                <b>{ko ? '검증 명령' : 'Verify commands'}</b>
                {p.verifyCommands.length === 0 ? (
                  <div className="sub">
                    {ko
                      ? '없음 — 단위 테스트 증거가 필요한 요구사항은 승인될 수 없습니다.'
                      : 'None — requirements needing test evidence cannot pass.'}
                  </div>
                ) : (
                  p.verifyCommands.map((v) => (
                    <div key={v.label} className="sub mono">
                      {v.label}: {v.argv.join(' ')}
                    </div>
                  ))
                )}
              </div>
              <div style={{ marginTop: 10 }}>
                <b>{ko ? '보호 경로' : 'Protected paths'}</b>
                <div className="row">
                  {p.protectedPaths.length ? (
                    p.protectedPaths.map((g) => (
                      <code key={g} className="chip">
                        {g}
                      </code>
                    ))
                  ) : (
                    <span className="sub">—</span>
                  )}
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
      {editing && <ProjectModal project={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </>
  );
}

type VerifyRow = { label: string; evidenceType: string; command: string };

const splitArgs = (cmd: string) => cmd.match(/"[^"]*"|'[^']*'|\S+/g)?.map((a) => a.replace(/^["']|["']$/g, '')) ?? [];
const joinArgs = (argv: string[]) => argv.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ');

interface Inspection {
  exists: boolean;
  isGit: boolean;
  name: string;
  baseBranch: string;
  branches: string[];
  verify: { label: string; evidenceType: string; argv: string[] }[];
  dirs: string[];
  protectedSuggestions: string[];
}

function ProjectModal({ project, onClose }: { project: Project | null; onClose: () => void }) {
  const { reload } = useCompany();
  const { t, lang, evidence } = useT();
  const { busy, run } = useAction();
  const ko = lang === 'ko';
  const [name, setName] = useState(project?.name ?? '');
  const [nameTouched, setNameTouched] = useState(Boolean(project));
  const [originPath, setOriginPath] = useState(project?.originPath ?? '');
  const [baseBranch, setBaseBranch] = useState(project?.baseBranch ?? 'main');
  const [mode, setMode] = useState(project?.integrationMode ?? 'manual');
  const [protectedPaths, setProtected] = useState<string[]>(project?.protectedPaths ?? []);
  const [newProtected, setNewProtected] = useState('');
  const [verify, setVerify] = useState<VerifyRow[]>(
    project?.verifyCommands.map((v) => ({ label: v.label, evidenceType: v.evidenceType, command: joinArgs(v.argv) })) ?? [],
  );
  const [docRules, setDocRules] = useState(project?.docRules ?? '');
  const [picking, setPicking] = useState(false);
  const [info, setInfo] = useState<Inspection | null>(null);
  const [inspecting, setInspecting] = useState(false);

  // 경로가 정해지면 저장소를 읽고 빈 칸을 채운다(이미 고친 값은 덮지 않는다).
  useEffect(() => {
    if (project || !originPath.trim()) {
      setInfo(null);
      return;
    }
    const id = setTimeout(() => {
      setInspecting(true);
      api<Inspection>(`inspect?path=${encodeURIComponent(originPath.trim())}`)
        .then((r) => {
          setInfo(r);
          if (!r.isGit) return;
          if (!nameTouched) setName(r.name);
          setBaseBranch(r.baseBranch);
          setVerify((v) =>
            v.length ? v : r.verify.map((x) => ({ label: x.label, evidenceType: x.evidenceType, command: joinArgs(x.argv) })),
          );
          setProtected((p) => (p.length ? p : r.protectedSuggestions));
        })
        .catch(() => setInfo(null))
        .finally(() => setInspecting(false));
    }, 350);
    return () => clearTimeout(id);
  }, [originPath]); // eslint-disable-line react-hooks/exhaustive-deps

  const body = {
    name,
    originPath,
    baseBranch,
    integrationMode: mode,
    protectedPaths,
    verifyCommands: verify
      .filter((v) => v.command.trim())
      .map((v) => ({ label: v.label.trim() || v.command.trim(), evidenceType: v.evidenceType, argv: splitArgs(v.command) })),
    docRules,
  };
  const save = () =>
    run(
      () => (project ? api(`projects/${project.id}`, { method: 'PATCH', body }) : api('projects', { body })),
      ko ? '저장했습니다.' : 'Saved.',
    ).then((ok) => ok && (reload(), onClose()));
  const suggestions = [...new Set([...(info?.protectedSuggestions ?? []), ...protectedPaths])];

  return (
    <Modal
      title={project ? project.name : ko ? '프로젝트 등록' : 'Register project'}
      onClose={onClose}
      actions={
        <button
          className="btn primary"
          disabled={busy || !name || !originPath || (!project && info !== null && !info.isGit)}
          onClick={save}
        >
          {t('save')}
        </button>
      }
    >
      <div className="form">
        {!project && (
          <label>
            {ko ? '저장소 폴더' : 'Repository folder'}
            <div className="row">
              <input
                value={originPath}
                onChange={(e) => setOriginPath(e.target.value)}
                placeholder={ko ? '폴더를 고르거나 경로를 붙여 넣으세요' : 'Choose a folder or paste a path'}
                style={{ flex: 1 }}
                autoFocus
              />
              <button type="button" className="btn" onClick={() => setPicking(true)}>
                <Icon name="folder" /> {ko ? '찾아보기' : 'Browse'}
              </button>
            </div>
            {inspecting && <span className="hint">{ko ? '저장소를 살펴보는 중…' : 'Inspecting…'}</span>}
            {info && !inspecting && (
              <span className={`hint ${info.isGit ? 'ok-text' : 'bad-text'}`}>
                {!info.exists
                  ? ko
                    ? '폴더가 없습니다.'
                    : 'Folder not found.'
                  : !info.isGit
                    ? ko
                      ? 'git 저장소의 최상위 폴더가 아닙니다. 저장소 루트를 고르세요.'
                      : 'Not the root of a git repository.'
                    : ko
                      ? `git 저장소 확인 · 브랜치 ${info.branches.length}개 · 검증 명령 ${info.verify.length}개 제안`
                      : `Git repository · ${info.branches.length} branches · ${info.verify.length} verify commands suggested`}
              </span>
            )}
          </label>
        )}
        <div className="row" style={{ alignItems: 'flex-start' }}>
          {!project && (
            <label style={{ flex: 1 }}>
              {t('name')}
              <input
                value={name}
                onChange={(e) => {
                  setNameTouched(true);
                  setName(e.target.value);
                }}
              />
            </label>
          )}
          <label style={{ flex: 1 }}>
            {ko ? '기준 브랜치' : 'Base branch'}
            {info?.branches.length ? (
              <select value={baseBranch} onChange={(e) => setBaseBranch(e.target.value)}>
                {info.branches.map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </select>
            ) : (
              <input value={baseBranch} onChange={(e) => setBaseBranch(e.target.value)} />
            )}
          </label>
        </div>
        <label>
          {ko ? '승인 후 반영 방식' : 'After approval'}
          <Segmented
            value={mode}
            onChange={(v) => setMode(v)}
            options={[
              { value: 'manual', label: ko ? '브랜치만 만들기 (병합은 내가)' : 'Create a branch (I merge)' },
              { value: 'auto_after_approval', label: ko ? '자동 병합 (fast-forward만)' : 'Auto merge (fast-forward only)' },
            ]}
          />
        </label>

        <div className="field-label">
          {ko ? '검증 명령' : 'Verify commands'}{' '}
          <span className="hint">
            {ko
              ? '직원이 제출하면 시스템이 깨끗한 사본에서 직접 실행합니다. 통과하면 고른 등급의 증거가 됩니다.'
              : 'Run by the system in a clean checkout on every submission; a pass becomes evidence of the chosen kind.'}
          </span>
        </div>
        <div className="verify-rows">
          {verify.map((v, i) => (
            <div className="verify-row" key={i}>
              <input
                value={v.label}
                placeholder={ko ? '이름' : 'Label'}
                onChange={(e) => setVerify(verify.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))}
              />
              <select
                value={v.evidenceType}
                onChange={(e) => setVerify(verify.map((x, j) => (j === i ? { ...x, evidenceType: e.target.value } : x)))}
              >
                {Object.keys(EVIDENCE.ko)
                  .filter((k) => !['mockup', 'inspection', 'human_attest'].includes(k))
                  .map((k) => (
                    <option key={k} value={k}>
                      {evidence(k)}
                    </option>
                  ))}
              </select>
              <input
                className="mono"
                value={v.command}
                placeholder="npm test"
                onChange={(e) => setVerify(verify.map((x, j) => (j === i ? { ...x, command: e.target.value } : x)))}
              />
              <button
                type="button"
                className="btn small"
                aria-label={ko ? '삭제' : 'Remove'}
                onClick={() => setVerify(verify.filter((_, j) => j !== i))}
              >
                ✕
              </button>
            </div>
          ))}
          <button
            type="button"
            className="btn small"
            style={{ justifySelf: 'start' }}
            onClick={() => setVerify([...verify, { label: '', evidenceType: 'unit_test', command: '' }])}
          >
            <Icon name="plus" size={13} /> {ko ? '검증 명령 추가' : 'Add verify command'}
          </button>
          {verify.length === 0 && (
            <div className="hint">
              {ko
                ? '검증 명령이 없으면 단위 테스트 증거가 필요한 요구사항은 승인될 수 없습니다.'
                : 'Without verify commands, requirements needing test evidence cannot pass.'}
            </div>
          )}
        </div>

        <label>
          {ko ? '보호 경로' : 'Protected paths'}{' '}
          <span className="hint">
            {ko ? '어떤 직원도 대표 승인 없이 수정할 수 없습니다.' : 'No employee may change these without your approval.'}
          </span>
          <ChipToggles
            options={suggestions.map((s) => ({ value: s, label: s }))}
            selected={protectedPaths}
            onToggle={(s) => setProtected(protectedPaths.includes(s) ? protectedPaths.filter((x) => x !== s) : [...protectedPaths, s])}
          />
          <div className="row">
            <input
              className="mono"
              value={newProtected}
              onChange={(e) => setNewProtected(e.target.value)}
              placeholder="docs/design/**"
              style={{ flex: 1 }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && newProtected.trim()) {
                  e.preventDefault();
                  setProtected([...new Set([...protectedPaths, newProtected.trim()])]);
                  setNewProtected('');
                }
              }}
            />
            <button
              type="button"
              className="btn small"
              disabled={!newProtected.trim()}
              onClick={() => {
                setProtected([...new Set([...protectedPaths, newProtected.trim()])]);
                setNewProtected('');
              }}
            >
              <Icon name="plus" size={13} /> {ko ? '추가' : 'Add'}
            </button>
          </div>
        </label>

        <details className="advanced">
          <summary>{ko ? '고급: 문서 권한 규칙' : 'Advanced: document rules'}</summary>
          <label>
            <span className="hint">{ko ? '모든 직원 작업에 주입됩니다.' : 'Injected into every task.'}</span>
            <textarea value={docRules} onChange={(e) => setDocRules(e.target.value)} />
          </label>
        </details>
      </div>
      {picking && <FolderPicker initial={originPath} onPick={setOriginPath} onClose={() => setPicking(false)} />}
    </Modal>
  );
}

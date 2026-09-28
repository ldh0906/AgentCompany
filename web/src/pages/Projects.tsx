import { useState } from 'react';
import { api, type Project } from '../api.ts';
import { useCompany } from '../App.tsx';
import { EVIDENCE, useT } from '../i18n.ts';
import { Modal, useAction } from '../components/ui.tsx';

function parseVerify(text: string) {
  // 한 줄에 하나: 이름 | 증거종류 | 명령 인자들(공백 구분, 따옴표 지원)
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [label, evidenceType, cmd] = l.split('|').map((s) => s.trim());
      const argv = (cmd ?? '').match(/"[^"]*"|'[^']*'|\S+/g)?.map((a) => a.replace(/^["']|["']$/g, '')) ?? [];
      return { label: label ?? '', evidenceType: evidenceType || 'unit_test', argv };
    });
}

function verifyToText(p: Project) {
  return p.verifyCommands.map((v) => `${v.label} | ${v.evidenceType} | ${v.argv.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}`).join('\n');
}

export function Projects() {
  const { state } = useCompany();
  const { t, lang } = useT();
  const [editing, setEditing] = useState<Project | 'new' | null>(null);
  if (!state) return <div className="emptystate">{t('loading')}</div>;
  const ko = lang === 'ko';
  return (
    <>
      <div className="page-head">
        <div>
          <h1>{t('nav_projects')}</h1>
          <div className="sub">{ko ? '원본 저장소는 대표 승인 전까지 절대 수정되지 않습니다. 직원은 격리된 미러의 작업공간에서만 일합니다.' : 'Your repo is never modified before your approval. Employees work in isolated mirror worktrees.'}</div>
        </div>
        <button className="btn primary" onClick={() => setEditing('new')}>+ {ko ? '프로젝트 등록' : 'Register project'}</button>
      </div>
      <div className="grid cols-2">
        {state.projects.map((p) => (
          <div className="card" key={p.id}>
            <div className="card-head"><span>{p.name}</span><button className="btn small" onClick={() => setEditing(p)}>{ko ? '설정' : 'Settings'}</button></div>
            <div className="body">
              <div className="sub mono">{p.originPath}</div>
              <div className="row" style={{ marginTop: 8 }}>
                <span className="chip">{p.baseBranch}</span>
                <span className={`chip ${p.integrationMode === 'auto_after_approval' ? 'warn' : 'info'}`}>{p.integrationMode === 'auto_after_approval' ? (ko ? '승인 후 자동 병합' : 'Auto merge after approval') : ko ? '브랜치만 (수동 병합)' : 'Branch only (manual merge)'}</span>
              </div>
              <div style={{ marginTop: 10 }}><b>{ko ? '검증 명령' : 'Verify commands'}</b>
                {p.verifyCommands.length === 0 ? <div className="sub">{ko ? '없음 — 단위 테스트 증거가 필요한 요구사항은 승인될 수 없습니다.' : 'None — requirements needing test evidence cannot pass.'}</div> : p.verifyCommands.map((v) => <div key={v.label} className="sub mono">{v.label}: {v.argv.join(' ')}</div>)}
              </div>
              <div style={{ marginTop: 10 }}><b>{ko ? '보호 경로' : 'Protected paths'}</b><div className="row">{p.protectedPaths.length ? p.protectedPaths.map((g) => <code key={g} className="chip">{g}</code>) : <span className="sub">—</span>}</div></div>
            </div>
          </div>
        ))}
      </div>
      {editing && <ProjectModal project={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </>
  );
}

function ProjectModal({ project, onClose }: { project: Project | null; onClose: () => void }) {
  const { reload } = useCompany();
  const { t, lang } = useT();
  const { busy, run } = useAction();
  const ko = lang === 'ko';
  const [name, setName] = useState(project?.name ?? '');
  const [originPath, setOriginPath] = useState(project?.originPath ?? '');
  const [baseBranch, setBaseBranch] = useState(project?.baseBranch ?? 'main');
  const [mode, setMode] = useState(project?.integrationMode ?? 'manual');
  const [protectedPaths, setProtected] = useState(project?.protectedPaths.join('\n') ?? '');
  const [verify, setVerify] = useState(project ? verifyToText(project) : `${ko ? '단위 테스트' : 'Unit tests'} | unit_test | npm test`);
  const [docRules, setDocRules] = useState(project?.docRules ?? '');

  const body = { name, originPath, baseBranch, integrationMode: mode, protectedPaths: protectedPaths.split('\n').map((s) => s.trim()).filter(Boolean), verifyCommands: parseVerify(verify), docRules };
  const save = () => run(() => (project ? api(`projects/${project.id}`, { method: 'PATCH', body }) : api('projects', { body })), 'OK').then((ok) => ok && (reload(), onClose()));

  return (
    <Modal title={project ? project.name : ko ? '프로젝트 등록' : 'Register project'} onClose={onClose} actions={<button className="btn primary" disabled={busy || !name || !originPath} onClick={save}>{t('save')}</button>}>
      <div className="form">
        {!project && <label>{t('name')}<input value={name} onChange={(e) => setName(e.target.value)} autoFocus /></label>}
        {!project && <label>{ko ? '원본 저장소 경로 (git)' : 'Repository path (git)'}<input value={originPath} onChange={(e) => setOriginPath(e.target.value)} placeholder="C:\\Projects\\my-game" /></label>}
        <label>{ko ? '기준 브랜치' : 'Base branch'}<input value={baseBranch} onChange={(e) => setBaseBranch(e.target.value)} /></label>
        <label>{ko ? '반영 방식' : 'Integration'}
          <select value={mode} onChange={(e) => setMode(e.target.value as Project['integrationMode'])}>
            <option value="manual">{ko ? '승인 후 브랜치만 만들기 (병합은 내가)' : 'Create branch after approval (I merge)'}</option>
            <option value="auto_after_approval">{ko ? '승인 후 자동 병합 (fast-forward만, 작업 중 파일 보호)' : 'Auto merge after approval (fast-forward only)'}</option>
          </select>
        </label>
        <label>{ko ? '검증 명령' : 'Verify commands'} <span className="hint">{ko ? '한 줄에 하나: 이름 | 증거종류 | 명령' : 'One per line: label | evidence | command'} ({Object.keys(EVIDENCE.ko).join(', ')})</span>
          <textarea className="mono" value={verify} onChange={(e) => setVerify(e.target.value)} />
        </label>
        <label>{ko ? '보호 경로 (한 줄에 하나, glob)' : 'Protected paths (glob, one per line)'}<textarea className="mono" value={protectedPaths} onChange={(e) => setProtected(e.target.value)} placeholder="README.md&#10;docs/design/README.md" /></label>
        <label>{ko ? '문서 권한 규칙 (모든 직원 작업에 주입)' : 'Document rules (injected into every task)'}<textarea value={docRules} onChange={(e) => setDocRules(e.target.value)} /></label>
      </div>
    </Modal>
  );
}

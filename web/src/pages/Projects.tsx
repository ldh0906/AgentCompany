import { useEffect, useState } from 'react';
import { api, type Project, type ProjectProfile } from '../api.ts';
import { useCompany } from '../App.tsx';
import { DELIVERABLE, EVIDENCE, profileTraits, useT } from '../i18n.ts';
import { EmptyState, Icon, Modal, useAction, Skeleton } from '../components/ui.tsx';
import { ChipToggles, FolderPicker, Segmented } from '../components/kit.tsx';
import { PreviewButton } from '../components/preview.tsx';

type Deliverable = NonNullable<ProjectProfile['deliverable']>;

/**
 * 설명으로 결과물 종류를 짐작한다(대표가 고르기 전 기본값).
 * 대표 요청(2026-10-01): 게임·웹만이 아니라 문서·조사, 화면 없는 프로그램에도 쓰고 싶다.
 */
export function guessDeliverable(text: string): Deliverable {
  if (/게임|game/i.test(text)) return 'screen';
  if (/\bapi\b|\bcli\b|서버|백엔드|스크립트|파이썬|python|명령줄|크롤링|server|backend|script/i.test(text)) return 'program';
  if (/문서|보고서|기획서|계획서|제안서|조사|리서치|원고|매뉴얼|document|report|research|proposal|article/i.test(text)) return 'document';
  return 'screen';
}

export function Projects() {
  const { state, reload } = useCompany();
  const { t, lang } = useT();
  const { busy, run } = useAction();
  const [editing, setEditing] = useState<Project | 'new' | null>(null);
  const [removing, setRemoving] = useState<Project | null>(null);
  if (!state) return <Skeleton />;
  const ko = lang === 'ko';
  return (
    <>
      <div className="page-head">
        <div>
          <h1>{t('nav_projects')}</h1>
          <div className="sub">
            {ko
              ? '내 폴더는 내가 승인하기 전까지 바뀌지 않습니다. 직원은 따로 떼어 둔 복사본에서만 일합니다.'
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
                ? '작업할 폴더만 고르면 됩니다. 빈 폴더를 새로 만들어 처음부터 시작할 수도 있습니다.'
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
              <span className="row">
                <PreviewButton projectId={p.id} />
                <button className="btn small" onClick={() => setEditing(p)}>
                  {ko ? '설정' : 'Settings'}
                </button>
                <button className="btn small danger" onClick={() => setRemoving(p)}>
                  {ko ? '삭제' : 'Remove'}
                </button>
              </span>
            </div>
            <div className="body">
              <div className="sub mono">{p.originPath}</div>
              <div className="row" style={{ marginTop: 8 }}>
                <span className="chip">{p.baseBranch}</span>
                <span className={`chip ${p.integrationMode === 'auto_after_approval' ? 'warn' : 'info'}`}>
                  {p.integrationMode === 'auto_after_approval'
                    ? ko
                      ? '승인하면 바로 반영'
                      : 'Merge on approval'
                    : ko
                      ? '따로 보관만 (직접 합침)'
                      : 'Branch only (manual merge)'}
                </span>
                {p.profile?.summary && <span className="chip">{p.profile.summary.slice(0, 40)}</span>}
                {p.profile && (p.profile.deliverable ?? 'screen') !== 'screen' && (
                  <span className="chip info">{DELIVERABLE[lang]![p.profile.deliverable!]}</span>
                )}
                {p.profile && (p.profile.deliverable ?? 'screen') === 'screen' && !p.profile.mobile && (
                  <span className="chip">{ko ? 'PC 전용' : 'Desktop only'}</span>
                )}
                {p.autoApprove && (
                  <span className="chip ok" title={ko ? '내가 직접 확인할 항목이 없는 업무는 검수 통과 시 바로 반영' : ''}>
                    {ko ? '검수 통과하면 자동 반영' : 'Auto-merge after review'}
                  </span>
                )}
              </div>
              {/* 대화에서 직원이 낸 프로필 변경 제안: 한 번에 반영하거나 버린다 */}
              {state.profileProposals?.[p.id] && (
                <div className="banner info" style={{ marginTop: 10 }}>
                  <div>
                    <b>{ko ? '프로필 변경 제안' : 'Profile proposal'}</b> ·{' '}
                    {state.employees.find((e) => e.id === state.profileProposals![p.id]!.by)?.name ?? ''}
                  </div>
                  <div>{state.profileProposals[p.id]!.profile.summary}</div>
                  <div className="sub">{profileTraits(state.profileProposals[p.id]!.profile, lang)}</div>
                  <div className="row" style={{ marginTop: 8 }}>
                    <button
                      className="btn small primary"
                      disabled={busy}
                      onClick={() =>
                        run(
                          () => api(`projects/${p.id}/profile-proposal`, { body: { accept: true } }),
                          ko ? '프로필을 바꿨습니다. 이제 모든 직원이 이 내용을 봅니다.' : 'Profile updated.',
                        ).then(reload)
                      }
                    >
                      {ko ? '반영' : 'Apply'}
                    </button>
                    <button
                      className="btn small"
                      disabled={busy}
                      onClick={() => run(() => api(`projects/${p.id}/profile-proposal`, { body: { accept: false } })).then(reload)}
                    >
                      {ko ? '무시' : 'Dismiss'}
                    </button>
                  </div>
                </div>
              )}
              <div style={{ marginTop: 10 }}>
                <b>{ko ? '자동 검사' : 'Verify commands'}</b>
                {p.verifyCommands.length === 0 ? (
                  <div className="sub">
                    {/* 문서는 검사 명령이 필요 없다: 겁주는 경고 대신 어떻게 확인하는지 알린다(실측 2026-10-02, 독서모임 기획서). */}
                    {p.profile?.deliverable === 'document'
                      ? ko
                        ? '없음 — 문서는 필요 없습니다. 검수 직원이 내용을 읽고, 출처 링크는 시스템이 열어 확인합니다.'
                        : 'None needed — reviewers read documents and the system checks source links.'
                      : ko
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
              {(() => {
                const have = new Set(p.verifyCommands.map((v) => v.argv.join(' ')));
                const sugg = (state.verifySuggest?.[p.id] ?? []).filter((v) => !have.has(v.argv.join(' ')));
                return sugg.length ? (
                  <div className="banner info" style={{ marginTop: 8 }}>
                    {ko ? '병합된 코드에 자동 검사 명령이 생겼습니다: ' : 'Verify commands found in the merged code: '}
                    {sugg.map((v) => v.argv.join(' ')).join(', ')}{' '}
                    <button
                      className="btn small primary"
                      disabled={busy}
                      onClick={() =>
                        run(
                          () =>
                            api(`projects/${p.id}`, {
                              method: 'PATCH',
                              body: {
                                verifyCommands: [
                                  ...p.verifyCommands.map(({ label, argv, evidenceType }) => ({ label, argv, evidenceType })),
                                  ...sugg,
                                ],
                              },
                            }),
                          ko ? '자동 검사를 추가했습니다.' : 'Added.',
                        ).then(reload)
                      }
                    >
                      {ko ? '모두 추가' : 'Add all'}
                    </button>
                  </div>
                ) : null;
              })()}
              <ProjectRules projectId={p.id} />
              <div style={{ marginTop: 10 }}>
                <b>{ko ? '직원이 못 고치는 파일' : 'Protected paths'}</b>
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
      {removing && (
        <Modal
          title={ko ? `${removing.name} 프로젝트를 삭제할까요?` : `Remove project ${removing.name}?`}
          onClose={() => setRemoving(null)}
          actions={
            <button
              className="btn danger"
              disabled={busy}
              onClick={() =>
                run(() => api(`projects/${removing.id}/remove`, { body: {} }), ko ? '프로젝트를 삭제했습니다.' : 'Project removed.').then(
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
              ? '목록에서 빠지고 새 업무를 받지 않습니다. 원래 폴더와 지난 업무 기록은 건드리지 않습니다. 진행 중인 업무가 있으면 먼저 끝내거나 취소해야 합니다.'
              : 'It leaves the list and takes no new tickets. Your repo and past records are untouched. Finish or cancel open tickets first.'}
          </div>
        </Modal>
      )}
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
  empty?: boolean;
}

function ProjectModal({ project, onClose }: { project: Project | null; onClose: () => void }) {
  const { reload, state } = useCompany();
  const { t, lang, evidence } = useT();
  const { busy, run } = useAction();
  const ko = lang === 'ko';
  // 찾아보기 시작 위치: 드라이브 루트 대신 이미 등록한 프로젝트가 있는 폴더.
  const known = state?.projects[0]?.originPath ?? '';
  const pickerStart = known.replace(/[\\/][^\\/]+[\\/]?$/, '');
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
  // 새 프로젝트는 켬: 대표가 볼 것 없는 업무까지 승인을 기다리지 않게(실측: 타이머 계산 업무 승인을 다음 업무가 기다렸다).
  const [autoApprove, setAutoApprove] = useState(project ? (project.autoApprove ?? false) : true);
  const [profileSummary, setProfileSummary] = useState(project?.profile?.summary ?? '');
  const [profileMobile, setProfileMobile] = useState(project?.profile?.mobile ?? true);
  const [mobileTouched, setMobileTouched] = useState(Boolean(project?.profile));
  const [profileGame, setProfileGame] = useState(project?.profile?.game ?? false);
  const [deliverable, setDeliverable] = useState<Deliverable>(project?.profile?.deliverable ?? 'screen');
  const [deliverableTouched, setDeliverableTouched] = useState(Boolean(project?.profile));
  const screen = deliverable === 'screen';
  const [qaAutoReject, setQaAutoReject] = useState(project?.qaAutoReject ?? true);
  const [autoPlaytest, setAutoPlaytest] = useState(project?.autoPlaytest ?? false);
  const [acceptanceTests, setAcceptanceTests] = useState(project?.acceptanceTests ?? true);
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
          // git이 아닌 폴더(새로 만든 폴더 포함)는 개발자가 직접 합칠 브랜치도 없다: 추천대로 바로 반영.
          // 실측(첫 사용): "여기에 새로 만들기"로 만든 폴더인데 "따로 보관만"이 기본으로 골라져 있었다.
          if (!r.isGit && !project) setMode('auto_after_approval');
          if (!r.isGit) return;
          if (!nameTouched) setName(r.name);
          setBaseBranch(r.baseBranch);
          setVerify((v) =>
            v.length ? v : r.verify.map((x) => ({ label: x.label, evidenceType: x.evidenceType, command: joinArgs(x.argv) })),
          );
          setProtected((p) => (p.length ? p : r.protectedSuggestions));
          // 처음부터 만드는 프로젝트: 뒤 업무가 앞 업무 결과를 이어받아야 하므로 자동 병합이 기본.
          if (r.empty && !project) setMode('auto_after_approval');
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
    autoApprove,
    qaAutoReject,
    autoPlaytest: screen && profileGame && autoPlaytest,
    acceptanceTests,
    ...(profileSummary.trim() || project?.profile || !screen
      ? { profile: { summary: profileSummary.trim(), mobile: screen && profileMobile, game: screen && profileGame, deliverable } }
      : {}),
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
            {ko ? '프로젝트 폴더' : 'Repository folder'}
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
            {inspecting && <span className="hint">{ko ? '폴더를 살펴보는 중…' : 'Inspecting…'}</span>}
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
                      ? `확인했습니다 · 브랜치 ${info.branches.length}개 · 자동 검사 ${info.verify.length}개 찾음`
                      : `Git repository · ${info.branches.length} branches · ${info.verify.length} verify commands suggested`}
              </span>
            )}
            {info?.empty && !project && (
              <span className="hint">
                {ko
                  ? '빈 폴더입니다. 그대로 저장하면 됩니다: 자동 검사는 첫 업무 초안을 확정할 때 함께 정해지고, 승인한 결과는 이 폴더에 바로 반영됩니다.'
                  : 'Empty repository. You can leave verify commands empty: confirming a draft adds the suggested commands, and tests added later are picked up automatically. Merge mode is set to auto so later tickets build on earlier ones.'}
              </span>
            )}
          </label>
        )}
        {!project && (
          <label>
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
        {/* 프로젝트 성격: 모든 직원 지시에 들어가고 앱 동작에도 쓰인다(대표 요청: PC 게임이면 휴대폰을 신경 쓰지 않게). */}
        <label>
          {ko ? '어떤 프로젝트인가요?' : 'What is this project?'}
          <textarea
            value={profileSummary}
            onChange={(e) => {
              setProfileSummary(e.target.value);
              // 설명에 PC만 나오면 휴대폰 점검을 끈다(대표가 직접 고른 뒤에는 건드리지 않음).
              // 실측: "회사 pc에 켜두고"라고 썼는데 휴대폰 점검이 기본으로 켜져 있어 휴대폰 확인 일이 붙었다.
              if (!mobileTouched) {
                const v = e.target.value;
                const pc = /pc|데스크톱|데스크탑|컴퓨터|desktop/i.test(v);
                const phone = /폰|모바일|휴대|스마트폰|mobile|phone|태블릿/i.test(v);
                if (pc && !phone) setProfileMobile(false);
                else if (phone) setProfileMobile(true);
              }
              // 설명으로 결과물 종류를 짐작한다(대표가 직접 고른 뒤에는 건드리지 않음).
              if (!deliverableTouched) setDeliverable(guessDeliverable(e.target.value));
            }}
            placeholder={
              ko
                ? '예: PC용 픽셀 RPG(메이플 느낌) / 카페 창업 사업계획서 / 가계부 CSV를 정리하는 파이썬 도구'
                : 'e.g. PC pixel RPG / business plan for a cafe / Python tool that tidies a budget CSV'
            }
            rows={2}
          />
          <span className="hint">
            {ko
              ? '모든 직원이 이 내용을 기억합니다. 비워 두면 비서실장이 첫 초안 때 제안합니다.'
              : 'Every employee keeps this in mind. Leave empty and the chief of staff suggests one.'}
          </span>
        </label>
        <label>
          {ko ? '결과물은 무엇인가요?' : 'What does it produce?'}
          <Segmented<Deliverable>
            value={deliverable}
            onChange={(v) => (setDeliverable(v), setDeliverableTouched(true))}
            options={(['screen', 'document', 'program'] as const).map((k) => ({ value: k, label: DELIVERABLE[lang]![k]! }))}
          />
          <span className="hint">
            {deliverable === 'document'
              ? ko
                ? '직원이 문서(.md)로 써서 냅니다. 승인할 때 앱 안에서 바로 읽고, 조사 결과의 출처 링크는 앱이 하나씩 열어 확인합니다.'
                : 'Employees write Markdown documents; you read them in the app. Research links are checked by the app.'
              : deliverable === 'program'
                ? ko
                  ? '화면이 없는 프로그램입니다. 승인할 때 확인용 실행 결과(요청과 응답, 입력과 결과)를 앱 안에서 읽습니다.'
                  : 'No screen: at approval you read the output of demo commands the app runs.'
                : ko
                  ? '웹 페이지·앱·게임. 승인할 때 화면 점검 사진을 보고 "실행해 보기"로 직접 확인합니다.'
                  : 'Web pages, apps and games: screen check pictures and "Run it".'}
          </span>
        </label>
        {screen && (
          <label className="check-row">
            <input type="checkbox" checked={profileMobile} onChange={(e) => (setProfileMobile(e.target.checked), setMobileTouched(true))} />
            <span>{ko ? '휴대폰 화면도 신경 쓰기 (끄면 휴대폰 폭 점검·경고를 하지 않음)' : 'Also care about phone screens'}</span>
          </label>
        )}
        {screen && (
          <label className="check-row">
            <input type="checkbox" checked={profileGame} onChange={(e) => setProfileGame(e.target.checked)} />
            <span>{ko ? '게임입니다 (손맛·플레이감도 봄)' : 'This is a game'}</span>
          </label>
        )}
        {screen && profileGame && (
          <label className="check-row">
            <input type="checkbox" checked={autoPlaytest} onChange={(e) => setAutoPlaytest(e.target.checked)} />
            <span>
              {ko ? '요청 하나가 모두 끝나면 고급 QA가 직접 플레이해 보기' : 'Play-test automatically when a request is done'}{' '}
              <span className="hint">{ko ? '— 한 번에 약 300만~700만 토큰(실측 637만, 약 $2.4)' : '— about 3-7M tokens each'}</span>
            </span>
          </label>
        )}
        <label className="check-row">
          <input type="checkbox" checked={acceptanceTests} onChange={(e) => setAcceptanceTests(e.target.checked)} />
          <span>
            {ko
              ? '요청이 모두 끝나면 인수 시험으로 결과 전체를 다시 확인 (떨어지면 고칠 업무를 만듦)'
              : 'Acceptance-test the whole result when a request is done'}{' '}
            <span className="hint">{ko ? '— 한 번에 약 30만 토큰(실측 32만)' : '— about 300K tokens each'}</span>
          </span>
        </label>
        {/* 문서는 QA가 따로 보지 않는다(검수자가 읽고, 대표는 결과물 보기로 읽는다). */}
        {deliverable !== 'document' && (
          <label className="check-row">
            <input type="checkbox" checked={qaAutoReject} onChange={(e) => setQaAutoReject(e.target.checked)} />
            <span>
              {ko
                ? `QA가 ${screen ? '화면' : '실행 결과'}에서 문제를 찾으면 나를 거치지 않고 담당자에게 바로 돌려보내기`
                : 'Send back automatically when QA finds a problem'}{' '}
              <span className="hint">{ko ? '— 업무당 최대 2번, 그다음은 나에게' : '— at most twice per ticket'}</span>
            </span>
          </label>
        )}
        {/* 비개발자용: 핵심 두 가지만 위에 두고, 개발 용어는 "고급 설정"에 접는다(실측: 기준 브랜치·보호 경로·검증 명령이 뭔지 몰라 멈칫). */}
        <label>
          {ko ? '승인한 결과를 어떻게 넣을까요?' : 'After approval'}
          <Segmented
            value={mode}
            onChange={(v) => setMode(v)}
            options={[
              { value: 'auto_after_approval', label: ko ? '내 폴더에 바로 반영 (추천)' : 'Merge into my folder (recommended)' },
              { value: 'manual', label: ko ? '따로 보관만 (내가 직접 합침)' : 'Keep on a branch (I merge)' },
            ]}
          />
          <span className="hint">
            {mode === 'auto_after_approval'
              ? ko
                ? `승인하면 이 폴더의 ${baseBranch}에 바로 들어가고, 다음 업무가 그 결과를 이어받습니다.`
                : `Approved work lands on ${baseBranch} and the next tickets build on it.`
              : ko
                ? '승인하면 별도 브랜치로만 남습니다. git으로 직접 합치는 개발자에게 맞습니다.'
                : 'Approved work stays on a separate branch for you to merge with git.'}
          </span>
        </label>
        <label className="check-row">
          <input type="checkbox" checked={autoApprove} onChange={(e) => setAutoApprove(e.target.checked)} />
          <span>
            {ko ? '검수를 통과하면 내 승인 없이 반영' : 'Merge automatically when review passes'}{' '}
            <span className="hint">
              {ko
                ? '— 내가 직접 보고 확인해야 하는 항목이 있는 업무는 제외하고 늘 나에게 묻습니다. 뒤 업무가 앞 업무 승인을 기다리지 않습니다.'
                : '— tickets with items you must check yourself still wait for you.'}
            </span>
          </span>
        </label>

        <details className="advanced">
          <summary>
            {ko
              ? `고급 설정 (개발자용) — 기준 브랜치 ${baseBranch} · 자동 검사 ${verify.filter((v) => v.command.trim()).length}개 · 못 고치는 파일 ${protectedPaths.length}개`
              : `Advanced — base ${baseBranch} · ${verify.filter((v) => v.command.trim()).length} verify · ${protectedPaths.length} protected`}
          </summary>
          <div className="form" style={{ marginTop: 8 }}>
            <label>
              {ko ? '기준 브랜치 (보통 main)' : 'Base branch'}
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
            <div className="field-label">
              {ko ? '자동 검사 명령' : 'Verify commands'}{' '}
              <span className="hint">
                {ko
                  ? '직원이 제출하면 시스템이 깨끗한 사본에서 직접 실행합니다(예: npm test). 비워 두면 초안 확정·병합 때 자동으로 채웁니다.'
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
                <Icon name="plus" size={13} /> {ko ? '명령 추가' : 'Add verify command'}
              </button>
              {verify.length === 0 && (
                <div className="hint">
                  {ko
                    ? '비어 있어도 됩니다. 업무 초안을 확정할 때 비서실장이 제안한 명령이 함께 추가됩니다.'
                    : 'Without verify commands, requirements needing test evidence cannot pass.'}
                </div>
              )}
            </div>

            <label>
              {ko ? '직원이 못 고치는 파일' : 'Protected paths'}{' '}
              <span className="hint">
                {ko
                  ? '어떤 직원도 대표 승인 없이 수정할 수 없습니다(예: docs/design/**).'
                  : 'No employee may change these without your approval.'}
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

            <label>
              {ko ? '문서 권한 규칙' : 'Document rules'}
              <span className="hint">{ko ? '모든 직원 작업에 주입됩니다.' : 'Injected into every task.'}</span>
              <textarea value={docRules} onChange={(e) => setDocRules(e.target.value)} />
            </label>
          </div>
        </details>
      </div>
      {picking && <FolderPicker initial={originPath || pickerStart} onPick={setOriginPath} onClose={() => setPicking(false)} />}
    </Modal>
  );
}

/**
 * 정해 둔 규칙(현재 결정): 대표가 질문에 답하거나 대화에서 정한 것이 자동으로 쌓이고 모든 직원이 따른다.
 * 따로 관리할 일이 드물어 메뉴에서 빼고 여기 접어 둔다(대표 의견, 2026-09-30). 틀린 규칙만 거두면 된다.
 */
function ProjectRules({ projectId }: { projectId: string }) {
  const { state, reload } = useCompany();
  const { lang } = useT();
  const ko = lang === 'ko';
  const { busy, run } = useAction();
  const [text, setText] = useState('');
  const rules = (state?.decisions ?? []).filter((d) => d.projectId === projectId && d.status === 'current');
  return (
    <details className="advanced" style={{ marginTop: 10 }}>
      <summary>
        <b>{ko ? `정해 둔 규칙 ${rules.length}개` : `${rules.length} agreed rules`}</b>{' '}
        <span className="sub">
          {ko ? '— 질문에 답한 내용이 자동으로 쌓이고, 모든 직원이 따릅니다' : '— your answers, followed by every employee'}
        </span>
      </summary>
      <div className="list" style={{ marginTop: 6 }}>
        {rules.map((d) => (
          <div className="item spread" key={d.id} style={{ gap: 8 }}>
            <div style={{ fontSize: 13, whiteSpace: 'pre-wrap' }}>{d.text}</div>
            <button
              className="btn small"
              disabled={busy}
              title={ko ? '더 이상 따르지 않게 합니다(기록은 남음)' : 'Stop applying it (kept in history)'}
              style={{ flexShrink: 0, whiteSpace: 'nowrap' }}
              onClick={() =>
                run(
                  () => api(`decisions/${d.id}/status`, { body: { status: 'withdrawn' } }),
                  ko ? '규칙을 거뒀습니다.' : 'Withdrawn.',
                ).then(reload)
              }
            >
              {ko ? '거두기' : 'Withdraw'}
            </button>
          </div>
        ))}
      </div>
      <div className="row" style={{ marginTop: 6 }}>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={ko ? '새 규칙 (예: 파티 최대 인원은 4명)' : 'New rule'}
          style={{ flex: 1 }}
        />
        <button
          className="btn small"
          disabled={busy || !text.trim()}
          onClick={() =>
            run(() => api('decisions', { body: { projectId, text } }), ko ? '규칙을 추가했습니다.' : 'Added.').then(
              (ok) => ok && (setText(''), reload()),
            )
          }
        >
          {ko ? '추가' : 'Add'}
        </button>
      </div>
    </details>
  );
}

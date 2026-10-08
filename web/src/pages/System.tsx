import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import { useCompany } from '../App.tsx';
import { useT } from '../i18n.ts';
import { Modal, useToast } from '../components/ui.tsx';

interface Doctor {
  node: string;
  git: string | null;
  platform: string;
  clis: {
    kind: string;
    displayName: string;
    found: boolean;
    path: string | null;
    version: string | null;
    login: string;
    loginDetail: string;
    loginHelp: string;
    missingFlags?: string[];
  }[];
  checkedAt: string;
}

interface Install {
  dataDir: string;
  database: string;
  runsDir: string;
  projectsDir: string;
  profilesDir: string;
  mirrors: string[];
  sizeBytes: number;
  services: string;
  network: string;
  credentials: string;
}

export function System() {
  const { state } = useCompany();
  const { t, lang } = useT();
  const [doc, setDoc] = useState<Doctor | null>(null);
  const [inst, setInst] = useState<Install | null>(null);
  const [checking, setChecking] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [stopped, setStopped] = useState(false);
  const toast = useToast();
  const ko = lang === 'ko';
  const check = (refresh = false) => {
    setChecking(true);
    api<Doctor>(`doctor${refresh ? '?refresh=1' : ''}`)
      .then(setDoc)
      .finally(() => setChecking(false));
  };
  useEffect(() => {
    check();
    api<Install>('install').then(setInst);
  }, []);
  const recovered = state?.events.filter((e) => e.type === 'orchestrator.recovered').at(-1);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{t('nav_system')}</h1>
          <div className="sub">
            {ko
              ? '무엇이 어디에 설치되고 무엇이 실행 중인지 숨기지 않습니다.'
              : 'Nothing hidden: what is installed, where, and what is running.'}
          </div>
        </div>
        <div className="row">
          <button className="btn" disabled={checking} onClick={() => check(true)}>
            {checking ? t('loading') : ko ? '다시 점검' : 'Re-check'}
          </button>
          <button className="btn danger" onClick={() => setStopping(true)}>
            {ko ? 'Agent Company 종료' : 'Quit Agent Company'}
          </button>
        </div>
      </div>
      {stopping && (
        <Modal
          title={ko ? 'Agent Company를 종료할까요?' : 'Quit Agent Company?'}
          onClose={() => setStopping(false)}
          actions={
            <button
              className="btn danger"
              onClick={() =>
                api('shutdown', { body: {} })
                  .then(() => setStopped(true))
                  .catch((e) => toast(String((e as Error).message), true))
                  .finally(() => setStopping(false))
              }
            >
              {ko ? '종료' : 'Quit'}
            </button>
          }
        >
          {ko
            ? '서버를 끕니다. 진행 중인 직원 작업은 계속되고, 다음에 켜면 이어받습니다. 다시 켜려면 바탕화면의 Agent Company 아이콘을 누르세요.'
            : 'Stops the server. Running employee work continues and is picked up on next start. Use the desktop icon to start again.'}
        </Modal>
      )}
      {stopped && <div className="banner info">{ko ? '종료했습니다. 이 창을 닫아도 됩니다.' : 'Stopped. You can close this window.'}</div>}

      {recovered && (
        <div className={`banner ${(recovered.payload as { chainOk: boolean }).chainOk ? 'info' : 'bad'}`}>
          {ko ? '감사 로그' : 'Audit log'}: {(recovered.payload as { chainDetail: string }).chainDetail}
        </div>
      )}
      {/* 마지막 재시작 복구: 실행마다 무엇을 근거로 어떻게 처리했는지, 끊긴 반영·도구 요청 */}
      {(state?.recovery?.runs?.length || state?.recovery?.integrations?.length || state?.recovery?.toolCalls) && (
        <div className="card" style={{ marginBottom: 16 }}>
          <h2>
            {ko ? '마지막 재시작 복구' : 'Last restart recovery'}
            {state.recovery!.at && <span className="sub"> · {new Date(state.recovery!.at).toLocaleString()}</span>}
          </h2>
          <div className="list">
            {(state.recovery!.runs ?? []).map((r) => (
              <div className="item" key={r.runId}>
                <div className="spread">
                  <span className="title">
                    {r.ticketId} · {state.employees.find((e) => e.id === r.employeeId)?.name ?? r.employeeId}
                  </span>
                  <span className={`chip ${r.action === 'reattached' ? 'ok' : r.action === 'not_started' ? 'bad' : ''}`}>
                    {r.action === 'reattached'
                      ? ko
                        ? '이어받음'
                        : 'Reattached'
                      : r.action === 'collected'
                        ? ko
                          ? `결과 수거 → ${r.status}`
                          : `Collected → ${r.status}`
                        : ko
                          ? '시작 못 함'
                          : 'Not started'}
                  </span>
                </div>
                <div className="meta">{r.reason}</div>
              </div>
            ))}
            {(state.recovery!.integrations ?? []).map((x) => (
              <div className="item" key={x.requestId}>
                <div className="spread">
                  <span className="title">{x.requestId}</span>
                  <span className={`chip ${x.action === 'resume' ? 'warn' : ''}`}>
                    {x.action === 'resume' ? (ko ? '반영 이어서 진행' : 'Resuming merge') : ko ? '승인 없어 버림' : 'Dropped'}
                  </span>
                </div>
              </div>
            ))}
            {!!state.recovery!.toolCalls && (
              <div className="item">
                {ko
                  ? `처리하다 끊긴 직원 도구 요청 ${state.recovery!.toolCalls}건: 실제로 일어난 일을 확인해 이어갑니다`
                  : `${state.recovery!.toolCalls} interrupted tool requests: resumed from what actually happened`}
              </div>
            )}
          </div>
        </div>
      )}

      <div className="grid cols-2">
        <div className="card">
          <h2>{ko ? '직원 AI 점검' : 'Employee CLIs'}</h2>
          <div className="list">
            {!doc ? (
              <div className="emptystate">{t('loading')}</div>
            ) : (
              doc.clis.map((c) => (
                <div className="item" key={c.kind}>
                  <div className="spread">
                    <div className="title">{c.displayName}</div>
                    {!c.found ? (
                      <span className="chip bad">{ko ? '미설치' : 'Not installed'}</span>
                    ) : c.login === 'ok' ? (
                      <span className="chip ok">{ko ? '준비됨' : 'Ready'}</span>
                    ) : c.login === 'missing' ? (
                      <span className="chip warn">{ko ? '로그인 필요' : 'Login needed'}</span>
                    ) : (
                      <span className="chip">{ko ? '첫 실행 때 확인' : 'Checked on first run'}</span>
                    )}
                  </div>
                  <div className="meta mono">
                    {c.version} {c.path}
                  </div>
                  {/* 업데이트로 우리가 쓰는 옵션이 없어졌으면: 이 CLI 직원의 실행은 띄우기 전에 멈춘다 */}
                  {!!c.missingFlags?.length && (
                    <div className="banner bad" style={{ marginTop: 8 }}>
                      {ko
                        ? `이 버전의 도움말에 Agent Company가 쓰는 ${c.missingFlags.join(', ')}이(가) 없습니다. 이 CLI 직원의 실행은 시작하기 전에 멈춥니다.`
                        : `This version's help does not list ${c.missingFlags.join(', ')}, which Agent Company uses. Runs on this CLI stop before starting.`}
                    </div>
                  )}
                  {c.found && c.login !== 'ok' && (
                    <>
                      <button
                        className="btn small"
                        style={{ marginTop: 8 }}
                        onClick={() =>
                          api('cli-login', { body: { cli: c.kind } })
                            .then(() =>
                              toast(
                                ko
                                  ? '로그인 창을 열었습니다. 로그인한 뒤 "다시 점검"을 누르세요.'
                                  : 'Login window opened. Re-check when done.',
                              ),
                            )
                            .catch((e) => toast(String((e as Error).message), true))
                        }
                      >
                        {ko ? '로그인 창 열기' : 'Open login window'}
                      </button>
                      <details className="advanced">
                        <summary>{ko ? '직접 입력하려면' : 'Do it manually'}</summary>
                        <div className="note mono">{c.loginHelp}</div>
                      </details>
                    </>
                  )}
                </div>
              ))
            )}
          </div>
          {doc && (
            <div className="body sub">
              Node {doc.node} · {doc.git} · {doc.platform}
            </div>
          )}
        </div>

        <div className="card">
          <h2>{ko ? '설치 정보' : 'Install info'}</h2>
          {!inst ? (
            <div className="emptystate">{t('loading')}</div>
          ) : (
            <table>
              <tbody>
                <tr>
                  <th>{ko ? '데이터 폴더' : 'Data dir'}</th>
                  <td className="mono">{inst.dataDir}</td>
                </tr>
                <tr>
                  <th>{ko ? '용량' : 'Size'}</th>
                  <td>{(inst.sizeBytes / 1024 / 1024).toFixed(1)} MB</td>
                </tr>
                <tr>
                  <th>DB</th>
                  <td className="mono">{inst.database}</td>
                </tr>
                <tr>
                  <th>{ko ? '미러 저장소' : 'Mirrors'}</th>
                  <td className="mono">{inst.mirrors.join('\n') || '—'}</td>
                </tr>
                <tr>
                  <th>{ko ? '앱 전용 CLI 프로필' : 'App CLI profiles'}</th>
                  <td className="mono">{inst.profilesDir}</td>
                </tr>
                <tr>
                  <th>{ko ? '서비스·자동 실행' : 'Services'}</th>
                  <td>{inst.services}</td>
                </tr>
                <tr>
                  <th>{ko ? '네트워크' : 'Network'}</th>
                  <td>{inst.network}</td>
                </tr>
                <tr>
                  <th>{ko ? '자격증명' : 'Credentials'}</th>
                  <td>{inst.credentials}</td>
                </tr>
                <tr>
                  <th>{ko ? '제거' : 'Uninstall'}</th>
                  <td className="mono">agent-company uninstall</td>
                </tr>
              </tbody>
            </table>
          )}
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h2>{ko ? '최근 실행' : 'Recent runs'}</h2>
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>{ko ? '업무' : 'Ticket'}</th>
              <th>CLI</th>
              <th>{ko ? '상태' : 'Status'}</th>
              <th>{ko ? '실패 원인' : 'Failure'}</th>
            </tr>
          </thead>
          <tbody>
            {state?.runs.map((r) => (
              <tr key={r.id}>
                <td className="mono">{r.id}</td>
                <td>
                  {/* 대화방 실행(g:…, t:…)은 방 이름으로(실측 2026-10-02: "g:2fe72ca8 · chat"으로는 어떤 토론인지 몰랐다) */}
                  {r.ticketId.startsWith('t:')
                    ? `${r.ticketId.slice(2)} ${ko ? '업무방' : 'room'}`
                    : r.ticketId.includes(':') || r.ticketId === 'general'
                      ? (state.channels?.find((c) => c.id === r.ticketId)?.name ?? (ko ? '대화방' : 'chat'))
                      : r.ticketId}{' '}
                  · {r.kind}
                </td>
                <td>{r.cli}</td>
                <td>{r.status}</td>
                <td className="sub">
                  {r.failureClass} {r.reportError?.slice(0, 160)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

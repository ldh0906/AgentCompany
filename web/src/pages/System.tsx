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

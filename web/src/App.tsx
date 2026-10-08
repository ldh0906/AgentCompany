import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { api, ApiError, getToken, subscribe, type State } from './api.ts';
import { LangContext, useT, type Lang } from './i18n.ts';
import { empName, Icon, needsCeo, ToastProvider } from './components/ui.tsx';
import { Dashboard } from './pages/Dashboard.tsx';
import { Board } from './pages/Board.tsx';
import { TicketPage } from './pages/TicketPage.tsx';
import { Org } from './pages/Org.tsx';
import { Projects } from './pages/Projects.tsx';
import { System } from './pages/System.tsx';
import { NewTicket } from './pages/NewTicket.tsx';
import { ChatPage } from './pages/Chat.tsx';
import { Live } from './pages/Live.tsx';
import { Inbox } from './pages/Inbox.tsx';
import { isUnread, unreadMentions } from './components/unread.ts';
import { saveTheme, savedTheme, type Theme } from './theme.ts';

// ---- 라우팅(경로 기반, 의존성 없음) ----
const RouteContext = createContext<{ path: string; go: (p: string) => void }>({ path: '/', go: () => {} });
export const useRoute = () => useContext(RouteContext);

export function Link({ to, children, className }: { to: string; children: React.ReactNode; className?: string }) {
  const { go, path } = useRoute();
  const active = to === '/' ? path === '/' : path.startsWith(to);
  return (
    <a
      href={to}
      className={`${className ?? ''} ${active ? 'active' : ''}`}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey) return;
        e.preventDefault();
        go(to);
      }}
    >
      {children}
    </a>
  );
}

// ---- 회사 상태(SSE로 실시간 갱신) ----
const StateContext = createContext<{ state: State | null; reload: () => void; live: boolean }>({
  state: null,
  reload: () => {},
  live: false,
});
export const useCompany = () => useContext(StateContext);

function useCompanyState() {
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [live, setLive] = useState(false);
  const timer = useRef<number | null>(null);
  // 상태 응답은 수백 KB다(실측 2026-10-02: 400~570KB). 직원이 일하는 동안 변화가 이어지면 0.2초마다 다시 받았고,
  // 재연결 직후에는 24번이 몰렸다. 받는 중이면 끝난 뒤 한 번만, 그리고 1초에 한 번까지만 받는다(마지막 변화는 꼭 반영).
  const inflight = useRef(false);
  const again = useRef(false);
  const last = useRef(0);
  const reload = useCallback(() => {
    if (inflight.current) {
      again.current = true;
      return;
    }
    inflight.current = true;
    last.current = Date.now();
    api<State>('state')
      .then((s) => {
        setState(s);
        setError(null);
        setLive(true);
      })
      .catch((e: ApiError) => {
        setError(e);
        setLive(false);
      })
      .finally(() => {
        inflight.current = false;
        if (again.current) {
          again.current = false;
          schedule();
        }
      });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const schedule = () => {
    if (timer.current) return; // 이미 예약됨: 그때 최신 상태를 받는다
    const wait = Math.max(150, 1000 - (Date.now() - last.current));
    timer.current = window.setTimeout(() => {
      timer.current = null;
      reload();
    }, wait);
  };
  useEffect(() => {
    reload();
    const unsub = subscribe(schedule);
    const poll = window.setInterval(reload, 15_000);
    return () => {
      unsub();
      window.clearInterval(poll);
    };
  }, [reload]);
  return { state, error, reload, live };
}

function Shell() {
  const { t } = useT();
  const { lang, setLang } = useContext(LangContext);
  const { path } = useRoute();
  const { state, live, reload } = useCompany();
  const [newTicket, setNewTicket] = useState(false);
  const pending = state?.approvals.length ?? 0;
  const held = state?.tickets.filter(needsCeo).length ?? 0;
  const chatUnread = (state?.channels ?? []).filter((c) => c.kind !== 'ticket' && isUnread(c)).length;
  const chatMentions = unreadMentions(state?.mentions).length;
  const runningNow = (state?.runs ?? []).filter((r) => r.status === 'running').length;

  // 승인 알림: 탭 제목에 건수, 켜 두면 새 승인 요청마다 데스크톱 알림.
  const [theme, setTheme] = useState<Theme>(savedTheme);
  const [notify, setNotify] = useState(() => {
    try {
      return localStorage.getItem('ac-notify') === '1' && 'Notification' in window && Notification.permission === 'granted';
    } catch {
      return false;
    }
  });
  const seen = useRef<Set<string> | null>(null);
  const seenMentions = useRef<Set<string> | null>(null);
  const seenNotices = useRef<Set<string> | null>(null);
  const todos = state?.ceoTodos ?? [];
  useEffect(() => {
    document.title = pending + held > 0 ? `(${pending + held}) Agent Company` : 'Agent Company';
    if (!state) return;
    // 새 "대표 할 일"(승인·결정·초안 확인 등)과 새 알림(QA 자동 반려·요청 완료)을 알린다.
    const fresh = (state.ceoTodos ?? []).filter((x) => !seen.current?.has(x.key));
    const first = seen.current === null;
    seen.current = new Set((state.ceoTodos ?? []).map((x) => x.key));
    const freshNotices = (state.notices ?? []).filter((n) => !seenNotices.current?.has(n.id));
    const firstNotices = seenNotices.current === null;
    seenNotices.current = new Set((state.notices ?? []).map((n) => n.id));
    if (notify && !firstNotices) for (const n of freshNotices.slice(-3)) new Notification(n.title, { body: n.body, tag: n.id });
    // 직원이 대표를 부른 메시지도 알린다.
    const freshMentions = (state.mentions ?? []).filter((m) => !seenMentions.current?.has(m.id));
    const firstMentions = seenMentions.current === null;
    seenMentions.current = new Set((state.mentions ?? []).map((m) => m.id));
    if (notify && !firstMentions)
      for (const m of freshMentions.slice(0, 3))
        new Notification(
          lang === 'ko' ? `${state.employees.find((e) => e.id === m.author)?.name ?? ''}이(가) 대표를 불렀습니다` : 'You were mentioned',
          {
            body: m.text.slice(0, 140),
            tag: m.id,
          },
        );
    if (first || !notify || !fresh.length) return;
    for (const x of fresh.slice(0, 3)) new Notification(lang === 'ko' ? '대표가 할 일' : 'Needs you', { body: x.title, tag: x.key });
  }, [state, pending, held, notify, lang]);
  const toggleNotify = async () => {
    if (notify) {
      setNotify(false);
      try {
        localStorage.setItem('ac-notify', '0');
      } catch {}
      return;
    }
    if (!('Notification' in window)) return;
    const ok = (await Notification.requestPermission()) === 'granted';
    setNotify(ok);
    try {
      localStorage.setItem('ac-notify', ok ? '1' : '0');
    } catch {}
  };

  let page: React.ReactNode;
  if (path.startsWith('/tickets/')) page = <TicketPage id={decodeURIComponent(path.slice('/tickets/'.length))} />;
  else if (path.startsWith('/board')) page = <Board onNewTicket={() => setNewTicket(true)} />;
  else if (path.startsWith('/chat'))
    page = <ChatPage channelId={path.length > 6 ? decodeURIComponent(path.slice('/chat/'.length)) : null} />;
  else if (path.startsWith('/live')) page = <Live runId={path.length > 6 ? decodeURIComponent(path.slice('/live/'.length)) : null} />;
  else if (path.startsWith('/org')) page = <Org />;
  else if (path.startsWith('/projects')) page = <Projects />;
  else if (path.startsWith('/decisions'))
    page = <Projects />; // 옛 결정 기록 주소: 규칙은 프로젝트 화면에 있다
  else if (path.startsWith('/system')) page = <System />;
  else if (path.startsWith('/inbox')) page = <Inbox />;
  else page = <Dashboard onNewTicket={() => setNewTicket(true)} />;

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand">
          <img src="/favicon.svg" alt="" />
          <div>
            {t('appName')}
            <small>{lang === 'ko' ? 'AI 개발팀 관제실' : 'AI dev team control room'}</small>
          </div>
        </div>
        <div className="nav-label">{lang === 'ko' ? '운영' : 'Operate'}</div>
        <nav className="nav">
          {/* 할 일: 대표 차례인 일만 모은 곳(맨 위). 대표 요청(2026-10-03): 할 일 화면이 읽기 불친절했다. */}
          <Link to="/inbox">
            <Icon name="inbox" /> {lang === 'ko' ? '할 일' : 'Inbox'}{' '}
            {todos.length > 0 && <span className="count bad">{todos.length}</span>}
          </Link>
          <Link to="/">
            <Icon name="dashboard" /> {t('nav_dashboard')}
          </Link>
          <Link to="/board">
            <Icon name="board" /> {t('nav_board')}
          </Link>
          <Link to="/chat">
            <Icon name="chat" /> {lang === 'ko' ? '대화' : 'Chat'}
            {chatMentions > 0 ? (
              <span className="count bad">@{chatMentions}</span>
            ) : chatUnread > 0 ? (
              <span className="count">{chatUnread}</span>
            ) : null}
          </Link>
          <Link to="/live">
            <Icon name="activity" /> {lang === 'ko' ? '작업 현황' : 'Live work'}
            {runningNow > 0 && <span className="count info">{runningNow}</span>}
          </Link>
        </nav>
        <div className="nav-label">{lang === 'ko' ? '회사' : 'Company'}</div>
        <nav className="nav">
          <Link to="/org">
            <Icon name="team" /> {t('nav_org')}
          </Link>
          <Link to="/projects">
            <Icon name="folder" /> {t('nav_projects')}
          </Link>
          <Link to="/system">
            <Icon name="cpu" /> {t('nav_system')}
          </Link>
        </nav>
        <div className="spacer" />
        {/* 전권 위임: 대표 할 일을 최고 직급 직원이 대신 처리한다(대표 요청 2026-10-02). */}
        <button
          className={`btn ${state?.delegation?.on ? 'ok' : ''}`}
          style={{ marginBottom: 8 }}
          title={
            lang === 'ko'
              ? state?.delegation?.on
                ? '다시 대표가 직접 확정·승인합니다.'
                : '초안 확정·직원 질문·예산·범위·반영 승인을 최고 직급 직원이 대신 결정합니다. 결정은 모두 기록으로 남습니다.'
              : state?.delegation?.on
                ? 'Take decisions back.'
                : 'Let the most senior employee make every CEO decision. All decisions are logged.'
          }
          onClick={() => {
            // 켜는 순간 기다리던 결정(승인·초안·토론)이 바로 처리된다: 몇 개인지 알리고 묻는다.
            // 실측(2026-10-02): 켜자마자 결정 대기 중이던 다른 토론까지 추천안으로 정해졌다.
            if (!state?.delegation?.on) {
              const d = state?.debates?.filter((x) => x.phase === 'decide').length ?? 0;
              const pending =
                (state?.approvals.filter((a) => a.state === 'pending' && (a.kind === 'integrate' || a.kind === 'integrate_request'))
                  .length ?? 0) +
                (state?.requests.filter((r) => r.status === 'drafted').length ?? 0) +
                d;
              // 대신 승인까지 하는 강한 모드라 켤 때는 늘 묻는다(실측 2026-10-02 QA: 대기 결정이 없으면 한 번 클릭으로 바로 켜졌다).
              const who = empName(state!.employees, state!.delegation?.delegate ?? null);
              if (
                !confirm(
                  lang === 'ko'
                    ? `${who}에게 전권을 맡깁니다: 초안 확정·직원 질문·예산·범위·반영 승인·토론 결정을 대신 하고, 모두 기록으로 남깁니다.${pending > 0 ? `\n지금 기다리는 결정 ${pending}개도 바로 처리합니다.` : ''}\n켤까요?`
                    : `Delegate every decision to ${who}?${pending > 0 ? ` ${pending} pending decisions will be made right away.` : ''}`,
                )
              )
                return;
            }
            void api('delegation', { body: { on: !state?.delegation?.on } })
              .then(reload)
              .catch(() => {});
          }}
        >
          🧭{' '}
          {state?.delegation?.on
            ? lang === 'ko'
              ? `전권 위임 중 (${empName(state.employees, state.delegation.delegate)})`
              : `Delegated (${empName(state.employees, state.delegation.delegate)})`
            : lang === 'ko'
              ? '전권 위임'
              : 'Delegate all'}
        </button>
        <button
          className={`btn ${state?.paused ? 'ok' : ''}`}
          style={{ marginBottom: 8 }}
          title={
            lang === 'ko'
              ? state?.paused
                ? '다시 일을 시작합니다.'
                : '진행 중인 실행만 마무리하고 새 작업·검수·직원끼리의 대화를 시작하지 않습니다.'
              : state?.paused
                ? 'Resume work.'
                : 'Finish running work; start nothing new.'
          }
          onClick={() =>
            void api('pause', { body: { paused: !state?.paused } })
              .then(reload)
              .catch(() => {})
          }
        >
          <Icon name={state?.paused ? 'bolt' : 'pause'} />{' '}
          {state?.paused ? (lang === 'ko' ? '일시정지 풀기' : 'Resume') : lang === 'ko' ? '전체 일시정지' : 'Pause all'}
        </button>
        <button className="btn primary" onClick={() => setNewTicket(true)} disabled={!state?.projects.length}>
          <Icon name="plus" /> {t('newTicket')}
        </button>
        <div className="foot">
          <span className="live-pill">
            <span className={`live ${live ? '' : 'off'}`} /> {live ? 'Live' : 'Offline'}
          </span>
          <span style={{ flex: 1 }} />
          <button
            className={`btn small ${notify ? 'ok' : ''}`}
            onClick={() => void toggleNotify()}
            title={
              lang === 'ko'
                ? `브라우저 알림 ${notify ? '끄기' : '켜기'} (앱 창이 열려 있을 때)`
                : `${notify ? 'Disable' : 'Enable'} browser alerts`
            }
            aria-pressed={notify}
          >
            <Icon name="bell" size={13} />
          </button>
          <button
            className={`btn small ${state?.toast ? 'ok' : ''}`}
            onClick={() =>
              void api<{ toast: boolean; blocked: string | null }>('toast', { body: { on: !state?.toast } }).then((r) => {
                // 윈도우 설정에서 알림이 꺼져 있으면 보내도 보이지 않는다: 대표가 직접 켜야 한다.
                if (r.toast && r.blocked)
                  alert(
                    lang === 'ko'
                      ? '윈도우 설정에서 알림이 꺼져 있어 토스트가 보이지 않습니다.\n설정 → 시스템 → 알림에서 알림을 켜고, 목록의 "Windows PowerShell"도 켜 주세요.'
                      : 'Windows notifications are off. Turn them on (and "Windows PowerShell") in Settings → System → Notifications.',
                  );
                reload();
              })
            }
            title={
              lang === 'ko'
                ? `윈도우 알림 ${state?.toast ? '끄기' : '켜기'} (앱 창을 닫아도 화면 구석에 알림)`
                : `${state?.toast ? 'Disable' : 'Enable'} Windows toast alerts`
            }
            aria-pressed={Boolean(state?.toast)}
          >
            🪟
          </button>
          <select value={lang} onChange={(e) => setLang(e.target.value as Lang)}>
            <option value="ko">한국어</option>
            <option value="en">English</option>
          </select>
          <button
            className="btn small"
            onClick={() => {
              const next = theme === 'dark' ? 'light' : 'dark';
              saveTheme(next);
              setTheme(next);
            }}
            title={lang === 'ko' ? (theme === 'dark' ? '화이트 모드로' : '다크 모드로') : theme === 'dark' ? 'Light mode' : 'Dark mode'}
            aria-label={lang === 'ko' ? '화면 색 바꾸기' : 'Switch theme'}
          >
            {theme === 'dark' ? '☀️' : '🌙'}
          </button>
        </div>
      </aside>
      <main className="main">
        {todos.length > 0 && !path.startsWith('/inbox') && path !== '/' && (
          // 지금 대표가 할 일: 어느 화면에서든 한 줄로(무엇이 몇 개인지만). 자세한 것은 할 일 화면에서.
          // 대표 요청(2026-10-03): 할 일 배너가 보류 메모 원문을 줄줄이 나열해 읽기 불친절했다.
          <div className="banner info todo-banner" style={{ marginBottom: 14 }}>
            <span className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
              <b>{lang === 'ko' ? `🔔 대표 할 일 ${todos.length}개` : `🔔 ${todos.length} need you`}</b>
              {(
                [
                  [['approval'], '승인', 'approve'],
                  [['decision', 'permission'], '결정', 'decide'],
                  [['draft', 'failed'], '초안', 'drafts'],
                  [['later'], '직접 확인', 'check'],
                  [['stalled', 'paused'], '살펴볼 것', 'watch'],
                ] as [string[], string, string][]
              )
                .map(([kinds, ko, en]) => [todos.filter((x) => kinds.includes(x.kind)).length, lang === 'ko' ? ko : en] as const)
                .filter(([n]) => n > 0)
                .map(([n, label]) => (
                  <span key={label} className="sub">
                    {label} {n}
                  </span>
                ))}
            </span>
            <Link to="/inbox" className="btn small">
              {lang === 'ko' ? '할 일 보기' : 'Open inbox'}
            </Link>
          </div>
        )}
        {state?.delegation?.on && (
          <div className="banner info" style={{ marginBottom: 14 }}>
            {lang === 'ko'
              ? `🧭 전권 위임 중: ${empName(state.employees, state.delegation.delegate)}이(가) 초안 확정·질문 답·예산·범위·반영 승인을 대신 결정합니다. 대표 직접 확인은 QA 의견으로 판단하고, 확신이 없는 항목은 "나중에 확인"으로 남깁니다. 결정 기록은 대시보드에 있습니다.`
              : `🧭 Delegated to ${empName(state.employees, state.delegation.delegate)}: drafts, questions, budgets, scope and approvals are decided for you and logged on the dashboard.`}
          </div>
        )}
        {state?.paused && (
          <div className="banner warn" style={{ marginBottom: 14 }}>
            {lang === 'ko'
              ? '⏸ 회사 전체가 일시정지 중입니다. 진행 중인 실행만 마무리하고 새 작업·검수는 시작하지 않습니다. 대화에서 직접 부른 직원은 답합니다.'
              : '⏸ The company is paused. Running work finishes; nothing new starts. Employees you mention still reply.'}
          </div>
        )}
        {page}
      </main>
      {newTicket && <NewTicket onClose={() => setNewTicket(false)} />}
    </div>
  );
}

export function App() {
  const [lang, setLangState] = useState<Lang>(
    () => (localStorage.getItem('ac-lang') as Lang) || (navigator.language.startsWith('ko') ? 'ko' : 'en'),
  );
  const setLang = (l: Lang) => {
    localStorage.setItem('ac-lang', l);
    setLangState(l);
  };
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    getToken();
    const onPop = () => setPath(location.pathname);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const go = (p: string) => {
    history.pushState(null, '', p);
    setPath(p);
    document.querySelector('.main')?.scrollTo(0, 0);
  };
  const company = useCompanyState();

  return (
    <LangContext.Provider value={{ lang, setLang }}>
      <RouteContext.Provider value={{ path, go }}>
        <StateContext.Provider value={company}>
          <ToastProvider>{company.error?.status === 401 ? <AuthMissing /> : <Shell />}</ToastProvider>
        </StateContext.Provider>
      </RouteContext.Provider>
    </LangContext.Provider>
  );
}

function AuthMissing() {
  const { t, lang } = useT();
  return (
    <div style={{ display: 'grid', placeItems: 'center', height: '100%', padding: 24 }}>
      <div className="card" style={{ maxWidth: 480 }}>
        <div className="body">
          <h2 style={{ marginTop: 0 }}>🔒 {t('appName')}</h2>
          <p>{t('authMissing')}</p>
          {/* 실측(2026-10-02): "터미널에 표시된 주소"라고만 써 있었는데, 아이콘으로 쓰는 대표에게는 터미널이 없다. */}
          <p className="hint">
            {lang === 'ko' ? '아이콘이 없으면 터미널에서:' : 'No icon? In a terminal:'} <code>agent-company start</code>
          </p>
        </div>
      </div>
    </div>
  );
}

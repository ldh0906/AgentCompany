import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { api, ApiError, getToken, subscribe, type State } from './api.ts';
import { LangContext, useT, type Lang } from './i18n.ts';
import { Icon, needsCeo, ToastProvider } from './components/ui.tsx';
import { Dashboard } from './pages/Dashboard.tsx';
import { Board } from './pages/Board.tsx';
import { TicketPage } from './pages/TicketPage.tsx';
import { Org } from './pages/Org.tsx';
import { Projects } from './pages/Projects.tsx';
import { System } from './pages/System.tsx';
import { NewTicket } from './pages/NewTicket.tsx';
import { ChatPage } from './pages/Chat.tsx';
import { Live } from './pages/Live.tsx';
import { isUnread, unreadMentions } from './components/unread.ts';

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
  const reload = useCallback(() => {
    api<State>('state')
      .then((s) => {
        setState(s);
        setError(null);
        setLive(true);
      })
      .catch((e: ApiError) => {
        setError(e);
        setLive(false);
      });
  }, []);
  useEffect(() => {
    reload();
    const unsub = subscribe(() => {
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(reload, 150);
    });
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
  const [notify, setNotify] = useState(() => {
    try {
      return localStorage.getItem('ac-notify') === '1' && 'Notification' in window && Notification.permission === 'granted';
    } catch {
      return false;
    }
  });
  const seen = useRef<Set<string> | null>(null);
  const seenMentions = useRef<Set<string> | null>(null);
  useEffect(() => {
    document.title = pending + held > 0 ? `(${pending + held}) Agent Company` : 'Agent Company';
    if (!state) return;
    const fresh = state.approvals.filter((a) => !seen.current?.has(a.id));
    const first = seen.current === null;
    seen.current = new Set(state.approvals.map((a) => a.id));
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
    for (const a of fresh.slice(0, 3))
      new Notification(lang === 'ko' ? '대표 승인 필요' : 'Approval needed', { body: a.summary, tag: a.id });
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
          <Link to="/">
            <Icon name="dashboard" /> {t('nav_dashboard')} {pending + held > 0 && <span className="count">{pending + held}</span>}
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
            title={lang === 'ko' ? `승인 알림 ${notify ? '끄기' : '켜기'}` : `${notify ? 'Disable' : 'Enable'} approval alerts`}
            aria-pressed={notify}
          >
            <Icon name="bell" size={13} />
          </button>
          <select value={lang} onChange={(e) => setLang(e.target.value as Lang)}>
            <option value="ko">한국어</option>
            <option value="en">English</option>
          </select>
        </div>
      </aside>
      <main className="main">
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
  const { t } = useT();
  return (
    <div style={{ display: 'grid', placeItems: 'center', height: '100%', padding: 24 }}>
      <div className="card" style={{ maxWidth: 480 }}>
        <div className="body">
          <h2 style={{ marginTop: 0 }}>🔒 {t('appName')}</h2>
          <p>{t('authMissing')}</p>
          <code>agent-company start</code>
        </div>
      </div>
    </div>
  );
}

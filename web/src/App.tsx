import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { api, ApiError, getToken, subscribe, type State } from './api.ts';
import { LangContext, useT, type Lang } from './i18n.ts';
import { ToastProvider } from './components/ui.tsx';
import { Dashboard } from './pages/Dashboard.tsx';
import { Board } from './pages/Board.tsx';
import { TicketPage } from './pages/TicketPage.tsx';
import { Org } from './pages/Org.tsx';
import { Projects } from './pages/Projects.tsx';
import { Decisions } from './pages/Decisions.tsx';
import { System } from './pages/System.tsx';
import { NewTicket } from './pages/NewTicket.tsx';

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
  const { state, live } = useCompany();
  const [newTicket, setNewTicket] = useState(false);
  const pending = state?.approvals.length ?? 0;
  const held = state?.tickets.filter((x) => x.hold).length ?? 0;

  let page: React.ReactNode;
  if (path.startsWith('/tickets/')) page = <TicketPage id={decodeURIComponent(path.slice('/tickets/'.length))} />;
  else if (path.startsWith('/board')) page = <Board />;
  else if (path.startsWith('/org')) page = <Org />;
  else if (path.startsWith('/projects')) page = <Projects />;
  else if (path.startsWith('/decisions')) page = <Decisions />;
  else if (path.startsWith('/system')) page = <System />;
  else page = <Dashboard onNewTicket={() => setNewTicket(true)} />;

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand">
          <img src="/favicon.svg" alt="" /> {t('appName')}
        </div>
        <nav className="nav">
          <Link to="/">
            {t('nav_dashboard')} {pending + held > 0 && <span className="count">{pending + held}</span>}
          </Link>
          <Link to="/board">{t('nav_board')}</Link>
          <Link to="/org">{t('nav_org')}</Link>
          <Link to="/projects">{t('nav_projects')}</Link>
          <Link to="/decisions">{t('nav_decisions')}</Link>
          <Link to="/system">{t('nav_system')}</Link>
        </nav>
        <div className="spacer" />
        <button className="btn primary" onClick={() => setNewTicket(true)} disabled={!state?.projects.length}>
          + {t('newTicket')}
        </button>
        <div className="foot">
          <span className={`live ${live ? '' : 'off'}`} /> {live ? 'live' : 'offline'}
          <span style={{ flex: 1 }} />
          <select value={lang} onChange={(e) => setLang(e.target.value as Lang)} style={{ width: 'auto', padding: '2px 6px' }}>
            <option value="ko">한국어</option>
            <option value="en">English</option>
          </select>
        </div>
      </aside>
      <main className="main">{page}</main>
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

import type { Approval, Claim, Decision, DomainEvent, Employee, Evidence, Project, Ticket } from '../../src/core/types.ts';

export type { Approval, Claim, Decision, DomainEvent, Employee, Evidence, Project, Ticket };
import type { UsageSummary } from '../../src/core/types.ts';
export type { UsageSummary };

export interface RunSummary {
  id: string;
  ticketId: string;
  employeeId: string;
  kind: 'work' | 'review' | 'analysis' | 'synthesis' | 'chat';
  status: string;
  round: number;
  cli: string;
  startedAt: string;
  endedAt: string | null;
  failureClass: string | null;
  reportError: string | null;
  summary: string;
  headSha: string | null;
  changedPaths: string[];
  exitCode: number | null;
  usage?: { input: number; cacheRead: number; output: number; total: number; costUsd: number | null } | null;
}

export interface AdapterInfo {
  kind: Employee['cli'];
  displayName: string;
  capabilities: {
    accessLevels: Employee['accessLevel'][];
    permissionRelay: boolean;
    resume: boolean;
    profileEnvVar: string | null;
    notes: string[];
  };
}

export interface CeoRequest {
  id: string;
  projectId: string;
  text: string;
  status: 'drafting' | 'drafted' | 'failed' | 'accepted' | 'dismissed';
  employeeId: string;
  summary: string;
  drafts: {
    type: string;
    title: string;
    purpose: string;
    requirements: { text: string; evidenceType: string }[];
    doneCriteria: string;
    writeScope: string[];
    dependsOn: number[];
    difficulty?: 'easy' | 'normal' | 'hard';
  }[];
  questions: string[];
  proposals?: (string | null)[];
  answers?: (string | null)[];
  verifySuggestions?: { label: string; argv: string[]; evidenceType: string }[];
  profile?: { summary: string; mobile: boolean; game: boolean } | null;
  error: string | null;
  ticketIds: string[];
  createdAt: string;
}

export interface State {
  employees: Employee[];
  projects: Project[];
  tickets: Ticket[];
  approvals: Approval[];
  recentApprovals: Approval[];
  runs: RunSummary[];
  decisions: Decision[];
  adapters: AdapterInfo[];
  events: DomainEvent[];
  requests: CeoRequest[];
  chiefOfStaff: string | null;
  /** 권한 요청을 대표 대신 처리하는 전체 자동 직원(없으면 null → 대표가 처리). */
  permissionDelegate?: string | null;
  usage?: UsageSummary;
  previews?: PreviewInfo[];
  /** 회사 전체 일시정지 */
  paused?: boolean;
  pausedReason?: string;
  /** 하루 토큰 한도(0 = 없음) */
  dailyLimit?: number;
  /** 난이도별 예상 토큰(끝난 업무 평균, 없으면 기본값) */
  estimates?: Record<'easy' | 'normal' | 'hard', { tokens: number; samples: number }>;
  /** 업무별 토큰 사용량과 예산 */
  budgets?: Record<string, { used: number; budget: number }>;
  /** 병합된 코드에서 찾은, 아직 없는 검증 명령 */
  verifySuggest?: Record<string, { label: string; argv: string[]; evidenceType: string }[]>;
  /** 승인 대기 업무의 자동 화면 점검(사진은 tickets/:id/screens) */
  screenChecks?: Record<string, ScreenCheck>;
  channels?: Channel[];
  /** 직원이 대표를 부른 최근 메시지 */
  mentions?: ChatMessage[];
  /** 지금 대표가 할 일 */
  ceoTodos?: { key: string; kind: string; title: string; link: string }[];
  /** 최근 알림(QA 자동 반려, 요청 완료 등) */
  notices?: { id: string; at: string; title: string; body: string; link: string }[];
  /** 윈도우 토스트 알림 켬 */
  toast?: boolean;
  /** 고급 QA(직접 플레이) 기록: 업무 ID 또는 Q:요청 ID */
  /** 대화에서 직원이 낸 프로젝트 프로필 변경 제안(프로젝트 ID별) */
  profileProposals?: Record<string, { profile: { summary: string; mobile: boolean; game: boolean }; by: string; at: string }>;
  /** 요청별 사용 토큰(초안 + 업무 + 업무방 대화) */
  requestTokens?: Record<string, { total: number; byTicket: Record<string, number> }>;
  playtests?: Record<
    string,
    { state: 'running' | 'done' | 'failed'; at: string; by: string; qaBy: string; opinion: string | null; note: string }
  >;
}

export interface ScreenCheck {
  sha: string;
  state: 'running' | 'done' | 'failed';
  at: string;
  note: string;
  shots: { label: string }[];
  errors: string[];
  qaRunId: string | null;
  qaBy: string | null;
  opinion: string | null;
  qaState: string | null;
  scripted?: boolean;
  downloads?: { name: string; size: number; verdict: string; text?: { preview: string } }[];
  clips?: { label: string; fps: number; count: number }[];
}

export interface Channel {
  id: string;
  kind: 'general' | 'ticket' | 'dm' | 'group';
  name: string;
  projectId: string | null;
  ticketId: string | null;
  members: string[];
  createdBy: string;
  topic: string;
  createdAt: string;
  lastMessageAt: string;
}

export interface ChatMessage {
  id: string;
  channelId: string;
  author: string;
  text: string;
  kind: 'chat' | 'report' | 'review' | 'feedback' | 'event' | 'permission' | 'steer' | 'followup';
  mentions: string[];
  refs: string[];
  createdAt: string;
  runId?: string | null;
  followUp?: { title: string; reason: string; projectId: string | null; ticketId: string | null; requestId?: string } | null;
}

export interface ActivityItem {
  kind: 'say' | 'think' | 'tool' | 'output' | 'command' | 'file' | 'approval' | 'steer' | 'error' | 'done';
  text: string;
  detail?: string;
}

/** 실행해 보기(대표 직접 확인용으로 띄운 개발 서버). */
export interface PreviewInfo {
  key: string;
  projectId: string;
  ticketId: string | null;
  sha: string;
  state: 'starting' | 'running' | 'failed' | 'stopped';
  url: string | null;
  command: string;
  log: string;
  startedAt: string;
  /** 업무 제출물이 바뀌어 옛 버전을 띄우고 있음. */
  stale?: boolean;
}

const TOKEN_KEY = 'agent-company-token';

function token(): string {
  const fromHash = new URLSearchParams(location.hash.slice(1)).get('token');
  if (fromHash) {
    sessionStorage.setItem(TOKEN_KEY, fromHash);
    history.replaceState(null, '', location.pathname + location.search);
    return fromHash;
  }
  return sessionStorage.getItem(TOKEN_KEY) ?? '';
}

let cachedToken = '';
export function getToken(): string {
  cachedToken ||= token();
  return cachedToken;
}

// 앱을 다시 켜면 토큰이 바뀐다. 열린 창에 새 주소(#token=…)만 붙여 넣으면 페이지가 다시 읽히지 않으므로 여기서 받는다.
window.addEventListener('hashchange', () => {
  if (new URLSearchParams(location.hash.slice(1)).get('token')) {
    cachedToken = token();
    location.reload();
  }
});

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`/api/${path}`, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers: { authorization: `Bearer ${getToken()}`, 'content-type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string }).error ?? res.statusText);
  return data as T;
}

export function subscribe(onChange: () => void): () => void {
  let es: EventSource | null = null;
  let closed = false;
  const connect = () => {
    if (closed) return;
    es = new EventSource(`/api/stream?token=${encodeURIComponent(getToken())}`);
    es.addEventListener('change', onChange);
    es.onerror = () => {
      es?.close();
      setTimeout(connect, 2000);
    };
  };
  connect();
  return () => {
    closed = true;
    es?.close();
  };
}

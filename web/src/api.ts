import type { Approval, Claim, Decision, DomainEvent, Employee, Evidence, Project, Ticket } from '../../src/core/types.ts';

export type { Approval, Claim, Decision, DomainEvent, Employee, Evidence, Project, Ticket };

export interface RunSummary {
  id: string;
  ticketId: string;
  employeeId: string;
  kind: 'work' | 'review' | 'analysis' | 'synthesis';
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
}

export interface AdapterInfo {
  kind: Employee['cli'];
  displayName: string;
  capabilities: { accessLevels: Employee['accessLevel'][]; permissionRelay: boolean; resume: boolean; profileEnvVar: string | null; notes: string[] };
}

export interface CeoRequest {
  id: string;
  projectId: string;
  text: string;
  status: 'drafting' | 'drafted' | 'failed' | 'accepted' | 'dismissed';
  employeeId: string;
  summary: string;
  drafts: { type: string; title: string; purpose: string; requirements: { text: string; evidenceType: string }[]; doneCriteria: string; writeScope: string[]; dependsOn: number[] }[];
  questions: string[];
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

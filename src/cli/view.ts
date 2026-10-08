// 회사 상태 → 터미널에 보일 것(aco ps와 TUI가 같이 쓴다). 순수 함수: 상태만 받아 글자를 만든다.
import type { Approval, DomainEvent, Employee, Project, Ticket } from '../core/types.ts';
import type { CeoTodo } from '../app/notify.ts';
import type { CeoRequest } from '../app/records.ts';
import { c } from './term.ts';

/** API의 GET state 중 CLI가 쓰는 부분 */
export interface CliState {
  employees: Employee[];
  projects: Project[];
  tickets: Ticket[];
  approvals: Approval[];
  runs: { id: string; ticketId: string; employeeId: string; kind: string; status: string; startedAt: string }[];
  requests: CeoRequest[];
  ceoTodos: CeoTodo[];
  events: DomainEvent[];
  paused: boolean;
  delegation: { on: boolean };
  employeeBudgets?: Record<string, { used: number; limit: number }>;
}

const CLI_LABEL: Record<string, string> = { claude: 'Claude', codex: 'Codex', agy: 'Antigravity', fake: 'Fake' };
const RANK_LABEL: Record<string, string> = { lead: '리드', senior: '선임', junior: '주니어' };
const RUN_LABEL: Record<string, string> = { work: '작업', review: '검수', analysis: '초안', chat: '대화' };
const STATUS_LABEL: Record<string, string> = {
  received: '접수',
  analyzing: '분석',
  backlog: '대기',
  assigned: '배정',
  in_progress: '작업 중',
  verifying: '검증 중',
  in_review: '검수 중',
  changes_requested: '수정 요청',
  awaiting_approval: '승인 대기',
  integrating: '반영 중',
  done: '완료',
  cancelled: '취소',
  failed: '실패',
  quarantined: '격리',
};

const HOLD_LABEL: Record<string, string> = {
  needs_permission: '멈춤 — 대표 허락 필요',
  needs_decision: '멈춤 — 대표 결정 필요',
  usage_limit: '멈춤 — AI 사용량 한도(30분마다 다시 시도)',
  on_hold: '멈춤 — 대표가 멈춰 둠',
};

export const cliLabel = (cli: string) => CLI_LABEL[cli] ?? cli;
export const statusLabel = (s: string) => STATUS_LABEL[s] ?? s;

export function nameOf(s: Pick<CliState, 'employees'>, id: string | null | undefined): string {
  if (!id) return '-';
  if (id === 'ceo') return '대표';
  if (id === 'orchestrator' || id === 'system') return '시스템';
  if (id === 'auto') return '자동';
  if (id.startsWith('delegate:')) return `${nameOf(s, id.slice('delegate:'.length))}(위임)`;
  return s.employees.find((e) => e.id === id)?.name ?? id;
}

export interface TeamRow {
  id: string;
  name: string;
  cli: string;
  rank: string;
  busy: boolean;
  doing: string;
}

/** 팀: 직원마다 지금 무엇을 하는지(돌고 있는 실행) */
export function teamRows(s: CliState): TeamRow[] {
  return s.employees
    .filter((e) => e.active && !e.removedAt)
    .map((e) => {
      const run = s.runs.find((r) => r.employeeId === e.id && r.status === 'running');
      const t = run ? s.tickets.find((x) => x.id === run.ticketId) : null;
      const doing = run
        ? `${RUN_LABEL[run.kind] ?? run.kind} ${t ? `${t.id} ${t.title}` : run.ticketId.startsWith('Q-') ? '요청 초안' : ''}`.trim()
        : (s.employeeBudgets?.[e.id]?.used ?? 0) >= (s.employeeBudgets?.[e.id]?.limit ?? Infinity)
          ? '멈춤 — 이번 달 예산 소진'
          : '쉬는 중';
      return {
        id: e.id,
        name: e.name,
        cli: cliLabel(e.cli),
        rank: RANK_LABEL[e.rank ?? 'senior'] ?? '',
        busy: Boolean(run),
        doing,
      };
    });
}

/** 끝나지 않은 업무 */
export function openTickets(s: CliState): Ticket[] {
  return s.tickets.filter((t) => !['done', 'cancelled', 'failed'].includes(t.status));
}

/** 진행 기록 한 줄(보여 줄 만한 것만, 나머지는 null) */
export function describe(s: CliState, e: DomainEvent): string | null {
  const p = (e.payload ?? {}) as Record<string, unknown>;
  const id = e.entityId;
  const first = (x: unknown) => String(x ?? '').split('\n')[0]!;
  switch (e.type) {
    case 'request.submitted':
      return `📝 요청 → ${nameOf(s, String(p.chief ?? ''))}: ${first(p.text)}`;
    case 'request.drafted':
      return c.yellow(`📋 업무 초안이 나왔습니다 — 확정하면 시작`);
    case 'request.accepted':
      return `▶ 초안 확정: ${((p.tickets as string[]) ?? []).join(', ')}`;
    case 'request.awaiting_approval':
      return c.yellow(`⚑ 요청 결과물이 완성됐습니다 — 승인하면 한 번에 반영`);
    case 'request.integrated':
      return c.green(`✔ 요청 결과물을 내 저장소에 반영했습니다`);
    case 'request.rejected':
      return `↩ 요청 결과물 반려 → 고칠 업무 ${String(p.fix ?? '')}`;
    case 'ticket.assigned':
      return `${id} 배정: 담당 ${nameOf(s, String(p.assigneeId))}, 검수 ${nameOf(s, String(p.reviewerId))}`;
    case 'ticket.in_progress':
      return `${id} 작업 시작`;
    case 'ticket.in_review':
      return `${id} 검사 통과 → 독립 검수`;
    case 'ticket.changes_requested':
      return c.yellow(`${id} 수정 요청: ${first(p.reason)}`);
    case 'ticket.awaiting_approval':
      return `${id} 검수 통과`;
    case 'ticket.done':
      return c.green(`✔ ${id} 완료`);
    case 'ticket.scope_violation':
      return c.red(`⚠ ${id} 허락 안 된 파일 수정: ${((p.paths as string[]) ?? []).join(', ')}`);
    case 'ticket.held': {
      const why = HOLD_LABEL[String(p.reason)];
      return why ? c.yellow(`! ${id} ${why}`) : null; // 앞 업무 기다림 같은 것은 조용히
    }
    case 'ticket.failed':
      return c.red(`✖ ${id} 실패: ${first(p.reason)}`);
    case 'ticket.integration_result':
      return p.kind === 'merged' && p.branch ? `${id} → 요청 결과물에 합침` : null;
    case 'contract.change_allowed':
      return `${id} 공유 계약 변경 허락`;
    case 'employee.hired':
      return `👤 ${String(p.name)} 합류`;
    default:
      return null;
  }
}

export function feed(s: CliState, limit: number): { at: string; text: string }[] {
  return [...s.events]
    .sort((a, b) => a.seq - b.seq)
    .map((e) => ({ at: e.ts, text: describe(s, e) }))
    .filter((x): x is { at: string; text: string } => Boolean(x.text))
    .slice(-limit);
}

export const hhmm = (iso: string) => {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/** 승인·대표 할 일이 속한 프로젝트 ID(알 수 없으면 null: 회사 전체 일) */
export function projectOfItem(s: Pick<CliState, 'tickets' | 'requests'>, x: { ticketId?: string | null; detail?: unknown }): string | null {
  const d = (x.detail ?? {}) as { projectId?: unknown };
  if (typeof d.projectId === 'string') return d.projectId;
  const id = x.ticketId;
  if (!id) return null;
  return s.tickets.find((t) => t.id === id)?.projectId ?? s.requests.find((r) => r.id === id)?.projectId ?? null;
}

/**
 * 프로젝트: 지금 폴더와 같은 저장소만. 하나뿐이라고 다른 폴더의 프로젝트로 보내지 않는다
 * (다른 저장소에서 친 요청이 엉뚱한 프로젝트로 가고, 그 폴더의 신뢰 확인도 건너뛰게 된다).
 */
export function projectFor(s: Pick<CliState, 'projects'>, cwd: string): Project | null {
  const norm = (x: string) => x.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
  return s.projects.find((p) => norm(p.originPath) === norm(cwd)) ?? null;
}

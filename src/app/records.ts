// 실행·증거·승인·결정·경로 잠금 저장. 상태 변경은 이벤트와 함께 기록한다.
import { tr } from '../core/i18n.ts';

import { createHash, randomUUID } from 'node:crypto';
import type { Store } from '../store/db.ts';
import type { AgentReport, TicketDraft, VerifySuggestion } from '../agents/report.ts';
import type {
  Approval,
  ApprovalKind,
  ApprovalState,
  Claim,
  Decision,
  DecisionStatus,
  Evidence,
  ProjectProfile,
  Run,
  Ticket,
  UsageSummary,
  UsageTotals,
} from '../core/types.ts';
import type { DeliberationPhase } from '../agents/deliberation.ts';
import { TERMINAL_STATUSES } from '../core/types.ts';
import { scopesOverlap } from '../workspace/workspace.ts';

export interface RunRecord extends Run {
  round: number;
  cli: string;
  processStartMs: number | null;
  approvalDir: string | null;
  worktreePath: string;
  baseSha: string | null;
  headSha: string | null;
  changedPaths: string[];
  refViolations: string[];
  originChanged: boolean;
  /** 실행 전 스냅샷: 재시작 후에도 범위 검사를 할 수 있게 저장한다. */
  refsBefore: Record<string, string> | null;
  originBefore: string | null;
  originRefsBefore?: Record<string, string> | null;
  /** 스냅샷 시점의 ref 전이 기록 번호. 이후에 기록된 오케스트레이터 이동만 면제한다. */
  moveSeqBefore?: number;
  postProcessed: boolean;
  /** 검토형 업무의 단계와 이번 실행이 다루는 주장. */
  phase?: DeliberationPhase | null;
  claimIds?: string[];
  /** 이전 회차 대화를 이어간 실행이면 그 실행 ID. 이어가기가 실패하면 다음번엔 새로 시작한다. */
  resumedFrom?: string | null;
  report: AgentReport | null;
  reportError: string | null;
  finalText: string | null;
  summary: string;
}

/** 대표 요청 → 비서실장 초안 → 대표 확정. */
/** 인수 시험 한 회차 */
export interface AcceptanceRound {
  round: number;
  state: 'running' | 'done' | 'failed';
  at: string;
  runId: string | null;
  results: { id: string; mark: '✅' | '⚠' | '❓'; why: string }[];
  report: string;
  /** 이 회차로 만든 고칠 업무 */
  fixTickets: string[];
}

export interface CeoRequest {
  id: string;
  projectId: string;
  text: string;
  status: 'drafting' | 'drafted' | 'failed' | 'accepted' | 'dismissed';
  employeeId: string;
  runId: string | null;
  summary: string;
  drafts: TicketDraft[];
  questions: string[];
  /** 질문별 비서실장 제안 답(없으면 null). */
  proposals?: (string | null)[];
  /** 질문별 대표 답(답하면 결정으로도 기록된다). */
  answers?: (string | null)[];
  /** 요구사항에 필요한데 프로젝트에 없는 검증 명령(비서실장 제안). */
  verifySuggestions?: VerifySuggestion[];
  /** 비서실장이 제안한 프로젝트 프로필(프로필이 없을 때만) */
  profile?: ProjectProfile | null;
  /** 요청 전체의 인수 시험(V모델): 비서실장이 초안 때 정하고, 업무가 다 끝나면 확인한다 */
  acceptance?: { id: string; check: string; how: string }[];
  /** 인수 시험 회차 기록 */
  acceptanceRounds?: AcceptanceRound[];
  /** 요청에 딸린 대화방(acceptance: 인수 시험 방, debate: 갈림길 토론 방): 요청별 토큰 합계에 넣는다 */
  rooms?: Record<string, string>;
  /** 비서실장이 표시한 갈림길로 연 토론(결정 전에는 위임 모드도 확정하지 않는다) */
  debateId?: string | null;
  /** 실패한 요청을 다시 보낸 것이면 원래 요청 ID(자동 재시도는 한 번만). */
  retriedFrom?: string;
  error: string | null;
  ticketIds: string[];
  createdAt: string;
}

interface RefMove {
  seq: number;
  ref: string;
  from: string | null;
  to: string | null;
}

export function newId(prefix: string): string {
  return `${prefix}-${randomUUID().replaceAll('-', '').slice(0, 10)}`;
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export class Records {
  readonly store: Store;
  constructor(store: Store) {
    this.store = store;
  }

  // ---- 실행 ----
  saveRun(r: RunRecord): void {
    this.store.put('runs', r.id, r, { ticket_id: r.ticketId, status: r.status, started_at: r.startedAt });
  }
  run(id: string): RunRecord | null {
    return this.store.get<RunRecord>('runs', id);
  }
  runsForTicket(ticketId: string): RunRecord[] {
    return this.store.list<RunRecord>('runs', 'WHERE ticket_id = ? ORDER BY started_at', ticketId);
  }
  runsByStatus(status: Run['status']): RunRecord[] {
    return this.store.list<RunRecord>('runs', 'WHERE status = ? ORDER BY started_at', status);
  }
  recentRuns(limit = 100): RunRecord[] {
    return this.store.list<RunRecord>('runs', 'ORDER BY started_at DESC LIMIT ?', limit);
  }
  /** 토큰 사용량 합계(실행 기록의 usage 칸만 읽는다). 날짜는 이 컴퓨터의 현지 시간 기준. */
  usageSummary(now = new Date()): UsageSummary {
    const localDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const today = localDay(now);
    const rows = this.store.db
      .prepare(
        `SELECT ticket_id AS ticketId,
                json_extract(data, '$.employeeId') AS employeeId,
                json_extract(data, '$.cli') AS cli,
                started_at AS startedAt,
                json_extract(data, '$.usage.input') AS input,
                json_extract(data, '$.usage.cacheRead') AS cacheRead,
                json_extract(data, '$.usage.output') AS output,
                json_extract(data, '$.usage.total') AS total,
                json_extract(data, '$.usage.costUsd') AS costUsd
           FROM runs WHERE json_extract(data, '$.usage.total') IS NOT NULL`,
      )
      .all() as {
      ticketId: string;
      employeeId: string;
      cli: string;
      startedAt: string;
      input: number;
      cacheRead: number;
      output: number;
      total: number;
      costUsd: number | null;
    }[];
    const zero = (): UsageTotals => ({ input: 0, cacheRead: 0, output: 0, total: 0, costUsd: 0, runs: 0 });
    const add = (t: UsageTotals, r: (typeof rows)[number]) => {
      t.input += r.input ?? 0;
      t.cacheRead += r.cacheRead ?? 0;
      t.output += r.output ?? 0;
      t.total += r.total ?? 0;
      t.costUsd += r.costUsd ?? 0;
      t.runs += 1;
    };
    const s: UsageSummary = { all: zero(), today: zero(), byEmployee: {}, byCli: {}, byTicket: {}, daily: {} };
    for (const r of rows) {
      add(s.all, r);
      const day = localDay(new Date(r.startedAt));
      if (day === today) add(s.today, r);
      add((s.byEmployee[r.employeeId] ??= zero()), r);
      add((s.byCli[r.cli] ??= zero()), r);
      add((s.byTicket[r.ticketId] ??= zero()), r);
      add((s.daily[day] ??= zero()), r);
    }
    return s;
  }

  /** 이 회차의 마지막 성공한 작업 실행(제출). */
  /**
   * 검수자가 승인하면서 남긴 작은 실수(마지막 승인 검수 기준). 뒤 업무·인수 시험에 넘긴다.
   * 실측(2026-10-02, 독서모임 T-58): "같은 장르를 연달아 두지 않는다"와 5·6월 모두 인문이라는 모순을 검수자가 짚고 승인했지만,
   * 고칠 길이 없어 최종 기획서(T-59)까지 그대로 갔다.
   */
  minorFixesOf(ticketId: string): string[] {
    const last = this.runsForTicket(ticketId)
      .filter((r) => r.kind === 'review' && r.status === 'succeeded' && r.report?.kind === 'review' && r.report.verdict === 'approve')
      .at(-1);
    return last?.report?.kind === 'review' ? (last.report.minorFixes ?? []) : [];
  }

  latestSubmission(ticket: Ticket): RunRecord | null {
    const runs = this.runsForTicket(ticket.id).filter((r) => r.kind === 'work' && r.status === 'succeeded' && r.round === ticket.round);
    return runs.at(-1) ?? null;
  }

  // ---- 주장 원장 ----
  saveClaim(c: Claim): void {
    this.store.put('claims', c.id, c, { ticket_id: c.ticketId });
  }
  claimsFor(ticketId: string): Claim[] {
    return this.store.list<Claim>('claims', 'WHERE ticket_id = ? ORDER BY rowid', ticketId);
  }

  // ---- 대표 요청 ----
  saveRequest(r: CeoRequest): void {
    this.store.put('requests', r.id, r, { project_id: r.projectId, status: r.status, created_at: r.createdAt });
  }
  request(id: string): CeoRequest | null {
    return this.store.get<CeoRequest>('requests', id);
  }
  requests(limit = 30): CeoRequest[] {
    return this.store.list<CeoRequest>('requests', 'ORDER BY created_at DESC LIMIT ?', limit);
  }
  /** 업무를 만든 대표 요청(초안에서 확정한 업무만; 직접 만든 업무·나눈 조각은 없음). */
  requestOfTicket(t: { id: string; projectId: string }): CeoRequest | null {
    return (
      this.store
        .list<CeoRequest>('requests', 'WHERE project_id = ? ORDER BY created_at DESC LIMIT 100', t.projectId)
        .find((r) => r.ticketIds.includes(t.id)) ?? null
    );
  }

  // ---- 증거 ----
  saveEvidence(e: Evidence, runId: string | null): void {
    const withRun = { ...e, runId: runId ?? e.runId };
    this.store.put('evidence', e.id, withRun, { ticket_id: e.ticketId, run_id: runId, created_at: e.createdAt });
  }
  /** submission(작업 실행 ID)을 주면 그 제출의 증거만. 제출이 없으면 빈 목록. */
  evidenceFor(ticketId: string, scope?: { submission: string | null | undefined }): Evidence[] {
    const all = this.store.list<Evidence>('evidence', 'WHERE ticket_id = ? ORDER BY created_at', ticketId);
    if (!scope) return all;
    return scope.submission ? all.filter((e) => e.runId === scope.submission) : [];
  }

  // ---- 승인 ----
  createApproval(input: {
    kind: ApprovalKind;
    ticketId: string | null;
    subject: string;
    summary: string;
    detail: unknown;
    requestedBy: string;
    expiresAt?: string | null;
  }): Approval {
    const now = new Date().toISOString();
    const a: Approval = {
      id: newId('A'),
      kind: input.kind,
      ticketId: input.ticketId,
      subjectHash: sha256(input.subject),
      summary: input.summary,
      detail: input.detail,
      state: 'pending',
      requestedBy: input.requestedBy,
      decidedAt: null,
      expiresAt: input.expiresAt ?? null,
      createdAt: now,
    };
    this.store.transact(() => {
      this.store.put('approvals', a.id, a, { ticket_id: a.ticketId, state: a.state, created_at: a.createdAt });
      this.store.appendEvent(
        input.requestedBy,
        'approval.requested',
        a.id,
        { kind: a.kind, ticketId: a.ticketId, summary: a.summary },
        now,
      );
    });
    return a;
  }
  approval(id: string): Approval | null {
    return this.store.get<Approval>('approvals', id);
  }
  approvals(state?: ApprovalState): Approval[] {
    return state
      ? this.store.list<Approval>('approvals', 'WHERE state = ? ORDER BY created_at', state)
      : this.store.list<Approval>('approvals', 'ORDER BY created_at DESC LIMIT 200');
  }
  pendingApprovalFor(ticketId: string, kind: ApprovalKind): Approval | null {
    return (
      this.store
        .list<Approval>('approvals', "WHERE ticket_id = ? AND state = 'pending' ORDER BY created_at", ticketId)
        .find((a) => a.kind === kind) ?? null
    );
  }
  setApprovalState(id: string, state: ApprovalState, actor: string, extra: Record<string, unknown> = {}): Approval {
    return this.store.transact(() => {
      const a = this.approval(id);
      if (!a) throw new Error(tr(`승인 ${id} 없음`, `Approval ${id} not found`));
      const now = new Date().toISOString();
      const updated: Approval = { ...a, state, decidedAt: now, detail: { ...(a.detail as object), ...extra } };
      this.store.put('approvals', id, updated, { ticket_id: a.ticketId, state, created_at: a.createdAt });
      this.store.appendEvent(actor, `approval.${state}`, id, { kind: a.kind, ticketId: a.ticketId, ...extra }, now);
      return updated;
    });
  }

  // ---- 결정 기록 ----
  recordDecision(projectId: string, text: string, sourceRefs: string[] = [], supersedes: string | null = null): Decision {
    const d: Decision = {
      id: newId('D'),
      projectId,
      text,
      status: 'current',
      sourceRefs,
      supersedes,
      reflectedIn: [],
      createdAt: new Date().toISOString(),
    };
    this.store.transact(() => {
      if (supersedes) this.setDecisionStatus(supersedes, 'superseded');
      this.store.put('decisions', d.id, d, { project_id: projectId, status: d.status, created_at: d.createdAt });
      this.store.appendEvent('ceo', 'decision.recorded', d.id, { text, supersedes }, d.createdAt);
    });
    return d;
  }
  setDecisionStatus(id: string, status: DecisionStatus): void {
    const d = this.store.get<Decision>('decisions', id);
    if (!d) throw new Error(tr(`결정 ${id} 없음`, `Decision ${id} not found`));
    this.store.transact(() => {
      this.store.put('decisions', id, { ...d, status }, { project_id: d.projectId, status, created_at: d.createdAt });
      this.store.appendEvent('ceo', 'decision.status', id, { from: d.status, to: status });
    });
  }
  decisions(projectId: string, status?: DecisionStatus): Decision[] {
    return status
      ? this.store.list<Decision>('decisions', 'WHERE project_id = ? AND status = ? ORDER BY created_at', projectId, status)
      : this.store.list<Decision>('decisions', 'WHERE project_id = ? ORDER BY created_at', projectId);
  }

  // ---- ref 전이 기록: 오케스트레이터가 직접 만든 이동(from → to)만 면제한다 ----
  // 과거의 "마지막 예상값"과 같다는 이유로 면제하면, 직원이 ref를 과거 값으로 되돌려 변경을 숨길 수 있다.
  currentMoveSeq(): number {
    return Number(this.store.getSetting('ref_move_seq') ?? '0');
  }
  recordRefMove(projectId: string, scope: 'mirror' | 'origin', ref: string, from: string | null, to: string | null): void {
    if (from === to) return;
    const seq = this.currentMoveSeq() + 1;
    this.store.setSetting('ref_move_seq', String(seq));
    const key = `moves:${scope}:${projectId}`;
    const list = JSON.parse(this.store.getSetting(key) ?? '[]') as RefMove[];
    list.push({ seq, ref, from, to });
    this.store.setSetting(key, JSON.stringify(list.slice(-2000)));
  }
  /** before → after 변화가 windowSeq 이후 기록된 오케스트레이터 이동만으로 설명되는지. */
  explainedByMoves(
    projectId: string,
    scope: 'mirror' | 'origin',
    ref: string,
    before: string | undefined,
    after: string | undefined,
    windowSeq: number,
  ): boolean {
    const list = JSON.parse(this.store.getSetting(`moves:${scope}:${projectId}`) ?? '[]') as RefMove[];
    let cur: string | null = before ?? null;
    for (const m of list) if (m.seq > windowSeq && m.ref === ref && m.from === cur) cur = m.to;
    return cur === (after ?? null);
  }

  // ---- 경로 잠금 ----
  /** 다른 활성 티켓과 쓰기 범위가 겹치지 않으면 잠금을 얻는다. */
  acquireLocks(ticket: Ticket, activeTickets: Ticket[]): { ok: true } | { ok: false; conflictWith: string } {
    return this.store.transact(() => {
      const rows = this.store.db.prepare('SELECT ticket_id, glob FROM path_locks').all() as { ticket_id: string; glob: string }[];
      const byTicket = new Map<string, string[]>();
      for (const r of rows) byTicket.set(r.ticket_id, [...(byTicket.get(r.ticket_id) ?? []), r.glob]);
      const activeIds = new Set(
        activeTickets.filter((t) => t.projectId === ticket.projectId && !TERMINAL_STATUSES.includes(t.status)).map((t) => t.id),
      );
      for (const [other, globs] of byTicket) {
        if (other === ticket.id || !activeIds.has(other)) continue;
        if (scopesOverlap(ticket.writeScope, globs)) return { ok: false as const, conflictWith: other };
      }
      // 지금의 쓰기 범위 전체를 잠근다(이미 있는 것은 무시). 처음 한 번만 잠그면 나중에 넓힌 범위가 잠기지 않는다.
      // 실측(2026-10-01, 물 마시기): T-34에 넓혀 준 tests/index.js가 잠기지 않아 T-33도 같은 파일을 만들었고, 반영 때 충돌했다.
      const ins = this.store.db.prepare('INSERT OR IGNORE INTO path_locks(ticket_id, glob) VALUES (?, ?)');
      for (const g of ticket.writeScope) ins.run(ticket.id, g);
      return { ok: true as const };
    });
  }
  releaseLocks(ticketId: string): void {
    this.store.db.prepare('DELETE FROM path_locks WHERE ticket_id = ?').run(ticketId);
  }
}

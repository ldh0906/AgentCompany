// 실행·증거·승인·결정·경로 잠금 저장. 상태 변경은 이벤트와 함께 기록한다.
import { tr } from '../core/i18n.ts';

import { createHash, randomUUID } from 'node:crypto';
import type { Store } from '../store/db.ts';
import type { AgentReport, TicketDraft } from '../agents/report.ts';
import type { Approval, ApprovalKind, ApprovalState, Claim, Decision, DecisionStatus, Evidence, Run, Ticket } from '../core/types.ts';
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
  report: AgentReport | null;
  reportError: string | null;
  finalText: string | null;
  summary: string;
}

/** 대표 요청 → 비서실장 초안 → 대표 확정. */
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
  /** 이 회차의 마지막 성공한 작업 실행(제출). */
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
      if (!byTicket.has(ticket.id)) {
        const ins = this.store.db.prepare('INSERT OR IGNORE INTO path_locks(ticket_id, glob) VALUES (?, ?)');
        for (const g of ticket.writeScope) ins.run(ticket.id, g);
      }
      return { ok: true as const };
    });
  }
  releaseLocks(ticketId: string): void {
    this.store.db.prepare('DELETE FROM path_locks WHERE ticket_id = ?').run(ticketId);
  }
}

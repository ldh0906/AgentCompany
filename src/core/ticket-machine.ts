import { tr } from './i18n.ts';
// 티켓 상태기계. 순수 함수이며 LLM 출력은 여기로 직접 들어오지 않는다.
// 오케스트레이터가 증거를 확인한 뒤 명령을 만들어 호출한다.

import {
  EVIDENCE_STRENGTH,
  TERMINAL_STATUSES,
  type EvidenceType,
  type Hold,
  type HoldReason,
  type Ticket,
  type TicketStatus,
} from './types.ts';

export type Actor =
  | { kind: 'ceo' }
  | { kind: 'orchestrator' }
  | { kind: 'employee'; id: string };

export interface RequirementCheck {
  requirementId: string;
  met: boolean;
  /** 오케스트레이터가 실제 증거 레코드에서 확인한 증거 종류. 검수자의 주장이 아니다. */
  verifiedEvidence: EvidenceType[];
}

export type TicketCommand =
  | { type: 'analyze' }
  | { type: 'accept_to_backlog' }
  | { type: 'assign'; assigneeId: string; reviewerId: string; activeEmployeeIds: string[] }
  | { type: 'start_work'; dependenciesDone: boolean; locksAcquired: boolean }
  | { type: 'submit' }
  | { type: 'deliberation_done'; claims: number; escalated: number }
  | { type: 'run_aborted'; reason: string; hold?: { reason: HoldReason; note: string } }
  | { type: 'verification_passed' }
  | { type: 'verification_failed'; reason: string }
  | { type: 'scope_violation'; paths: string[] }
  | { type: 'review_approve'; checks: RequirementCheck[] }
  | { type: 'review_request_changes'; reason: string }
  | { type: 'ceo_approve' }
  | { type: 'ceo_reject'; reason: string }
  | { type: 'integrated'; commitSha: string }
  | { type: 'integration_failed'; reason: string }
  | { type: 'hold'; reason: HoldReason; note: string }
  | { type: 'release_hold' }
  | { type: 'cancel'; reason: string }
  | { type: 'fail'; reason: string };

export interface TransitionEvent {
  type: string;
  payload: Record<string, unknown>;
}

export type TransitionResult =
  | { ok: true; ticket: Ticket; events: TransitionEvent[] }
  | { ok: false; error: string };

const ALLOWED_WHILE_HELD = new Set<TicketCommand['type']>(['release_hold', 'cancel', 'fail']);

/** 대표만 풀 수 있는 보류 사유. 나머지는 오케스트레이터도 해제 가능. */
const CEO_ONLY_HOLDS = new Set<HoldReason>(['needs_decision', 'needs_permission', 'on_hold']);

function reject(error: string): TransitionResult {
  return { ok: false, error };
}

function isOrchestrator(a: Actor): boolean {
  return a.kind === 'orchestrator';
}

function isCeo(a: Actor): boolean {
  return a.kind === 'ceo';
}

function actorLabel(a: Actor): string {
  return a.kind === 'employee' ? `employee:${a.id}` : a.kind;
}

function hold(reason: HoldReason, resumeTo: TicketStatus, now: string, note: string): Hold {
  return { reason, resumeTo, since: now, note };
}

export function applyTicketCommand(
  ticket: Ticket,
  cmd: TicketCommand,
  actor: Actor,
  now: string,
): TransitionResult {
  if (TERMINAL_STATUSES.includes(ticket.status)) {
    return reject(tr(`종료된 티켓(${ticket.status})은 변경할 수 없습니다.`, `Closed tickets (${ticket.status}) cannot be changed.`));
  }
  if (ticket.hold && !ALLOWED_WHILE_HELD.has(cmd.type)) {
    return reject(tr(`보류 중(${ticket.hold.reason})인 티켓에는 '${cmd.type}'을(를) 실행할 수 없습니다.`, `Cannot run '${cmd.type}' on a ticket on hold (${ticket.hold.reason}).`));
  }

  const next = (patch: Partial<Ticket>, eventType: string, payload: Record<string, unknown> = {}): TransitionResult => ({
    ok: true,
    ticket: { ...ticket, ...patch, updatedAt: now },
    events: [
      {
        type: eventType,
        payload: { from: ticket.status, to: patch.status ?? ticket.status, actor: actorLabel(actor), ...payload },
      },
    ],
  });

  const expect = (...statuses: TicketStatus[]): string | null =>
    statuses.includes(ticket.status) ? null : tr(`'${cmd.type}'은(는) ${statuses.join('/')} 상태에서만 가능합니다(현재: ${ticket.status}).`, `'${cmd.type}' requires status ${statuses.join('/')} (current: ${ticket.status}).`);

  switch (cmd.type) {
    case 'analyze': {
      if (!isCeo(actor) && !isOrchestrator(actor)) return reject(tr('분석 시작은 대표 또는 오케스트레이터만 할 수 있습니다.', 'Only the CEO or orchestrator can start analysis.'));
      const bad = expect('received');
      if (bad) return reject(bad);
      return next({ status: 'analyzing' }, 'ticket.analyzing');
    }

    case 'accept_to_backlog': {
      if (!isCeo(actor) && !isOrchestrator(actor)) return reject(tr('대기 목록 등록은 대표 또는 오케스트레이터만 할 수 있습니다.', 'Only the CEO or orchestrator can add tickets to the backlog.'));
      const bad = expect('analyzing');
      if (bad) return reject(bad);
      if (ticket.requirements.length === 0) return reject(tr('요구사항이 없는 티켓은 대기 목록에 올릴 수 없습니다.', 'Tickets need requirements before entering the backlog.'));
      if (!ticket.doneCriteria.trim()) return reject(tr('완료 조건이 비어 있습니다.', 'Done criteria are empty.'));
      if ((ticket.type === 'impl' || ticket.type === 'doc') && ticket.writeScope.length === 0) {
        return reject(tr('구현·문서 티켓은 쓰기 범위가 있어야 합니다.', 'Implementation and documentation tickets need a write scope.'));
      }
      return next({ status: 'backlog' }, 'ticket.backlog');
    }

    case 'assign': {
      if (!isCeo(actor) && !isOrchestrator(actor)) return reject(tr('배정은 대표 또는 오케스트레이터만 할 수 있습니다.', 'Only the CEO or orchestrator can assign tickets.'));
      const bad = expect('backlog');
      if (bad) return reject(bad);
      if (cmd.assigneeId === cmd.reviewerId) return reject(tr('담당자와 검수자는 같은 직원일 수 없습니다.', 'Assignee and reviewer must be different employees.'));
      if (!cmd.activeEmployeeIds.includes(cmd.assigneeId)) return reject(tr('담당자가 활성 직원이 아닙니다.', 'The assignee is not active.'));
      if (!cmd.activeEmployeeIds.includes(cmd.reviewerId)) return reject(tr('검수자가 활성 직원이 아닙니다.', 'The reviewer is not active.'));
      return next(
        { status: 'assigned', assigneeId: cmd.assigneeId, reviewerId: cmd.reviewerId },
        'ticket.assigned',
        { assigneeId: cmd.assigneeId, reviewerId: cmd.reviewerId },
      );
    }

    case 'start_work': {
      if (!isOrchestrator(actor)) return reject(tr('작업 시작은 오케스트레이터만 할 수 있습니다.', 'Only the orchestrator can start work.'));
      const bad = expect('assigned', 'changes_requested');
      if (bad) return reject(bad);
      if (!cmd.dependenciesDone) {
        return next({ hold: hold('waiting_dependency', ticket.status, now, tr('선행 업무 미완료', 'Dependencies are incomplete')) }, 'ticket.held', {
          reason: 'waiting_dependency',
        });
      }
      if (!cmd.locksAcquired) return reject(tr('쓰기 범위 잠금을 얻지 못했습니다(다른 티켓과 경로가 겹침).', 'Could not lock the write scope (paths overlap another ticket).'));
      if (ticket.runCount >= ticket.budget.maxRuns) {
        return next(
          { hold: hold('needs_decision', ticket.status, now, tr(`실행 예산(${ticket.budget.maxRuns}회) 소진`, `Run budget exhausted (${ticket.budget.maxRuns} runs)`)) },
          'ticket.held',
          { reason: 'needs_decision', cause: 'run_budget_exhausted' },
        );
      }
      return next({ status: 'in_progress', runCount: ticket.runCount + 1 }, 'ticket.in_progress', {
        runCount: ticket.runCount + 1,
      });
    }

    case 'submit': {
      if (!isOrchestrator(actor)) return reject(tr('제출 처리는 오케스트레이터만 할 수 있습니다(직원의 완료 보고는 제출이 아닙니다).', 'Only the orchestrator can submit work (an employee completion report is not a submission).'));
      const bad = expect('in_progress');
      if (bad) return reject(bad);
      return next({ status: 'verifying' }, 'ticket.verifying');
    }

    case 'run_aborted': {
      // 실행이 정상 보고 없이 끝남(시간 초과·사용량 한도·보고서 불량 등). 실행 예산은 이미 소모됐다.
      if (!isOrchestrator(actor)) return reject(tr('실행 중단 처리는 오케스트레이터만 할 수 있습니다.', 'Only the orchestrator can abort runs.'));
      const bad = expect('in_progress');
      if (bad) return reject(bad);
      return next(
        { status: 'assigned', hold: cmd.hold ? hold(cmd.hold.reason, 'assigned', now, cmd.hold.note) : null },
        'ticket.run_aborted',
        { reason: cmd.reason, ...(cmd.hold ? { hold: cmd.hold.reason } : {}) },
      );
    }

    case 'deliberation_done': {
      // 검토형 업무: 블라인드 분석 → 교차 판정 → 재답변 → 코드 종합이 끝나면 대표 확인을 기다린다.
      if (!isOrchestrator(actor)) return reject(tr('검토 종합은 오케스트레이터만 기록할 수 있습니다.', 'Only the orchestrator can record review synthesis.'));
      if (ticket.type !== 'review') return reject(tr('검토형 업무만 교차 검토로 끝낼 수 있습니다.', 'Only review tickets can finish through cross-review.'));
      const bad = expect('in_progress');
      if (bad) return reject(bad);
      return next({ status: 'awaiting_approval' }, 'ticket.deliberation_done', { claims: cmd.claims, escalated: cmd.escalated });
    }

    case 'verification_passed': {
      if (!isOrchestrator(actor)) return reject(tr('검증 결과는 오케스트레이터만 기록할 수 있습니다.', 'Only the orchestrator can record verification results.'));
      const bad = expect('verifying');
      if (bad) return reject(bad);
      return next({ status: 'in_review' }, 'ticket.in_review', { round: ticket.round });
    }

    case 'verification_failed': {
      if (!isOrchestrator(actor)) return reject(tr('검증 결과는 오케스트레이터만 기록할 수 있습니다.', 'Only the orchestrator can record verification results.'));
      const bad = expect('verifying');
      if (bad) return reject(bad);
      return requestChanges(ticket, now, actor, cmd.reason, 'verification');
    }

    case 'scope_violation': {
      if (!isOrchestrator(actor)) return reject(tr('범위 위반은 오케스트레이터만 기록할 수 있습니다.', 'Only the orchestrator can record scope violations.'));
      const bad = expect('verifying');
      if (bad) return reject(bad);
      return next(
        { hold: hold('needs_permission', 'verifying', now, tr(`범위 밖 수정: ${cmd.paths.join(', ')}`, `Out-of-scope changes: ${cmd.paths.join(', ')}`)) },
        'ticket.scope_violation',
        { paths: cmd.paths },
      );
    }

    case 'review_approve': {
      if (actor.kind !== 'employee' || actor.id !== ticket.reviewerId) {
        return reject(tr('검수 승인은 이 티켓에 배정된 검수자만 할 수 있습니다.', 'Only the assigned reviewer can approve this ticket.'));
      }
      const bad = expect('in_review');
      if (bad) return reject(bad);
      for (const req of ticket.requirements) {
        const check = cmd.checks.find((c) => c.requirementId === req.id);
        if (!check) return reject(tr(`요구사항 ${req.id}에 대한 판정이 없습니다.`, `No verdict for requirement ${req.id}.`));
        if (!check.met) return reject(tr(`요구사항 ${req.id}이(가) 충족되지 않았다고 판정하고 승인할 수 없습니다.`, `Cannot approve when requirement ${req.id} is marked unmet.`));
        const best = Math.max(-1, ...check.verifiedEvidence.map((e) => EVIDENCE_STRENGTH[e]));
        if (best < EVIDENCE_STRENGTH[req.evidenceType]) {
          return reject(
            tr(`요구사항 ${req.id}은(는) '${req.evidenceType}' 이상의 증거가 필요하지만 확인된 증거가 부족합니다.`, `Requirement ${req.id} needs '${req.evidenceType}' or stronger evidence; verified evidence is insufficient.`),
          );
        }
      }
      return next({ status: 'awaiting_approval' }, 'ticket.awaiting_approval', { round: ticket.round });
    }

    case 'review_request_changes': {
      if (actor.kind !== 'employee' || actor.id !== ticket.reviewerId) {
        return reject(tr('수정 요청은 이 티켓에 배정된 검수자만 할 수 있습니다.', 'Only the assigned reviewer can request changes.'));
      }
      const bad = expect('in_review');
      if (bad) return reject(bad);
      return requestChanges(ticket, now, actor, cmd.reason, 'review');
    }

    case 'ceo_approve': {
      if (!isCeo(actor)) return reject(tr('최종 승인은 대표만 할 수 있습니다.', 'Only the CEO can give final approval.'));
      const bad = expect('awaiting_approval');
      if (bad) return reject(bad);
      return next({ status: 'integrating' }, 'ticket.integrating');
    }

    case 'ceo_reject': {
      if (!isCeo(actor)) return reject(tr('반려는 대표만 할 수 있습니다.', 'Only the CEO can reject tickets.'));
      const bad = expect('awaiting_approval');
      if (bad) return reject(bad);
      return requestChanges(ticket, now, actor, cmd.reason, 'ceo');
    }

    case 'integrated': {
      if (!isOrchestrator(actor)) return reject(tr('반영 완료는 오케스트레이터만 기록할 수 있습니다.', 'Only the orchestrator can record completed integration.'));
      const bad = expect('integrating');
      if (bad) return reject(bad);
      return next({ status: 'done' }, 'ticket.done', { commitSha: cmd.commitSha });
    }

    case 'integration_failed': {
      if (!isOrchestrator(actor)) return reject(tr('반영 실패는 오케스트레이터만 기록할 수 있습니다.', 'Only the orchestrator can record integration failures.'));
      const bad = expect('integrating');
      if (bad) return reject(bad);
      return next(
        {
          status: 'awaiting_approval',
          hold: hold('needs_decision', 'awaiting_approval', now, tr(`반영 실패: ${cmd.reason}`, `Integration failed: ${cmd.reason}`)),
        },
        'ticket.integration_failed',
        { reason: cmd.reason },
      );
    }

    case 'hold': {
      if (!isCeo(actor) && !isOrchestrator(actor)) return reject(tr('보류는 대표 또는 오케스트레이터만 걸 수 있습니다.', 'Only the CEO or orchestrator can put tickets on hold.'));
      return next({ hold: hold(cmd.reason, ticket.status, now, cmd.note) }, 'ticket.held', { reason: cmd.reason });
    }

    case 'release_hold': {
      if (!ticket.hold) return reject(tr('보류 중이 아닙니다.', 'The ticket is not on hold.'));
      if (CEO_ONLY_HOLDS.has(ticket.hold.reason) ? !isCeo(actor) : !isCeo(actor) && !isOrchestrator(actor)) {
        return reject(tr(`'${ticket.hold.reason}' 보류는 대표만 해제할 수 있습니다.`, `Only the CEO can release a '${ticket.hold.reason}' hold.`));
      }
      return next({ status: ticket.hold.resumeTo, hold: null }, 'ticket.released', {
        reason: ticket.hold.reason,
        resumeTo: ticket.hold.resumeTo,
      });
    }

    case 'cancel': {
      if (!isCeo(actor)) return reject(tr('취소는 대표만 할 수 있습니다.', 'Only the CEO can cancel tickets.'));
      if (ticket.status === 'integrating') return reject(tr('반영 중에는 취소할 수 없습니다. 반영이 끝나거나 실패한 뒤 처리하세요.', 'Cannot cancel during integration. Wait until it finishes or fails.'));
      return next({ status: 'cancelled', hold: null }, 'ticket.cancelled', { reason: cmd.reason });
    }

    case 'fail': {
      if (!isCeo(actor) && !isOrchestrator(actor)) return reject(tr('실패 처리는 대표 또는 오케스트레이터만 할 수 있습니다.', 'Only the CEO or orchestrator can mark tickets as failed.'));
      return next({ status: 'failed', hold: null }, 'ticket.failed', { reason: cmd.reason });
    }
  }
}

function requestChanges(
  ticket: Ticket,
  now: string,
  actor: Actor,
  reason: string,
  source: 'verification' | 'review' | 'ceo',
): TransitionResult {
  const round = ticket.round + 1;
  const base: Ticket = { ...ticket, status: 'changes_requested', round, updatedAt: now };
  const payload = { from: ticket.status, to: 'changes_requested', actor: actorLabel(actor), reason, source, round };
  if (round > ticket.budget.maxRounds) {
    // 최대 회차 초과: 성공으로 처리하지 않고 대표 결정을 기다린다.
    return {
      ok: true,
      ticket: {
        ...base,
        hold: hold('needs_decision', 'changes_requested', now, tr(`수정 회차 ${ticket.budget.maxRounds}회 초과`, `Revision limit exceeded (${ticket.budget.maxRounds} rounds)`)),
      },
      events: [
        { type: 'ticket.changes_requested', payload },
        { type: 'ticket.held', payload: { reason: 'needs_decision', cause: 'round_budget_exhausted' } },
      ],
    };
  }
  return { ok: true, ticket: base, events: [{ type: 'ticket.changes_requested', payload }] };
}

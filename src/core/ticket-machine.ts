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
    return reject(`종료된 티켓(${ticket.status})은 변경할 수 없습니다.`);
  }
  if (ticket.hold && !ALLOWED_WHILE_HELD.has(cmd.type)) {
    return reject(`보류 중(${ticket.hold.reason})인 티켓에는 '${cmd.type}'을(를) 실행할 수 없습니다.`);
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
    statuses.includes(ticket.status) ? null : `'${cmd.type}'은(는) ${statuses.join('/')} 상태에서만 가능합니다(현재: ${ticket.status}).`;

  switch (cmd.type) {
    case 'analyze': {
      if (!isCeo(actor) && !isOrchestrator(actor)) return reject('분석 시작은 대표 또는 오케스트레이터만 할 수 있습니다.');
      const bad = expect('received');
      if (bad) return reject(bad);
      return next({ status: 'analyzing' }, 'ticket.analyzing');
    }

    case 'accept_to_backlog': {
      if (!isCeo(actor) && !isOrchestrator(actor)) return reject('대기 목록 등록은 대표 또는 오케스트레이터만 할 수 있습니다.');
      const bad = expect('analyzing');
      if (bad) return reject(bad);
      if (ticket.requirements.length === 0) return reject('요구사항이 없는 티켓은 대기 목록에 올릴 수 없습니다.');
      if (!ticket.doneCriteria.trim()) return reject('완료 조건이 비어 있습니다.');
      if ((ticket.type === 'impl' || ticket.type === 'doc') && ticket.writeScope.length === 0) {
        return reject('구현·문서 티켓은 쓰기 범위가 있어야 합니다.');
      }
      return next({ status: 'backlog' }, 'ticket.backlog');
    }

    case 'assign': {
      if (!isCeo(actor) && !isOrchestrator(actor)) return reject('배정은 대표 또는 오케스트레이터만 할 수 있습니다.');
      const bad = expect('backlog');
      if (bad) return reject(bad);
      if (cmd.assigneeId === cmd.reviewerId) return reject('담당자와 검수자는 같은 직원일 수 없습니다.');
      if (!cmd.activeEmployeeIds.includes(cmd.assigneeId)) return reject('담당자가 활성 직원이 아닙니다.');
      if (!cmd.activeEmployeeIds.includes(cmd.reviewerId)) return reject('검수자가 활성 직원이 아닙니다.');
      return next(
        { status: 'assigned', assigneeId: cmd.assigneeId, reviewerId: cmd.reviewerId },
        'ticket.assigned',
        { assigneeId: cmd.assigneeId, reviewerId: cmd.reviewerId },
      );
    }

    case 'start_work': {
      if (!isOrchestrator(actor)) return reject('작업 시작은 오케스트레이터만 할 수 있습니다.');
      const bad = expect('assigned', 'changes_requested');
      if (bad) return reject(bad);
      if (!cmd.dependenciesDone) {
        return next({ hold: hold('waiting_dependency', ticket.status, now, '선행 업무 미완료') }, 'ticket.held', {
          reason: 'waiting_dependency',
        });
      }
      if (!cmd.locksAcquired) return reject('쓰기 범위 잠금을 얻지 못했습니다(다른 티켓과 경로가 겹침).');
      if (ticket.runCount >= ticket.budget.maxRuns) {
        return next(
          { hold: hold('needs_decision', ticket.status, now, `실행 예산(${ticket.budget.maxRuns}회) 소진`) },
          'ticket.held',
          { reason: 'needs_decision', cause: 'run_budget_exhausted' },
        );
      }
      return next({ status: 'in_progress', runCount: ticket.runCount + 1 }, 'ticket.in_progress', {
        runCount: ticket.runCount + 1,
      });
    }

    case 'submit': {
      if (!isOrchestrator(actor)) return reject('제출 처리는 오케스트레이터만 할 수 있습니다(직원의 완료 보고는 제출이 아닙니다).');
      const bad = expect('in_progress');
      if (bad) return reject(bad);
      return next({ status: 'verifying' }, 'ticket.verifying');
    }

    case 'run_aborted': {
      // 실행이 정상 보고 없이 끝남(시간 초과·사용량 한도·보고서 불량 등). 실행 예산은 이미 소모됐다.
      if (!isOrchestrator(actor)) return reject('실행 중단 처리는 오케스트레이터만 할 수 있습니다.');
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
      if (!isOrchestrator(actor)) return reject('검토 종합은 오케스트레이터만 기록할 수 있습니다.');
      if (ticket.type !== 'review') return reject('검토형 업무만 교차 검토로 끝낼 수 있습니다.');
      const bad = expect('in_progress');
      if (bad) return reject(bad);
      return next({ status: 'awaiting_approval' }, 'ticket.deliberation_done', { claims: cmd.claims, escalated: cmd.escalated });
    }

    case 'verification_passed': {
      if (!isOrchestrator(actor)) return reject('검증 결과는 오케스트레이터만 기록할 수 있습니다.');
      const bad = expect('verifying');
      if (bad) return reject(bad);
      return next({ status: 'in_review' }, 'ticket.in_review', { round: ticket.round });
    }

    case 'verification_failed': {
      if (!isOrchestrator(actor)) return reject('검증 결과는 오케스트레이터만 기록할 수 있습니다.');
      const bad = expect('verifying');
      if (bad) return reject(bad);
      return requestChanges(ticket, now, actor, cmd.reason, 'verification');
    }

    case 'scope_violation': {
      if (!isOrchestrator(actor)) return reject('범위 위반은 오케스트레이터만 기록할 수 있습니다.');
      const bad = expect('verifying');
      if (bad) return reject(bad);
      return next(
        { hold: hold('needs_permission', 'verifying', now, `범위 밖 수정: ${cmd.paths.join(', ')}`) },
        'ticket.scope_violation',
        { paths: cmd.paths },
      );
    }

    case 'review_approve': {
      if (actor.kind !== 'employee' || actor.id !== ticket.reviewerId) {
        return reject('검수 승인은 이 티켓에 배정된 검수자만 할 수 있습니다.');
      }
      const bad = expect('in_review');
      if (bad) return reject(bad);
      for (const req of ticket.requirements) {
        const check = cmd.checks.find((c) => c.requirementId === req.id);
        if (!check) return reject(`요구사항 ${req.id}에 대한 판정이 없습니다.`);
        if (!check.met) return reject(`요구사항 ${req.id}이(가) 충족되지 않았다고 판정하고 승인할 수 없습니다.`);
        const best = Math.max(-1, ...check.verifiedEvidence.map((e) => EVIDENCE_STRENGTH[e]));
        if (best < EVIDENCE_STRENGTH[req.evidenceType]) {
          return reject(
            `요구사항 ${req.id}은(는) '${req.evidenceType}' 이상의 증거가 필요하지만 확인된 증거가 부족합니다.`,
          );
        }
      }
      return next({ status: 'awaiting_approval' }, 'ticket.awaiting_approval', { round: ticket.round });
    }

    case 'review_request_changes': {
      if (actor.kind !== 'employee' || actor.id !== ticket.reviewerId) {
        return reject('수정 요청은 이 티켓에 배정된 검수자만 할 수 있습니다.');
      }
      const bad = expect('in_review');
      if (bad) return reject(bad);
      return requestChanges(ticket, now, actor, cmd.reason, 'review');
    }

    case 'ceo_approve': {
      if (!isCeo(actor)) return reject('최종 승인은 대표만 할 수 있습니다.');
      const bad = expect('awaiting_approval');
      if (bad) return reject(bad);
      return next({ status: 'integrating' }, 'ticket.integrating');
    }

    case 'ceo_reject': {
      if (!isCeo(actor)) return reject('반려는 대표만 할 수 있습니다.');
      const bad = expect('awaiting_approval');
      if (bad) return reject(bad);
      return requestChanges(ticket, now, actor, cmd.reason, 'ceo');
    }

    case 'integrated': {
      if (!isOrchestrator(actor)) return reject('반영 완료는 오케스트레이터만 기록할 수 있습니다.');
      const bad = expect('integrating');
      if (bad) return reject(bad);
      return next({ status: 'done' }, 'ticket.done', { commitSha: cmd.commitSha });
    }

    case 'integration_failed': {
      if (!isOrchestrator(actor)) return reject('반영 실패는 오케스트레이터만 기록할 수 있습니다.');
      const bad = expect('integrating');
      if (bad) return reject(bad);
      return next(
        {
          status: 'awaiting_approval',
          hold: hold('needs_decision', 'awaiting_approval', now, `반영 실패: ${cmd.reason}`),
        },
        'ticket.integration_failed',
        { reason: cmd.reason },
      );
    }

    case 'hold': {
      if (!isCeo(actor) && !isOrchestrator(actor)) return reject('보류는 대표 또는 오케스트레이터만 걸 수 있습니다.');
      return next({ hold: hold(cmd.reason, ticket.status, now, cmd.note) }, 'ticket.held', { reason: cmd.reason });
    }

    case 'release_hold': {
      if (!ticket.hold) return reject('보류 중이 아닙니다.');
      if (CEO_ONLY_HOLDS.has(ticket.hold.reason) ? !isCeo(actor) : !isCeo(actor) && !isOrchestrator(actor)) {
        return reject(`'${ticket.hold.reason}' 보류는 대표만 해제할 수 있습니다.`);
      }
      return next({ status: ticket.hold.resumeTo, hold: null }, 'ticket.released', {
        reason: ticket.hold.reason,
        resumeTo: ticket.hold.resumeTo,
      });
    }

    case 'cancel': {
      if (!isCeo(actor)) return reject('취소는 대표만 할 수 있습니다.');
      return next({ status: 'cancelled', hold: null }, 'ticket.cancelled', { reason: cmd.reason });
    }

    case 'fail': {
      if (!isCeo(actor) && !isOrchestrator(actor)) return reject('실패 처리는 대표 또는 오케스트레이터만 할 수 있습니다.');
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
        hold: hold('needs_decision', 'changes_requested', now, `수정 회차 ${ticket.budget.maxRounds}회 초과`),
      },
      events: [
        { type: 'ticket.changes_requested', payload },
        { type: 'ticket.held', payload: { reason: 'needs_decision', cause: 'round_budget_exhausted' } },
      ],
    };
  }
  return { ok: true, ticket: base, events: [{ type: 'ticket.changes_requested', payload }] };
}

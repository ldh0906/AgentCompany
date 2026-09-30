// 비용(토큰) 관리: 업무 확정 전에 예상치를 보여 주고, 업무별 예산을 넘으면 멈춰 대표에게 묻는다.
// 실측(2026-09-30, 메이플 MVP): 보통 업무 80만~150만, 어려운 업무 400만~700만 토큰. 기록이 쌓이면 실제 평균을 쓴다.

import type { Difficulty, Ticket } from '../core/types.ts';
import { difficultyOf } from '../core/types.ts';
import type { Records } from './records.ts';

/** 기록이 없을 때 쓰는 예상치(업무 하나를 끝내는 데 드는 토큰, 캐시 읽기 포함). */
export const PRIOR_ESTIMATE: Record<Difficulty, number> = { easy: 600_000, normal: 1_200_000, hard: 4_500_000 };
/** 업무별 기본 예산: 예상치의 약 2~3배. 넘으면 멈추고 묻는다. */
export const DEFAULT_TOKEN_BUDGET: Record<Difficulty, number> = { easy: 2_000_000, normal: 4_000_000, hard: 10_000_000 };

export function ticketTokens(records: Records, ticketId: string): number {
  return records.runsForTicket(ticketId).reduce((a, r) => a + (r.usage?.total ?? 0), 0);
}

/**
 * 업무 예산: 대표가 정한 값, 없으면 기본값과 "같은 난이도 실제 평균의 2.5배" 중 큰 것.
 * 실측(2026-09-30, 메이플 3차): 어려움 업무 평균이 811만인데 기본 예산 1000만이라 평범한 업무도 두 번 멈췄다.
 */
export function tokenBudget(t: Ticket, averageTokens?: number): number {
  return t.budget.maxTokens ?? Math.max(DEFAULT_TOKEN_BUDGET[difficultyOf(t)], averageTokens ? Math.round(averageTokens * 2.5) : 0);
}

/** 난이도별 예상 토큰: 끝난 업무가 2개 이상이면 그 평균, 아니면 기본 예상치. */
export function estimates(records: Records, tickets: Ticket[]): Record<Difficulty, { tokens: number; samples: number }> {
  const out = {} as Record<Difficulty, { tokens: number; samples: number }>;
  for (const d of ['easy', 'normal', 'hard'] as const) {
    const done = tickets
      .filter((t) => t.status === 'done' && difficultyOf(t) === d)
      .map((t) => ticketTokens(records, t.id))
      .filter((n) => n > 0);
    out[d] =
      done.length >= 2
        ? { tokens: Math.round(done.reduce((a, b) => a + b, 0) / done.length), samples: done.length }
        : { tokens: PRIOR_ESTIMATE[d], samples: 0 };
  }
  return out;
}

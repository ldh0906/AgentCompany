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
  // 조사는 웹 페이지를 통째로 읽어 토큰이 많이 든다. 실측(2026-10-02, 카페 사업계획서): 보통 난이도 조사 한 번에 629만,
  // 기본 예산 400만을 넘어 첫 제출부터 대표에게 물었다.
  const research = t.type === 'research' ? RESEARCH_BUDGET_FACTOR : 1;
  return (
    t.budget.maxTokens ?? Math.max(DEFAULT_TOKEN_BUDGET[difficultyOf(t)] * research, averageTokens ? Math.round(averageTokens * 2.5) : 0)
  );
}
export const RESEARCH_BUDGET_FACTOR = 3;

/** 난이도별 예상 토큰: 끝난 업무가 2개 이상이면 그 평균, 아니면 기본 예상치. */
export function estimates(records: Records, tickets: Ticket[]): Record<Difficulty, { tokens: number; samples: number }> {
  const out = {} as Record<Difficulty, { tokens: number; samples: number }>;
  for (const d of ['easy', 'normal', 'hard'] as const) {
    // 조사는 따로 크게 잡으므로(tokenBudget) 평균에서 뺀다: 섞이면 구현 업무 예산까지 부풀어 오른다.
    const done = tickets
      .filter((t) => t.status === 'done' && difficultyOf(t) === d && t.type !== 'research')
      .map((t) => ticketTokens(records, t.id))
      .filter((n) => n > 0);
    out[d] =
      done.length >= 2
        ? { tokens: Math.round(done.reduce((a, b) => a + b, 0) / done.length), samples: done.length }
        : { tokens: PRIOR_ESTIMATE[d], samples: 0 };
  }
  return out;
}

/**
 * 요청 하나에 든 토큰: 비서실장 초안 + 업무마다(작업·검수) + 업무방 대화(화면 QA 의견 등).
 * 대표 요청(2026-10-01 우선순위 5): 요청이 끝나면 얼마나 들었는지 알려 주기.
 */
export function requestTokens(
  records: Records,
  req: { id: string; ticketIds: string[]; rooms?: Record<string, string> },
): { total: number; byTicket: Record<string, number> } {
  const byTicket: Record<string, number> = {};
  for (const id of req.ticketIds) byTicket[id] = ticketTokens(records, id) + ticketTokens(records, `t:${id}`);
  // 요청에 딸린 방(인수 시험·갈림길 토론): 키는 acceptance / debate(화면에서 이름으로 바꾼다)
  for (const [label, channelId] of Object.entries(req.rooms ?? {})) byTicket[label] = ticketTokens(records, channelId);
  return { total: ticketTokens(records, req.id) + Object.values(byTicket).reduce((a, b) => a + b, 0), byTicket };
}

/**
 * 토론 발언 한 번에 드는 토큰: 지난 토론 기록의 평균, 없으면 기본값.
 * 실측(2026-10-02, 4790 토론 2건): 9번 발언에 37만·45만, 한 번에 4만~5만.
 */
export const DEBATE_RUN_PRIOR = 50_000;
export function debateRunTokens(records: Records, channelIds: string[]): number {
  const runs = channelIds.flatMap((id) => records.runsForTicket(id)).filter((r) => (r.usage?.total ?? 0) > 0);
  return runs.length >= 3 ? Math.round(runs.reduce((a, r) => a + (r.usage?.total ?? 0), 0) / runs.length) : DEBATE_RUN_PRIOR;
}

/** 알림 글에 쓰는 토큰 수(한국어는 만·억 단위). */
export function tokensText(n: number, ko: boolean): string {
  if (ko) return n >= 1e8 ? `${(n / 1e8).toFixed(1)}억` : n >= 1e4 ? `${Math.round(n / 1e4)}만` : String(n);
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : String(n);
}

// 직급 기반 배정(순수 함수).
// - 담당자: 난이도가 요구하는 직급 이상 중 담당 업무가 맞는 직원, 그중 가장 낮은 직급(비싼 상위 모델은 아껴 둔다), 그다음 일이 적은 직원.
// - 책임자: 담당자를 뺀 가장 높은 직급 직원(일을 맡기고 책임진다). 다른 직원이 없으면 담당자 본인.
// - 검수자: 담당자와 같거나 높은 직급. 다른 CLI(독립 검수) > QA 담당 > 책임자 > 일이 적은 순.
//   그런 직원이 없으면 남은 직원 중 가장 높은 직급이 검수하고 reviewBelowRank로 표시한다(대표 최종 확인).
import {
  DIFFICULTY_RANK,
  RANK_ORDER,
  difficultyOf,
  rankOf,
  type Difficulty,
  type Employee,
  type RoleTemplate,
  type TicketType,
} from './types.ts';

export type StaffPick =
  | { ok: true; assigneeId: string; reviewerId: string; ownerId: string; reviewBelowRank: boolean }
  | { ok: false; reason: 'too_few' | 'no_assignee_rank' };

export function wantedRoles(type: TicketType): RoleTemplate[] {
  return type === 'impl' ? ['implementer'] : type === 'doc' ? ['planner', 'recorder', 'architect'] : ['architect', 'planner', 'qa'];
}

export function pickStaff(
  ticket: { type: TicketType; difficulty?: Difficulty | null },
  active: Employee[],
  load: (e: Employee) => number,
): StaffPick {
  if (active.length < 2) return { ok: false, reason: 'too_few' };
  const r = (e: Employee) => RANK_ORDER[rankOf(e)];
  const wants = wantedRoles(ticket.type);
  const fits = (e: Employee) => e.roles.some((x) => wants.includes(x));
  const minRank = RANK_ORDER[DIFFICULTY_RANK[difficultyOf(ticket)]];

  const eligible = active.filter((e) => r(e) >= minRank);
  if (eligible.length === 0) return { ok: false, reason: 'no_assignee_rank' };
  // 같거나 높은 직급의 검수자를 구할 수 있는 담당자를 우선한다. 아무도 없으면(예: 팀장 한 명이 맡는 어려운 업무)
  // 하위 직급 검수로 진행하고, 대표가 최종 확인에서 더 꼼꼼히 보도록 표시한다.
  const reviewable = eligible.filter((e) => active.some((o) => o.id !== e.id && r(o) >= r(e)));
  const pool = reviewable.length ? reviewable : eligible;
  const assignee = [...pool].sort((a, b) => Number(fits(b)) - Number(fits(a)) || r(a) - r(b) || load(a) - load(b))[0]!;

  const others = active.filter((e) => e.id !== assignee.id);
  const owner = [...others].sort(
    (a, b) =>
      r(b) - r(a) ||
      Number(b.roles.includes('chief-of-staff') || b.roles.includes('planner')) -
        Number(a.roles.includes('chief-of-staff') || a.roles.includes('planner')) ||
      load(a) - load(b),
  )[0]!;
  const ownerId = r(owner) >= r(assignee) ? owner.id : assignee.id;

  const peers = others.filter((e) => r(e) >= r(assignee));
  const reviewBelowRank = peers.length === 0;
  const top = Math.max(...others.map(r));
  const reviewer = (reviewBelowRank ? others.filter((e) => r(e) === top) : peers).sort(
    (a, b) =>
      Number(b.cli !== assignee.cli) - Number(a.cli !== assignee.cli) ||
      Number(b.roles.includes('qa')) - Number(a.roles.includes('qa')) ||
      Number(b.id === ownerId) - Number(a.id === ownerId) ||
      load(a) - load(b),
  )[0]!;
  return { ok: true, assigneeId: assignee.id, reviewerId: reviewer.id, ownerId, reviewBelowRank };
}

/**
 * 블라인드 교차 검토 패널(최대 size명). 관점이 겹치지 않도록 AI(CLI)마다 가장 높은 직급 한 명씩 먼저 뽑고,
 * 남은 자리는 높은 직급 순(같으면 입력 순서 = 채용 순)으로 채운다.
 */
export function pickPanel(active: Employee[], size = 4): Employee[] {
  const byRank = active
    .map((e, i) => ({ e, i }))
    .sort((a, b) => RANK_ORDER[rankOf(b.e)] - RANK_ORDER[rankOf(a.e)] || a.i - b.i)
    .map((x) => x.e);
  const seen = new Set<string>();
  const first = byRank.filter((e) => !seen.has(e.cli) && seen.add(e.cli));
  return [...first, ...byRank.filter((e) => !first.includes(e))].slice(0, size);
}

// 직급 기반 배정(순수 함수).
// - 담당자: 난이도가 요구하는 직급 이상 중 담당 업무가 맞는 직원, 그중 가장 낮은 직급(비싼 상위 모델은 아껴 둔다), 그다음 일이 적은 직원.
// - 책임자: 담당자를 뺀 가장 높은 직급 직원(일을 맡기고 책임진다). 다른 직원이 없으면 담당자 본인.
// - 검수자: 담당자와 같거나 높은 직급. 다른 CLI(독립 검수) > QA 담당 > 책임자 > 일이 적은 순.
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
  | { ok: true; assigneeId: string; reviewerId: string; ownerId: string }
  | { ok: false; reason: 'too_few' | 'no_assignee_rank' | 'no_reviewer_rank' };

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
  // 검수자를 구할 수 있는 담당자만 후보로: 같거나 높은 직급의 다른 직원이 있어야 한다.
  const reviewable = eligible.filter((e) => active.some((o) => o.id !== e.id && r(o) >= r(e)));
  if (reviewable.length === 0) return { ok: false, reason: 'no_reviewer_rank' };
  const assignee = [...reviewable].sort((a, b) => Number(fits(b)) - Number(fits(a)) || r(a) - r(b) || load(a) - load(b))[0]!;

  const others = active.filter((e) => e.id !== assignee.id);
  const owner = [...others].sort(
    (a, b) =>
      r(b) - r(a) ||
      Number(b.roles.includes('chief-of-staff') || b.roles.includes('planner')) -
        Number(a.roles.includes('chief-of-staff') || a.roles.includes('planner')) ||
      load(a) - load(b),
  )[0]!;
  const ownerId = r(owner) >= r(assignee) ? owner.id : assignee.id;

  const reviewer = others
    .filter((e) => r(e) >= r(assignee))
    .sort(
      (a, b) =>
        Number(b.cli !== assignee.cli) - Number(a.cli !== assignee.cli) ||
        Number(b.roles.includes('qa')) - Number(a.roles.includes('qa')) ||
        Number(b.id === ownerId) - Number(a.id === ownerId) ||
        load(a) - load(b),
    )[0]!;
  return { ok: true, assigneeId: assignee.id, reviewerId: reviewer.id, ownerId };
}

// 직급 기반 배정: 어려운 업무는 높은 직급, 일은 감당할 수 있는 가장 낮은 직급이, 검수는 같거나 높은 직급이.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickStaff } from '../../src/core/staffing.ts';
import type { Employee, Rank, RoleTemplate, CliKind } from '../../src/core/types.ts';

let n = 0;
function emp(rank: Rank, roles: RoleTemplate[], cli: CliKind = 'claude', name = `E${++n}`): Employee {
  return {
    id: name,
    name,
    roles,
    rank,
    cli,
    model: null,
    accessLevel: 'write-ask',
    allowedCommands: [],
    active: true,
    createdAt: '2026-09-29T00:00:00Z',
  };
}
const noLoad = () => 0;

test('보통 업무: 선임 이상 중 가장 낮은 직급이 담당, 책임자는 최고 직급', () => {
  const lead = emp('lead', ['implementer', 'planner'], 'claude', 'lead');
  const senior = emp('senior', ['implementer'], 'codex', 'senior');
  const junior = emp('junior', ['implementer'], 'agy', 'junior');
  const r = pickStaff({ type: 'impl', difficulty: 'normal' }, [lead, senior, junior], noLoad);
  assert.ok(r.ok);
  assert.equal(r.assigneeId, 'senior', '사원은 보통 업무를 못 맡고, 팀장은 아껴 둔다');
  assert.equal(r.ownerId, 'lead');
  assert.notEqual(r.reviewerId, 'junior', '검수자는 담당자보다 낮은 직급일 수 없다');
});

test('쉬운 업무는 사원이 하고, 책임자인 팀장이 검수한다(다른 CLI면 우선)', () => {
  const lead = emp('lead', ['planner'], 'codex', 'lead');
  const junior = emp('junior', ['implementer'], 'claude', 'junior');
  const r = pickStaff({ type: 'impl', difficulty: 'easy' }, [lead, junior], noLoad);
  assert.ok(r.ok);
  assert.equal(r.assigneeId, 'junior');
  assert.equal(r.reviewerId, 'lead');
  assert.equal(r.ownerId, 'lead');
});

test('어려운 업무를 맡을 팀장이 없으면 배정하지 않고 사유를 돌려준다', () => {
  const r = pickStaff({ type: 'impl', difficulty: 'hard' }, [emp('senior', ['implementer']), emp('senior', ['qa'])], noLoad);
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.reason, 'no_assignee_rank');
});

test('담당자보다 같거나 높은 직급의 검수자가 없으면 배정하지 않는다', () => {
  // 팀장 한 명만 어려운 업무를 할 수 있고, 나머지는 모두 낮은 직급
  const r = pickStaff({ type: 'impl', difficulty: 'hard' }, [emp('lead', ['implementer']), emp('junior', ['qa'])], noLoad);
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.reason, 'no_reviewer_rank');
});

test('검수자 선택: 같은/높은 직급 중 다른 CLI > QA 담당 > 책임자 순으로 우선', () => {
  const junior = emp('junior', ['implementer'], 'claude', 'junior');
  const sameCliQa = emp('senior', ['qa'], 'claude', 'sameCliQa');
  const otherCli = emp('senior', ['recorder'], 'codex', 'otherCli');
  const r = pickStaff({ type: 'impl', difficulty: 'easy' }, [junior, sameCliQa, otherCli], noLoad);
  assert.ok(r.ok);
  assert.equal(r.reviewerId, 'otherCli', '독립 검수(다른 CLI)가 역할보다 우선');
});

test('같은 직급이면 담당 업무가 맞는 직원, 그다음 일이 적은 직원', () => {
  const busy = emp('senior', ['implementer'], 'claude', 'busy');
  const free = emp('senior', ['implementer'], 'claude', 'free');
  const docs = emp('senior', ['recorder'], 'codex', 'docs');
  const load = (e: Employee) => (e.id === 'busy' ? 3 : 0);
  const r = pickStaff({ type: 'impl', difficulty: 'normal' }, [busy, docs, free], load);
  assert.ok(r.ok);
  assert.equal(r.assigneeId, 'free');
});

test('직급이 없는 예전 직원은 선임으로 본다', () => {
  const legacy = { ...emp('senior', ['implementer'], 'claude', 'legacy'), rank: undefined } as unknown as Employee;
  const qa = emp('senior', ['qa'], 'codex', 'qa');
  const r = pickStaff({ type: 'impl', difficulty: undefined }, [legacy, qa], noLoad);
  assert.ok(r.ok);
  assert.equal(r.assigneeId, 'legacy');
  assert.equal(r.reviewerId, 'qa');
});

test('직원이 두 명 미만이면 배정하지 않는다', () => {
  const r = pickStaff({ type: 'impl', difficulty: 'easy' }, [emp('lead', ['implementer'])], noLoad);
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.reason, 'too_few');
});

test('담당 업무가 맞는 직원이 직급보다 먼저: 검토 업무는 구현 담당 선임보다 QA 담당 팀장에게', () => {
  const senior = emp('senior', ['implementer'], 'claude', 'implSenior');
  const leadQa = emp('lead', ['qa'], 'codex', 'leadQa');
  const leadPlan = emp('lead', ['planner'], 'claude', 'leadPlan');
  const r = pickStaff({ type: 'review', difficulty: 'normal' }, [senior, leadQa, leadPlan], noLoad);
  assert.ok(r.ok);
  assert.ok(['leadQa', 'leadPlan'].includes(r.assigneeId));
});

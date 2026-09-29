// 직원 삭제(퇴사): 진행 중인 업무가 있으면 거부, 없으면 조직에서 빠지되 기록(이름)은 남는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newImplTicket, setup } from './helpers.ts';

test('직원 삭제: 맡은 업무가 있으면 거부하고 업무 번호를 알려 준다', { timeout: 60_000 }, async (t) => {
  const env = await setup(t);
  const [impl] = env.company.employees();
  const tk = newImplTicket(env);
  await env.orch.tick();
  await env.orch.tick();
  await env.orch.tick();
  assert.ok(env.company.requireTicket(tk.id).assigneeId, '배정됨');
  assert.throws(() => env.orch.removeEmployee(impl!.id), new RegExp(tk.id));
  env.orch.cancel(tk.id, 'x');
  await env.orch.idle();
  const removed = env.orch.removeEmployee(impl!.id);
  assert.ok(removed.removedAt);
  assert.equal(removed.active, false);
  assert.ok(
    env.company.employees().some((e) => e.id === impl!.id),
    '기록용으로 남는다(업무 화면의 이름)',
  );
  assert.ok(!env.company.activeEmployees().some((e) => e.id === impl!.id));
  assert.throws(() => env.company.setEmployeeActive(impl!.id, true), /삭제|removed/i, '다시 활성화할 수 없다');
  assert.throws(() => env.orch.removeEmployee(impl!.id), /이미|already/i);
});

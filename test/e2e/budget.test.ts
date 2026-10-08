// 직원별 월 예산(Paperclip처럼): 넘으면 하던 실행은 마치고 다음 실행은 멈춘 뒤 대표에게 알린다. 한도를 올리면 이어서 한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { driveUntil, newImplTicket, setup } from './helpers.ts';

test('월 예산을 넘은 직원은 하던 실행만 마치고 멈추며, 대표가 한도를 올리면 이어서 한다', { timeout: 240_000 }, async (t) => {
  const env = await setup(t, { implementer: 'lazy' }); // 1회차는 변경 없이 "완료" → 2회차가 필요하다
  const dev = env.company.employees().find((e) => e.model === 'lazy')!;
  env.orch.setEmployeeMonthlyLimit(dev.id, 1); // 첫 실행이 끝나면 바로 넘는다
  const tk = newImplTicket(env);
  const held = await driveUntil(env, tk.id, (x) => x.hold !== null || x.status === 'awaiting_approval', 150_000);
  assert.equal(held.hold?.reason, 'usage_limit', `상태: ${held.status}`);
  assert.match(held.hold!.note, /이번 달 토큰 예산/);
  // 1회차 실행은 끝까지 했다(중간에 끊지 않음), 2회차는 시작하지 않았다
  const works = env.orch.records.runsForTicket(tk.id).filter((r) => r.kind === 'work');
  assert.equal(works.length, 1);
  assert.equal(works[0]!.status, 'succeeded');
  assert.ok(env.orch.monthBudget(env.company.requireEmployee(dev.id))!.used >= 1);
  // 대표에게 한 번만 알린다
  for (let i = 0; i < 3; i++) await env.orch.tick();
  const notices = env.orch.desk.notices().filter((n) => n.title.includes(dev.name) && n.title.includes('예산'));
  assert.equal(notices.length, 1);
  // 한도를 올리면 바로 이어서 한다
  env.orch.setEmployeeMonthlyLimit(dev.id, 0);
  const done = await driveUntil(
    env,
    tk.id,
    (x) => x.status === 'awaiting_approval' || (x.hold !== null && x.hold.reason !== 'usage_limit'),
    150_000,
  );
  assert.equal(done.status, 'awaiting_approval', `보류: ${done.hold?.note ?? ''}`);
  assert.equal(done.round, 2);
});

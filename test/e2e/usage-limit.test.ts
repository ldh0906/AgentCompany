// 사용량 한도: 보류하되 실행 예산은 쓰지 않고, 30분 뒤 스스로 다시 시도한다(대표가 한도 풀림을 가늠해 재개하지 않아도 되게).
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { USAGE_RETRY_MS } from '../../src/app/orchestrator.ts';
import { driveUntil, newImplTicket, setup, statusIs } from './helpers.ts';

test('사용량 한도로 멈춘 업무는 예산을 돌려받고 30분 뒤 스스로 다시 시도해 끝까지 간다', async (t) => {
  const env = await setup(t, { implementer: 'limited' });
  const tk = newImplTicket(env);
  const held = await driveUntil(env, tk.id, (x) => x.hold?.reason === 'usage_limit');
  assert.equal(held.runCount, 0, '일을 못 한 실행은 예산에서 빼지 않는다');
  assert.match(held.hold!.note, /30분마다 스스로 다시 시도/);

  // 29분 뒤엔 아직 그대로, 30분이 지나면 스스로 풀려 다시 일한다.
  mock.timers.enable({ apis: ['Date'], now: Date.now() + USAGE_RETRY_MS - 60_000 });
  t.after(() => mock.timers.reset());
  await env.orch.tick();
  assert.equal(env.company.requireTicket(tk.id).hold?.reason, 'usage_limit');
  mock.timers.setTime(Date.now() + 2 * 60_000);
  const done = await driveUntil(env, tk.id, statusIs('awaiting_approval'));
  assert.equal(done.hold, null);
  assert.equal(done.runCount, 1);
});

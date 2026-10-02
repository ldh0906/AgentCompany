// 요청 단위 V모델: 업무가 다 끝나면 인수 시험 → 떨어진 항목은 고칠 업무 → 끝나면 다시 시험(대표 요청 2026-10-02).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requestTokens } from '../../src/app/cost.ts';
import { setup } from './helpers.ts';

test('인수 시험: 1회차에서 떨어진 항목은 고칠 업무가 되고, 그 업무가 끝나면 2회차로 통과한다', { timeout: 420_000 }, async (t) => {
  const env = await setup(t, { integrationMode: 'auto_after_approval' });
  env.company.hireEmployee({ name: '팀장', roles: ['chief-of-staff'], cli: 'fake', model: 'diligent', rank: 'lead' });
  env.orch.delegation.set(true); // 승인은 위임: 루프가 대표 없이 끝까지 도는지 본다
  const req = await env.orch.submitRequest(env.projectId, '파티 해산 기능');
  await env.orch.idle();
  const deadline = Date.now() + 380_000;
  const rounds = () => env.orch.records.request(req.id)?.acceptanceRounds ?? [];
  while (!(rounds().length >= 2 && rounds()[1]!.state === 'done')) {
    if (Date.now() > deadline)
      throw new Error(
        `시간 초과: ${JSON.stringify(rounds().map((r) => [r.round, r.state, r.fixTickets]))} ${env.company
          .tickets()
          .map((x) => `${x.id}:${x.status}:${x.hold?.reason ?? ''}`)
          .join(' ')}`,
      );
    await env.orch.tick();
    await new Promise((r) => setTimeout(r, 50));
  }
  const accepted = env.orch.records.request(req.id)!;
  assert.equal(accepted.acceptance?.length, 2, '비서실장이 초안 때 정한 인수 시험');
  const [r1, r2] = rounds();
  assert.deepEqual(
    r1!.results.map((r) => r.mark),
    ['✅', '⚠'],
  );
  assert.equal(r1!.fixTickets.length, 1, '떨어진 항목마다 고칠 업무');
  const fix = env.company.requireTicket(r1!.fixTickets[0]!);
  assert.match(fix.title, /^\[인수 1\]/);
  assert.ok(accepted.ticketIds.includes(fix.id), '고칠 업무가 요청에 붙는다');
  assert.equal(fix.status, 'done');
  assert.deepEqual(
    r2!.results.map((r) => r.mark),
    ['✅', '✅'],
  );
  assert.equal(r2!.fixTickets.length, 0);
  // 인수 시험 방에 든 토큰도 요청 비용에 들어간다
  assert.ok('acceptance' in requestTokens(env.orch.records, accepted).byTicket);
});

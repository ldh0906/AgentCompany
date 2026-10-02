// 낡은 승인 요청: 대표가 승인해 끝난 업무에 승인 요청이 다시 생기거나 남지 않는다.
// 실측(2026-10-02, 식단 T-52): 정기 점검이 6초 전 "승인 대기" 목록으로 판단해, 막 승인한 업무에 새 승인 요청을 만들었다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { driveUntil, newImplTicket, setup, statusIs } from './helpers.ts';

test('끝난 업무에 남은 반영 승인 요청은 정기 점검이 만료한다', { timeout: 180_000 }, async (t) => {
  const env = await setup(t);
  const tk = newImplTicket(env);
  await driveUntil(env, tk.id, statusIs('awaiting_approval'), 120_000);
  env.orch.decideIntegration(env.orch.records.pendingApprovalFor(tk.id, 'integrate')!.id, 'approved');
  await driveUntil(env, tk.id, statusIs('done'), 60_000);
  // 낡은 상태로 만든 것과 같은 승인 요청
  const stale = env.orch.records.createApproval({
    kind: 'integrate',
    ticketId: tk.id,
    subject: 'stale',
    summary: `${tk.id} 낡은 승인 요청`,
    detail: {},
    requestedBy: 'orchestrator',
  });
  await env.orch.tick();
  assert.equal(env.orch.records.pendingApprovalFor(tk.id, 'integrate'), null);
  assert.equal(env.orch.records.approvals().find((a) => a.id === stale.id)?.state, 'expired');
});

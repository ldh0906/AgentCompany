import { test } from 'node:test';
import assert from 'node:assert/strict';
import { driveUntil, setup, statusIs } from './helpers.ts';

test('검토형 업무: 블라인드 분석 → 교차 판정(작성자 제외) → 재답변 필수 → 코드 종합, 미해결은 대표에게', { timeout: 240_000 }, async (t) => {
  const env = await setup(t, { implementer: 'diligent', reviewer: 'lazy' });
  env.company.hireEmployee({ name: '분석 3', roles: ['architect'], cli: 'fake', model: 'diligent' });
  const ticket = env.company.createTicket({
    projectId: env.projectId,
    type: 'review',
    title: '설계 문서 충돌 검토',
    purpose: '파티 규칙 문서의 빈칸과 충돌을 찾는다',
    requirements: [{ text: '구현자가 임의로 정해야 하는 빈칸', evidenceType: 'inspection' }],
    doneCriteria: '미해결 이견은 대표에게 상신',
  });
  const done = await driveUntil(env, ticket.id, (x) => x.status === 'awaiting_approval' || x.hold !== null, 200_000);
  assert.equal(done.status, 'awaiting_approval', `보류: ${done.hold?.note}`);

  const claims = env.orch.records.claimsFor(ticket.id);
  assert.equal(claims.length, 6, '참여자 3명 × 주장 2개');
  for (const c of claims) {
    assert.ok(c.reviewerId && c.reviewerId !== c.authorId, '작성자는 자기 주장을 판정하지 않음');
    assert.ok(c.verdict, '모든 주장이 판정됨');
    if (c.verdict !== 'agree') assert.ok(c.response, '이견이 난 모든 주장에 원 작성자가 답함');
  }
  const escalated = claims.filter((c) => c.status === 'escalated');
  const lazy = env.company.employees().find((e) => e.model === 'lazy')!;
  assert.ok(escalated.length > 0, '유지된 이견은 삭제되지 않고 상신');
  assert.ok(escalated.every((c) => c.authorId === lazy.id && c.response === 'keep'));

  // 블라인드: 첫 분석 실행 프롬프트에는 다른 직원의 주장이 없다
  const blindRuns = env.orch.records.runsForTicket(ticket.id).filter((r) => r.phase === 'blind');
  assert.equal(blindRuns.length, 3);

  const approval = env.orch.records.pendingApprovalFor(ticket.id, 'integrate')!;
  assert.match(approval.summary, /미해결 \d+개/);
  env.orch.decideIntegration(approval.id, 'approved');
  const fin = await driveUntil(env, ticket.id, statusIs('done', 'failed'));
  assert.equal(fin.status, 'done');
});

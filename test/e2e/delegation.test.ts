// 전권 위임 모드: 대표 할 일을 최고 직급 직원이 대신 처리하고 모두 기록한다(대표 요청 2026-10-02).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { driveUntil, newImplTicket, setup, statusIs } from './helpers.ts';

test('위임: 초안을 제안대로 확정하고, 검수를 통과한 업무를 승인해 반영한다', { timeout: 240_000 }, async (t) => {
  const env = await setup(t);
  env.company.hireEmployee({ name: '팀장', roles: ['chief-of-staff'], cli: 'fake', model: 'diligent', rank: 'lead' });
  env.orch.delegation.set(true);
  assert.equal(env.orch.delegation.delegate()?.name, '팀장', '최고 직급(같으면 비서실장)');
  const req = await env.orch.submitRequest(env.projectId, '파티 해산 기능');
  await env.orch.idle();
  await env.orch.tick();
  const accepted = env.orch.records.request(req.id)!;
  assert.equal(accepted.status, 'accepted', '대표 없이 확정');
  const first = accepted.ticketIds[0]!;
  const done = await driveUntil(env, first, (x) => x.status === 'done' || x.hold !== null, 150_000);
  assert.equal(done.status, 'done', `보류: ${done.hold?.note}`);
  const approval = env.orch.records.approvals().find((a) => a.ticketId === first && a.kind === 'integrate' && a.state !== 'expired');
  const decided = env.company.store.events(approval!.id).find((e) => e.type === 'approval.approved');
  assert.match(String(decided?.actor ?? ''), /^delegate:/, '승인한 사람이 위임받은 직원으로 남는다');
  assert.ok(env.orch.delegation.recent().some((x) => x.text.includes('초안을 확정')));
  assert.ok(env.orch.delegation.recent().some((x) => x.text.includes(`${first}`) && x.text.includes('승인')));
});

test('위임: 직원이 묻고 멈추면 팀장이 판단해 답하고, 답은 규칙으로 남아 업무가 이어진다', { timeout: 240_000 }, async (t) => {
  const env = await setup(t, { implementer: 'asker' });
  env.company.hireEmployee({ name: '팀장', roles: ['planner'], cli: 'fake', model: 'diligent', rank: 'lead' });
  env.orch.delegation.set(true);
  const tk = newImplTicket(env);
  const w = await driveUntil(
    env,
    tk.id,
    (x) => x.status === 'awaiting_approval' || x.status === 'done' || x.hold?.reason === 'usage_limit',
    180_000,
  );
  assert.ok(['awaiting_approval', 'done'].includes(w.status), `상태: ${w.status} ${w.hold?.note ?? ''}`);
  assert.ok(env.orch.records.decisions(env.projectId, 'current').some((d) => d.text.includes('시작 레벨은 1')));
  assert.ok(env.orch.delegation.recent().some((x) => x.text.includes('질문에 답하고 재개')));
});

test('위임: 대표 직접 확인 항목은 자동 점검이 없으면 승인하되 대표 "나중에 확인"으로 남긴다', { timeout: 240_000 }, async (t) => {
  const env = await setup(t);
  const tk = env.company.createTicket({
    projectId: env.projectId,
    type: 'impl',
    title: '버튼 색',
    purpose: '눈에 띄게',
    requirements: [
      { text: '버전 문자열 함수', evidenceType: 'unit_test' },
      { text: '버튼이 파랗게 보인다', evidenceType: 'human_attest' },
    ],
    doneCriteria: 'd',
    writeScope: ['src/**'],
  });
  await driveUntil(env, tk.id, statusIs('awaiting_approval'), 150_000);
  env.orch.delegation.set(true);
  const done = await driveUntil(env, tk.id, statusIs('done'), 60_000);
  assert.equal(done.status, 'done');
  assert.deepEqual(
    env.orch.laterChecks(tk.id).map((x) => x.id),
    ['R2'],
  );
});

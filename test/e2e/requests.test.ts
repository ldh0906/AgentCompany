import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { driveUntil, setup, statusIs } from './helpers.ts';

test('대표 요청 → 비서실장 초안(읽기 전용) → 대표 확정 → 선행 관계를 지키며 진행', { timeout: 240_000 }, async (t) => {
  const env = await setup(t);
  env.company.hireEmployee({ name: '비서실장', roles: ['chief-of-staff', 'recorder'], cli: 'fake', model: 'diligent' });
  const req = await env.orch.submitRequest(env.projectId, '파티 해산 기능');
  await env.orch.idle();
  const drafted = env.orch.records.request(req.id)!;
  assert.equal(drafted.status, 'drafted', drafted.error ?? '');
  assert.equal(drafted.drafts.length, 2);
  assert.equal(env.company.tickets().length, 0, '초안 단계에서는 티켓이 만들어지지 않음');

  const [impl, doc] = env.orch.acceptRequest(req.id);
  assert.deepEqual(doc!.dependsOn, [impl!.id]);
  assert.equal(doc!.requesterId, 'ceo', '티켓은 대표 명의');

  // 선행 업무가 끝나기 전에는 문서 업무가 시작되지 않는다
  await driveUntil(env, impl!.id, statusIs('awaiting_approval'));
  assert.notEqual(env.company.requireTicket(doc!.id).status, 'in_progress');
  env.orch.decideIntegration(env.orch.records.pendingApprovalFor(impl!.id, 'integrate')!.id, 'approved');
  await driveUntil(env, impl!.id, statusIs('done'));
  const d = await driveUntil(
    env,
    doc!.id,
    (x) => x.status === 'awaiting_approval' || (x.hold !== null && x.hold.reason !== 'waiting_dependency'),
    120_000,
  );
  assert.equal(d.status, 'awaiting_approval', `보류: ${d.hold?.note}`);
});

test('초안 난이도: 비서실장이 제안하고, 대표가 확정 전에 바꿀 수 있음', { timeout: 120_000 }, async (t) => {
  const env = await setup(t);
  env.company.hireEmployee({ name: '비서실장', roles: ['chief-of-staff', 'recorder'], cli: 'fake', model: 'diligent' });
  const req = await env.orch.submitRequest(env.projectId, '파티 해산 기능');
  await env.orch.idle();
  const drafted = env.orch.records.request(req.id)!;
  assert.deepEqual(
    drafted.drafts.map((d) => d.difficulty),
    ['normal', 'easy'],
    '비서실장이 초안마다 난이도를 제안',
  );
  // 대표가 첫 초안을 쉬움으로 바꾸고, 잘못된 값은 보통으로 정리된다
  const edited = drafted.drafts.map((d, i) => ({ ...d, difficulty: i === 0 ? 'easy' : 'extreme' })) as typeof drafted.drafts;
  const [a, b] = env.orch.acceptRequest(req.id, edited);
  assert.equal(a!.difficulty, 'easy');
  assert.equal(b!.difficulty, 'normal');
});

test('비서실장이 없으면 요청을 거부하고 직접 업무를 만들라고 안내', { timeout: 60_000 }, async (t) => {
  const env = await setup(t);
  await assert.rejects(env.orch.submitRequest(env.projectId, 'x'), /비서실장/);
});

test('초안 작성 중인 요청을 버리면 비서실장 실행을 끊고, 끝난 실행이 요청을 되살리지 않는다', { timeout: 60_000 }, async (t) => {
  const env = await setup(t);
  env.company.hireEmployee({ name: '비서실장', roles: ['chief-of-staff'], cli: 'fake', model: 'slow' });
  const req = await env.orch.submitRequest(env.projectId, '파티 해산 기능');
  const run = env.orch.records.runsForTicket(req.id).find((r) => r.status === 'running');
  assert.ok(run, '초안 실행이 돌고 있다');
  // 프로세스가 pid를 남길 때까지 잠깐 기다린다
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && !existsSync(join(run.runDir, 'pid.json'))) await new Promise((r) => setTimeout(r, 100));
  await env.orch.stopRun(run.id);
  await env.orch.idle();
  const after = env.orch.records.request(req.id)!;
  assert.equal(after.status, 'dismissed');
  assert.equal(after.drafts.length, 0, '초안이 붙지 않는다');
  assert.notEqual(env.orch.records.run(run.id)!.status, 'running');
});

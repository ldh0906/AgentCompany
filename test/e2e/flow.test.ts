import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gitOut, git } from '../../src/workspace/git.ts';
import { driveUntil, newImplTicket, setup, statusIs } from './helpers.ts';

test('정상 흐름: 작업 → 검증 증거 → 독립 검수 → 대표 승인 → 원본에 브랜치 반영', { timeout: 120_000 }, async (t) => {
  const env = await setup(t);
  const mainBefore = await gitOut(['rev-parse', 'main'], env.origin);
  const ticket = newImplTicket(env);

  const waiting = await driveUntil(env, ticket.id, (x) => x.status === 'awaiting_approval' || x.hold !== null);
  assert.equal(waiting.status, 'awaiting_approval', `보류: ${waiting.hold?.note}`);
  assert.notEqual(waiting.assigneeId, waiting.reviewerId);

  const evidence = env.orch.records.evidenceFor(ticket.id);
  assert.ok(evidence.some((e) => e.type === 'unit_test' && e.passed), '오케스트레이터가 만든 단위 테스트 증거');
  // 반영 전에는 원본 저장소가 그대로
  assert.equal(await gitOut(['rev-parse', 'main'], env.origin), mainBefore);
  assert.equal((await git(['branch', '--list', 'ac/*'], env.origin)).stdout.trim(), '');

  const approval = env.orch.records.pendingApprovalFor(ticket.id, 'integrate');
  assert.ok(approval);
  env.orch.decideIntegration(approval!.id, 'approved');
  const done = await driveUntil(env, ticket.id, statusIs('done', 'failed'));
  assert.equal(done.status, 'done');
  assert.ok((await gitOut(['rev-parse', 'ac/T-1'], env.origin)).length === 40, '원본에 ac/T-1 브랜치');
  assert.equal(await gitOut(['rev-parse', 'main'], env.origin), mainBefore, 'manual 모드는 main을 건드리지 않음');
  assert.equal(env.store.verifyEventChain().ok, true);
});

test('게으른 직원: 변경 없이 "완료" 주장 → 시스템 검증에서 거부 → 2회차에 실제 작업', { timeout: 120_000 }, async (t) => {
  const env = await setup(t, { implementer: 'lazy' });
  const ticket = newImplTicket(env);
  const waiting = await driveUntil(env, ticket.id, (x) => x.status === 'awaiting_approval' || x.hold !== null);
  assert.equal(waiting.status, 'awaiting_approval', `보류: ${waiting.hold?.note}`);
  assert.equal(waiting.round, 2);
  const rejected = env.store.events(ticket.id).find((e) => e.type === 'ticket.changes_requested');
  assert.match(String((rejected?.payload as { reason: string }).reason), /변경된 파일이 없습니다/);
});

test('범위 밖 수정(보호 경로 README.md) → 결과 격리, 대표 권한 승인 보류', { timeout: 120_000 }, async (t) => {
  const env = await setup(t, { implementer: 'rogue' });
  const ticket = newImplTicket(env);
  const held = await driveUntil(env, ticket.id, (x) => x.hold !== null);
  assert.equal(held.status, 'verifying');
  assert.equal(held.hold?.reason, 'needs_permission');
  assert.match(held.hold!.note, /README\.md/);
  assert.equal((await git(['status', '--porcelain'], env.origin)).stdout.trim(), '', '원본은 그대로');
});

test('검증 명령이 계속 실패하면 회차 한도 후 성공 처리 없이 대표 결정 보류', { timeout: 180_000 }, async (t) => {
  const env = await setup(t, { verify: [{ label: 'always fails', argv: ['node', '-e', 'console.error("테스트 실패"); process.exit(1)'], evidenceType: 'unit_test' }] });
  const ticket = newImplTicket(env);
  const held = await driveUntil(env, ticket.id, (x) => x.hold !== null, 150_000);
  assert.equal(held.status, 'changes_requested');
  assert.equal(held.hold?.reason, 'needs_decision');
  assert.notEqual(held.status, 'done');
});

test('auto_after_approval: 승인 후 원본 main이 병합 커밋으로 fast-forward', { timeout: 120_000 }, async (t) => {
  const env = await setup(t, { integrationMode: 'auto_after_approval' });
  const ticket = newImplTicket(env);
  await driveUntil(env, ticket.id, statusIs('awaiting_approval'));
  const approval = env.orch.records.pendingApprovalFor(ticket.id, 'integrate')!;
  env.orch.decideIntegration(approval.id, 'approved');
  const done = await driveUntil(env, ticket.id, statusIs('done', 'failed'));
  assert.equal(done.status, 'done');
  const log = await gitOut(['log', '--oneline', '-3', 'main'], env.origin);
  assert.match(log, /T-1: 버전 표시 기능/);
  assert.match((await git(['ls-tree', '-r', '--name-only', 'main'], env.origin)).stdout, /agent-company-demo/);
});

test('대표 반려 → 수정 요청으로 돌아가 다음 회차 진행', { timeout: 120_000 }, async (t) => {
  const env = await setup(t);
  const ticket = newImplTicket(env);
  await driveUntil(env, ticket.id, statusIs('awaiting_approval'));
  const approval = env.orch.records.pendingApprovalFor(ticket.id, 'integrate')!;
  const back = env.orch.decideIntegration(approval.id, 'rejected', { reason: '문구를 더 짧게' });
  assert.equal(back.status, 'changes_requested');
  const again = await driveUntil(env, ticket.id, statusIs('awaiting_approval'));
  assert.equal(again.round, 2);
});

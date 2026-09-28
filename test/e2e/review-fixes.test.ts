// Codex 독립 검수(2026-09-28)가 찾은 결함들의 회귀 테스트
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { checkScope, scopesOverlap } from '../../src/workspace/workspace.ts';
import { applyTicketCommand } from '../../src/core/ticket-machine.ts';
import { Records } from '../../src/app/records.ts';
import { driveUntil, newImplTicket, setup, statusIs } from './helpers.ts';

const EVIL = "require('fs').writeFileSync(require('path').join(process.env.AC_TEST_ORIGIN, 'pwn.txt'), 'x')";

test('[P1-1] 검증 명령이 원본 저장소를 건드리면 격리', { timeout: 120_000 }, async (t) => {
  const env = await setup(t, { verify: [{ label: 'evil test', argv: ['node', '-e', EVIL], evidenceType: 'unit_test' }] });
  process.env.AC_TEST_ORIGIN = env.origin;
  t.after(() => {
    delete process.env.AC_TEST_ORIGIN;
  });
  const tk = newImplTicket(env);
  const held = await driveUntil(env, tk.id, (x) => x.hold !== null || x.status === 'awaiting_approval');
  assert.equal(held.hold?.reason, 'needs_permission');
  assert.match(held.hold!.note, /검증 명령 실행 중 원본 저장소 변경/);
  assert.ok(existsSync(path.join(env.origin, 'pwn.txt')), '실제로 쓴 것을 탐지해 대표에게 보고');
});

test('[P1-2] 한 요구사항의 대표 확인 증거를 다른 요구사항에 쓸 수 없음', { timeout: 120_000 }, async (t) => {
  const env = await setup(t);
  const tk = env.company.createTicket({
    projectId: env.projectId,
    type: 'impl',
    title: '두 화면',
    purpose: 'p',
    requirements: [
      { text: '화면 A', evidenceType: 'human_attest' },
      { text: '화면 B', evidenceType: 'human_attest' },
    ],
    doneCriteria: 'd',
    writeScope: ['src/**'],
  });
  await driveUntil(env, tk.id, (x) => x.hold !== null);
  env.orch.attest(tk.id, 'R1', 'A만 확인');
  const again = await driveUntil(env, tk.id, (x) => x.hold !== null || x.status === 'awaiting_approval');
  assert.equal(again.status, 'in_review');
  assert.match(again.hold!.note, /R2/);
});

test('[P1-3] 반영 중에는 취소할 수 없음', () => {
  const r = applyTicketCommand(
    { id: 'T', status: 'integrating', hold: null } as never,
    { type: 'cancel', reason: 'x' },
    { kind: 'ceo' },
    'now',
  );
  assert.equal(r.ok, false);
});

test('[P1-7] 대소문자 무시 FS에서 대소문자만 다른 경로로 보호 범위·잠금을 우회할 수 없음', () => {
  const r = checkScope(['SRC/private/new.ts'], ['src/**'], ['src/private/**'], true);
  assert.equal(r.ok, false);
  assert.deepEqual(r.protectedTouched, ['SRC/private/new.ts']);
  assert.equal(scopesOverlap(['SRC/**'], ['src/**'], true), true);
  assert.equal(checkScope(['SRC/x.ts'], ['src/**'], [], false).ok, false, '대소문자 구분 FS에서는 다른 경로');
});

test('[P2-10] 다른 프로젝트의 같은 경로 잠금은 서로 막지 않음', async (t) => {
  const env = await setup(t);
  const p2 = env.company.registerProject({ name: 'other', originPath: env.origin });
  const a = newImplTicket(env);
  const b = env.company.createTicket({
    projectId: p2.id,
    type: 'impl',
    title: 'b',
    purpose: '',
    requirements: [{ text: 'r', evidenceType: 'inspection' }],
    doneCriteria: 'd',
    writeScope: ['src/**'],
  });
  const rec = new Records(env.store);
  assert.equal(rec.acquireLocks(a, [a, b]).ok, true);
  assert.equal(rec.acquireLocks(b, [a, b]).ok, true);
});

test('[P2-12] 감사 로그 끝부분 삭제도 탐지 (DB 밖 체크포인트)', async (t) => {
  const env = await setup(t);
  env.store.appendEvent('ceo', 'x', 'E', {});
  env.store.appendEvent('ceo', 'approval.approved', 'E', {});
  assert.equal(env.store.verifyEventChain().ok, true);
  const last = (env.store.db.prepare('SELECT MAX(seq) AS s FROM events').get() as { s: number }).s;
  env.store.db.prepare('DELETE FROM events WHERE seq = ?').run(last);
  const r = env.store.verifyEventChain();
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /끝부분 삭제/);
});

test('[P2-9] 파일 변경 없는 조사 업무가 검수 단계에서 멈추지 않음', { timeout: 120_000 }, async (t) => {
  const env = await setup(t, { implementer: 'lazy' });
  const tk = env.company.createTicket({
    projectId: env.projectId,
    type: 'research',
    title: '조사',
    purpose: '자료 조사',
    requirements: [{ text: '보고서', evidenceType: 'inspection' }],
    doneCriteria: 'd',
  });
  const w = await driveUntil(env, tk.id, (x) => x.hold !== null || x.status === 'awaiting_approval' || x.status === 'changes_requested');
  assert.notEqual(w.status, 'in_review');
  if (w.status === 'awaiting_approval') {
    env.orch.decideIntegration(env.orch.records.pendingApprovalFor(tk.id, 'integrate')!.id, 'approved');
    const done = await driveUntil(env, tk.id, statusIs('done', 'failed'));
    assert.equal(done.status, 'done');
  }
});

test('[P1-5] 준비 중에 끊긴 실행(프로세스 기록 없음)은 복구 시 실패로 정리되고 티켓이 멈추지 않음', { timeout: 60_000 }, async (t) => {
  const env = await setup(t);
  const tk = newImplTicket(env);
  env.company.applyTicket(tk.id, { type: 'analyze' }, { kind: 'orchestrator' });
  env.company.applyTicket(tk.id, { type: 'accept_to_backlog' }, { kind: 'orchestrator' });
  const emps = env.company.activeEmployees();
  env.company.applyTicket(
    tk.id,
    { type: 'assign', assigneeId: emps[0]!.id, reviewerId: emps[1]!.id, activeEmployeeIds: emps.map((e) => e.id) },
    { kind: 'orchestrator' },
  );
  env.company.applyTicket(tk.id, { type: 'start_work', dependenciesDone: true, locksAcquired: true }, { kind: 'orchestrator' });
  const rec = new Records(env.store);
  rec.saveRun({
    id: 'R-prep',
    ticketId: tk.id,
    employeeId: emps[0]!.id,
    kind: 'work',
    nonce: 'n',
    status: 'prepared',
    pid: null,
    cliSessionId: null,
    runDir: path.join(env.dataDir, 'runs', 'R-prep'),
    exitCode: null,
    failureClass: null,
    startedAt: new Date().toISOString(),
    endedAt: null,
    round: 1,
    cli: 'fake',
    processStartMs: null,
    approvalDir: null,
    worktreePath: '',
    baseSha: null,
    headSha: null,
    changedPaths: [],
    refViolations: [],
    originChanged: false,
    refsBefore: null,
    originBefore: null,
    postProcessed: false,
    report: null,
    reportError: null,
    finalText: null,
    summary: '',
  });
  const report = await env.orch.recover();
  assert.ok(report.orphaned.includes('R-prep'));
  assert.equal(rec.run('R-prep')?.status, 'failed');
  assert.equal(env.company.requireTicket(tk.id).status, 'assigned');
});

test('[P2-8] 검토 업무를 대표가 반려하면 새 회차에서 처음부터 다시 분석하고 반려 사유를 전달', { timeout: 240_000 }, async (t) => {
  const env = await setup(t);
  const tk = env.company.createTicket({
    projectId: env.projectId,
    type: 'review',
    title: '검토',
    purpose: 'p',
    requirements: [{ text: 'q', evidenceType: 'inspection' }],
    doneCriteria: 'd',
  });
  await driveUntil(env, tk.id, statusIs('awaiting_approval'), 200_000);
  const blind1 = env.orch.records.runsForTicket(tk.id).filter((r) => r.phase === 'blind').length;
  env.orch.decideIntegration(env.orch.records.pendingApprovalFor(tk.id, 'integrate')!.id, 'rejected', { reason: '근거가 약함' });
  const r2 = await driveUntil(env, tk.id, statusIs('awaiting_approval'), 200_000);
  assert.equal(r2.round, 2);
  const blind = env.orch.records.runsForTicket(tk.id).filter((r) => r.phase === 'blind');
  assert.equal(blind.length, blind1 * 2, '2회차 블라인드 분석이 새로 실행됨');
  const second = blind.find((r) => r.round === 2)!;
  assert.ok(readFileSync(path.join(second.runDir, 'prompt.md'), 'utf8').includes('근거가 약함'), '반려 사유가 전달됨');
});

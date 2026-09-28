import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyTicketCommand, type Actor, type TicketCommand } from '../../src/core/ticket-machine.ts';
import { DEFAULT_BUDGET, type Ticket } from '../../src/core/types.ts';

const NOW = '2026-09-28T00:00:00.000Z';
const CEO: Actor = { kind: 'ceo' };
const ORCH: Actor = { kind: 'orchestrator' };
const IMPL: Actor = { kind: 'employee', id: 'e-impl' };
const QA: Actor = { kind: 'employee', id: 'e-qa' };
const ACTIVE = ['e-impl', 'e-qa'];

function ticket(patch: Partial<Ticket> = {}): Ticket {
  return {
    id: 'T-1',
    projectId: 'P-1',
    type: 'impl',
    title: '로그인 버그 수정',
    purpose: '세션 만료 시 흰 화면',
    requesterId: 'ceo',
    assigneeId: null,
    reviewerId: null,
    priority: 2,
    status: 'received',
    hold: null,
    writeScope: ['src/auth/**'],
    readScope: ['**'],
    requirements: [{ id: 'R1', text: '만료 시 로그인으로 이동', evidenceType: 'unit_test' }],
    doneCriteria: '테스트 통과',
    round: 1,
    runCount: 0,
    budget: DEFAULT_BUDGET,
    dependsOn: [],
    createdAt: NOW,
    updatedAt: NOW,
    ...patch,
  };
}

function run(t: Ticket, steps: [TicketCommand, Actor][]): Ticket {
  let cur = t;
  for (const [cmd, actor] of steps) {
    const r = applyTicketCommand(cur, cmd, actor, NOW);
    assert.ok(r.ok, `${cmd.type} 실패: ${r.ok ? '' : r.error}`);
    cur = r.ticket;
  }
  return cur;
}

const TO_REVIEW: [TicketCommand, Actor][] = [
  [{ type: 'analyze' }, ORCH],
  [{ type: 'accept_to_backlog' }, ORCH],
  [{ type: 'assign', assigneeId: 'e-impl', reviewerId: 'e-qa', activeEmployeeIds: ACTIVE }, ORCH],
  [{ type: 'start_work', dependenciesDone: true, locksAcquired: true }, ORCH],
  [{ type: 'submit' }, ORCH],
  [{ type: 'verification_passed' }, ORCH],
];

const GOOD_CHECKS = [{ requirementId: 'R1', met: true, verifiedEvidence: ['unit_test' as const] }];

test('정상 흐름: 접수부터 완료까지', () => {
  const t = run(ticket(), [
    ...TO_REVIEW,
    [{ type: 'review_approve', checks: GOOD_CHECKS }, QA],
    [{ type: 'ceo_approve' }, CEO],
    [{ type: 'integrated', commitSha: 'abc' }, ORCH],
  ]);
  assert.equal(t.status, 'done');
  assert.equal(t.runCount, 1);
});

test('담당자와 검수자가 같으면 배정 거부', () => {
  const t = run(ticket(), TO_REVIEW.slice(0, 2));
  const r = applyTicketCommand(t, { type: 'assign', assigneeId: 'e-impl', reviewerId: 'e-impl', activeEmployeeIds: ACTIVE }, ORCH, NOW);
  assert.equal(r.ok, false);
});

test('비활성 직원은 배정할 수 없음', () => {
  const t = run(ticket(), TO_REVIEW.slice(0, 2));
  const r = applyTicketCommand(t, { type: 'assign', assigneeId: 'e-impl', reviewerId: 'e-ghost', activeEmployeeIds: ACTIVE }, ORCH, NOW);
  assert.equal(r.ok, false);
});

test('직원의 "완료했습니다"는 제출이 아니다: 직원은 submit 불가', () => {
  const t = run(ticket(), TO_REVIEW.slice(0, 4));
  const r = applyTicketCommand(t, { type: 'submit' }, IMPL, NOW);
  assert.equal(r.ok, false);
});

test('담당자는 자기 작업을 검수 승인할 수 없음', () => {
  const t = run(ticket(), TO_REVIEW);
  const r = applyTicketCommand(t, { type: 'review_approve', checks: GOOD_CHECKS }, IMPL, NOW);
  assert.equal(r.ok, false);
});

test('증거 등급이 부족하면 검수 승인 불가 (정적 검사로 단위 테스트 요구 충족 불가)', () => {
  const t = run(ticket(), TO_REVIEW);
  const r = applyTicketCommand(
    t,
    { type: 'review_approve', checks: [{ requirementId: 'R1', met: true, verifiedEvidence: ['static_check'] }] },
    QA,
    NOW,
  );
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /증거/);
});

test('요구사항 판정이 빠지면 승인 불가', () => {
  const t = run(ticket(), TO_REVIEW);
  const r = applyTicketCommand(t, { type: 'review_approve', checks: [] }, QA, NOW);
  assert.equal(r.ok, false);
});

test('최종 승인은 대표만', () => {
  const t = run(ticket(), [...TO_REVIEW, [{ type: 'review_approve', checks: GOOD_CHECKS }, QA]]);
  for (const actor of [ORCH, QA, IMPL]) {
    assert.equal(applyTicketCommand(t, { type: 'ceo_approve' }, actor, NOW).ok, false);
  }
});

test('수정 회차 초과 시 성공 처리하지 않고 대표 결정 보류', () => {
  let t = run(ticket({ budget: { ...DEFAULT_BUDGET, maxRounds: 2 } }), TO_REVIEW);
  t = run(t, [
    [{ type: 'review_request_changes', reason: '누락' }, QA],
    [{ type: 'start_work', dependenciesDone: true, locksAcquired: true }, ORCH],
    [{ type: 'submit' }, ORCH],
    [{ type: 'verification_passed' }, ORCH],
    [{ type: 'review_request_changes', reason: '여전히 누락' }, QA],
  ]);
  assert.equal(t.status, 'changes_requested');
  assert.equal(t.hold?.reason, 'needs_decision');
});

test('실행 예산 소진 시 작업 시작 대신 보류', () => {
  const t = run(ticket({ runCount: 6 }), TO_REVIEW.slice(0, 3));
  const r = applyTicketCommand(t, { type: 'start_work', dependenciesDone: true, locksAcquired: true }, ORCH, NOW);
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.ticket.status, 'assigned');
    assert.equal(r.ticket.hold?.reason, 'needs_decision');
  }
});

test('선행 업무 미완료면 대기 보류, 오케스트레이터가 해제 가능', () => {
  const t = run(ticket(), TO_REVIEW.slice(0, 3));
  const held = applyTicketCommand(t, { type: 'start_work', dependenciesDone: false, locksAcquired: true }, ORCH, NOW);
  assert.ok(held.ok);
  if (!held.ok) return;
  assert.equal(held.ticket.hold?.reason, 'waiting_dependency');
  const released = applyTicketCommand(held.ticket, { type: 'release_hold' }, ORCH, NOW);
  assert.ok(released.ok);
  if (released.ok) assert.equal(released.ticket.status, 'assigned');
});

test('실행 중단 시 배정 상태로 돌아가고 예산은 소모된 채 유지', () => {
  const t = run(ticket(), TO_REVIEW.slice(0, 4));
  const r = applyTicketCommand(
    t,
    { type: 'run_aborted', reason: '사용량 한도', hold: { reason: 'usage_limit', note: '5시간 후 재개' } },
    ORCH,
    NOW,
  );
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.ticket.status, 'assigned');
  assert.equal(r.ticket.runCount, 1);
  assert.equal(r.ticket.hold?.reason, 'usage_limit');
  assert.equal(applyTicketCommand(t, { type: 'run_aborted', reason: 'x' }, IMPL, NOW).ok, false);
});

test('경로 잠금 실패 시 작업 시작 거부', () => {
  const t = run(ticket(), TO_REVIEW.slice(0, 3));
  assert.equal(applyTicketCommand(t, { type: 'start_work', dependenciesDone: true, locksAcquired: false }, ORCH, NOW).ok, false);
});

test('범위 위반은 권한 승인 보류, 대표만 해제', () => {
  const t = run(ticket(), TO_REVIEW.slice(0, 5));
  const r = applyTicketCommand(t, { type: 'scope_violation', paths: ['../secrets.txt'] }, ORCH, NOW);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.ticket.hold?.reason, 'needs_permission');
  assert.equal(applyTicketCommand(r.ticket, { type: 'verification_passed' }, ORCH, NOW).ok, false);
  assert.equal(applyTicketCommand(r.ticket, { type: 'release_hold' }, ORCH, NOW).ok, false);
  const released = applyTicketCommand(r.ticket, { type: 'release_hold' }, CEO, NOW);
  assert.ok(released.ok);
  if (released.ok) assert.equal(released.ticket.status, 'verifying');
});

test('반영 실패 시 승인 대기로 돌아가 대표 결정 보류', () => {
  const t = run(ticket(), [
    ...TO_REVIEW,
    [{ type: 'review_approve', checks: GOOD_CHECKS }, QA],
    [{ type: 'ceo_approve' }, CEO],
    [{ type: 'integration_failed', reason: '기준 브랜치 이동' }, ORCH],
  ]);
  assert.equal(t.status, 'awaiting_approval');
  assert.equal(t.hold?.reason, 'needs_decision');
});

test('종료된 티켓은 변경 불가, 취소는 대표만', () => {
  const t = run(ticket(), TO_REVIEW.slice(0, 2));
  assert.equal(applyTicketCommand(t, { type: 'cancel', reason: 'x' }, ORCH, NOW).ok, false);
  const c = run(t, [[{ type: 'cancel', reason: '불필요' }, CEO]]);
  assert.equal(c.status, 'cancelled');
  assert.equal(applyTicketCommand(c, { type: 'analyze' }, CEO, NOW).ok, false);
});

// ---- 속성 테스트: 임의 명령 순서에서도 불변식 유지 ----

function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const ACTORS: Actor[] = [CEO, ORCH, IMPL, QA];
const COMMANDS: TicketCommand[] = [
  { type: 'analyze' },
  { type: 'accept_to_backlog' },
  { type: 'assign', assigneeId: 'e-impl', reviewerId: 'e-qa', activeEmployeeIds: ACTIVE },
  { type: 'assign', assigneeId: 'e-qa', reviewerId: 'e-qa', activeEmployeeIds: ACTIVE },
  { type: 'start_work', dependenciesDone: true, locksAcquired: true },
  { type: 'start_work', dependenciesDone: false, locksAcquired: true },
  { type: 'submit' },
  { type: 'run_aborted', reason: 'x' },
  { type: 'run_aborted', reason: 'x', hold: { reason: 'usage_limit', note: 'x' } },
  { type: 'verification_passed' },
  { type: 'verification_failed', reason: 'x' },
  { type: 'scope_violation', paths: ['x'] },
  { type: 'review_approve', checks: GOOD_CHECKS },
  { type: 'review_approve', checks: [{ requirementId: 'R1', met: true, verifiedEvidence: ['mockup'] }] },
  { type: 'review_request_changes', reason: 'x' },
  { type: 'ceo_approve' },
  { type: 'ceo_reject', reason: 'x' },
  { type: 'integrated', commitSha: 'x' },
  { type: 'integration_failed', reason: 'x' },
  { type: 'hold', reason: 'on_hold', note: 'x' },
  { type: 'hold', reason: 'usage_limit', note: 'x' },
  { type: 'release_hold' },
];

test('속성: 대표 승인 없이는 반영·완료에 도달하지 않고, 검수자는 담당자와 다르다', () => {
  for (let seed = 1; seed <= 400; seed++) {
    const rand = prng(seed);
    let t = ticket();
    let ceoApproved = false;
    let reviewApproved = false;
    for (let i = 0; i < 80; i++) {
      const cmd = COMMANDS[Math.floor(rand() * COMMANDS.length)]!;
      const actor = ACTORS[Math.floor(rand() * ACTORS.length)]!;
      const r = applyTicketCommand(t, cmd, actor, NOW);
      if (!r.ok) continue;
      if (cmd.type === 'ceo_approve') {
        assert.equal(actor.kind, 'ceo');
        assert.ok(reviewApproved, '검수 승인 없이 대표 승인 단계에 도달');
        ceoApproved = true;
      }
      if (cmd.type === 'review_approve') {
        assert.equal(actor.kind === 'employee' && actor.id, t.reviewerId);
        reviewApproved = true;
      }
      if (r.ticket.status === 'changes_requested' || r.ticket.status === 'in_progress') {
        reviewApproved = false;
        ceoApproved = false;
      }
      if (r.ticket.status === 'integrating' || r.ticket.status === 'done')
        assert.ok(ceoApproved, `seed ${seed}: 대표 승인 없이 ${r.ticket.status}`);
      if (r.ticket.assigneeId && r.ticket.reviewerId) assert.notEqual(r.ticket.assigneeId, r.ticket.reviewerId);
      if (r.ticket.hold) assert.equal(r.ticket.hold.resumeTo, r.ticket.status);
      t = r.ticket;
    }
  }
});

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

test('예산 때문에만 맡을 사람이 없으면 대표 결정 보류가 아니라 대기하고, 한도를 올리면 배정된다', { timeout: 120_000 }, async (t) => {
  const env = await setup(t);
  const [dev, qa] = env.company.employees();
  env.orch.setEmployeeMonthlyLimit(dev!.id, 1);
  // 예산을 넘긴 것처럼: 이 직원의 사용량이 있는 실행 기록
  env.orch.records.saveRun({
    id: 'R-spent',
    ticketId: 'T-x',
    employeeId: dev!.id,
    kind: 'chat',
    status: 'succeeded',
    startedAt: new Date().toISOString(),
    usage: { input: 10, cacheRead: 0, output: 10, total: 20, costUsd: null },
  } as never);
  const tk = newImplTicket(env);
  for (let i = 0; i < 5; i++) await env.orch.tick();
  const waiting = env.company.requireTicket(tk.id);
  assert.equal(waiting.status, 'backlog', '대기열에서 기다린다');
  assert.equal(waiting.hold, null, '대표만 풀 수 있는 보류에 걸지 않는다');
  assert.ok(env.store.events(tk.id).some((e) => e.type === 'ticket.waiting_budget'));
  assert.ok(env.orch.desk.notices().some((n) => n.title.includes(dev!.name)));
  void qa;
  env.orch.setEmployeeMonthlyLimit(dev!.id, 0);
  const assigned = await driveUntil(env, tk.id, (x) => x.status !== 'backlog', 30_000);
  assert.equal(assigned.assigneeId, dev!.id);
});

test(
  '예산을 넘은 직원의 실행은 어느 기능이 불러도 띄우지 않고, 30분이 지나도 예산이 풀리기 전에는 보류를 풀지 않는다',
  { timeout: 240_000 },
  async (t) => {
    const env = await setup(t, { implementer: 'lazy' });
    const dev = env.company.employees().find((e) => e.model === 'lazy')!;
    env.orch.setEmployeeMonthlyLimit(dev.id, 1);
    const tk = newImplTicket(env);
    const held = await driveUntil(env, tk.id, (x) => x.hold !== null || x.status === 'awaiting_approval', 150_000);
    assert.equal(held.hold?.reason, 'usage_limit');
    // 직접 실행을 띄우는 경로(토론·인수 시험·위임 판단 등)도 막힌다
    const launch = (env.orch as unknown as { launch: (p: unknown) => Promise<string> }).launch.bind(env.orch);
    const runId = await launch({
      ticket: { id: 'general', round: 1, budget: { runTimeoutMs: 60_000 } },
      employee: env.company.requireEmployee(dev.id),
      kind: 'chat',
      cwd: env.dataDir,
      prompt: 'x',
      nonce: 'n',
      accessLevel: 'read-only',
      baseSha: null,
    });
    const run = env.orch.records.run(runId)!;
    assert.equal(run.pid, null, '프로세스를 띄우지 않았다');
    assert.equal(run.status, 'failed');
    assert.equal(run.failureClass, 'usage_limit', '실패 원인이 기록에 남는다');
    assert.match(run.reportError ?? '', /예산/);
    // 30분 재시도 시각이 지나도(보류 시각을 과거로) 아직 예산을 넘었으면 그대로 둔다
    const cur = env.company.requireTicket(tk.id);
    const past = { ...cur, hold: { ...cur.hold!, since: new Date(Date.now() - 3_600_000).toISOString() } };
    env.store.put('tickets', tk.id, past, {
      project_id: past.projectId,
      status: past.status,
      created_at: past.createdAt,
      updated_at: past.updatedAt,
    });
    for (let i = 0; i < 3; i++) await env.orch.tick();
    assert.equal(env.company.requireTicket(tk.id).hold?.reason, 'usage_limit');
    assert.equal(env.orch.records.runsForTicket(tk.id).filter((r) => r.kind === 'work').length, 1, '새 실행 없음');
  },
);

const spend = (env: Awaited<ReturnType<typeof setup>>, employeeId: string) =>
  env.orch.records.saveRun({
    id: `R-spent-${employeeId}`,
    ticketId: 'T-x',
    employeeId,
    kind: 'chat',
    status: 'succeeded',
    startedAt: new Date().toISOString(),
    usage: { input: 10, cacheRead: 0, output: 10, total: 20, costUsd: null },
  } as never);

test(
  '전권 위임: 위임받은 직원이 예산을 다 썼으면 묻지 않고 기다리다, 한도를 올리면 그때 물어 재개한다',
  { timeout: 240_000 },
  async (t) => {
    const env = await setup(t, { implementer: 'asker' });
    const lead = env.company.hireEmployee({ name: '팀장', roles: ['planner'], cli: 'fake', model: 'diligent', rank: 'lead' });
    env.orch.setEmployeeMonthlyLimit(lead.id, 1);
    spend(env, lead.id);
    env.orch.delegation.set(true);
    const tk = newImplTicket(env);
    const held = await driveUntil(env, tk.id, (x) => x.hold?.reason === 'needs_decision', 150_000);
    for (let i = 0; i < 5; i++) await env.orch.tick();
    await env.orch.idle();
    assert.equal(env.company.requireTicket(tk.id).hold?.since, held.hold!.since, '그대로 기다린다');
    assert.equal(env.store.getSetting(`delegate_q:${tk.id}`) ?? '', '', '"물어봄" 표시를 남기지 않는다');
    assert.ok(!env.orch.records.recentRuns(50).some((r) => r.employeeId === lead.id && r.id !== `R-spent-${lead.id}`));
    // 한도를 올리면 다음 단계에 물어 답하고 재개한다
    env.orch.setEmployeeMonthlyLimit(lead.id, 0);
    await driveUntil(env, tk.id, (x) => x.hold === null || x.status === 'awaiting_approval', 150_000);
    assert.ok(env.orch.delegation.recent().some((x) => x.text.includes('질문에 답하고 재개')));
  },
);

test('위임 중이어도 추천이 없는 결정 대기 토론(요약 실패 등)은 대표 할 일에 보인다', { timeout: 60_000 }, async (t) => {
  const env = await setup(t);
  env.orch.delegation.set(true);
  const base = {
    channelId: 'g:x',
    context: '',
    origin: 'ceo',
    projectId: null,
    ticketId: null,
    requestId: null,
    participants: [],
    moderator: 'E-x',
    phase: 'decide',
    runs: {},
    positions: {},
    rebuttals: {},
    summary: null,
    options: [],
    dissent: '',
    decision: null,
    decidedBy: null,
    createdAt: new Date().toISOString(),
  };
  env.store.setSetting('debate:D-norec', JSON.stringify({ ...base, id: 'D-norec', topic: '추천 없는 토론', recommendation: null }));
  env.store.setSetting(
    'debate:D-rec',
    JSON.stringify({
      ...base,
      id: 'D-rec',
      topic: '추천 있는 토론',
      recommendation: 0,
      options: [{ title: 'A', supporters: [], pros: [], cons: [], decision: 'A' }],
    }),
  );
  env.store.setSetting('debate_index', JSON.stringify(['D-norec', 'D-rec']));
  const titles = env.orch.desk.ceoTodos().map((x) => x.title);
  assert.ok(
    titles.some((x) => x.includes('추천 없는 토론')),
    '위임자가 결정할 수 없으니 대표에게',
  );
  assert.ok(!titles.some((x) => x.includes('추천 있는 토론')), '추천이 있으면 위임자가 결정한다');
});

test('전권 위임: 위임 질문이 계속 실패하면 두 번까지만 다시 묻고 멈춘다(매 주기 실행이 쌓이지 않게)', { timeout: 240_000 }, async (t) => {
  const env = await setup(t, { implementer: 'asker' });
  const lead = env.company.hireEmployee({ name: '팀장', roles: ['planner'], cli: 'fake', model: 'mute', rank: 'lead' });
  env.orch.delegation.set(true);
  const tk = newImplTicket(env);
  await driveUntil(env, tk.id, (x) => x.hold?.reason === 'needs_decision', 150_000);
  const asks = () => env.orch.records.recentRuns(200).filter((r) => r.employeeId === lead.id && r.kind === 'chat').length;
  const deadline = Date.now() + 60_000;
  while (asks() < 3 && Date.now() < deadline) {
    await env.orch.tick();
    await env.orch.idle();
  }
  for (let i = 0; i < 10; i++) {
    await env.orch.tick();
    await env.orch.idle();
  }
  assert.equal(asks(), 3, '처음 1번 + 다시 2번');
  assert.equal(env.company.requireTicket(tk.id).hold?.reason, 'needs_decision', '대표 할 일로 남는다');
});

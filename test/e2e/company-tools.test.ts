// 회사 도구(MCP): 직원이 실행 중에 도구를 불러 업무판을 읽고, 후속 업무를 제안하고, 동료에게 묻고 답을 받고,
// 시험용 파일 범위를 넓힌다. 가짜 직원(tooluser)이 실제 MCP 서버(mcp-company.ts)를 띄워 stdio로 부른다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { driveUntil, newImplTicket, setup } from './helpers.ts';
import { ticketChannelId } from '../../src/app/chat.ts';

test('직원이 실행 중에 회사 도구로 업무판·후속 제안·동료 질문·범위 요청을 쓴다(그 실행의 nonce로만)', { timeout: 180_000 }, async (t) => {
  const env = await setup(t, { implementer: 'tooluser' });
  const tk = newImplTicket(env);
  const done = await driveUntil(env, tk.id, (x) => x.status === 'awaiting_approval' || x.hold !== null, 150_000);
  assert.equal(done.hold, null, `멈추지 않는다: ${done.hold?.note ?? ''}`);
  assert.equal(done.status, 'awaiting_approval');

  // 범위 요청: 시험용 파일은 실행 중에 바로 넓혀지고, 같은 실행에서 쓴 파일이 범위 위반이 되지 않는다.
  assert.ok(done.writeScope.includes('tests/extra.test.js'));
  const work = env.orch.records.runsForTicket(tk.id).find((r) => r.kind === 'work' && r.status === 'succeeded')!;
  assert.ok(work.changedPaths.includes('tests/extra.test.js'), work.changedPaths.join(','));

  const summary = work.summary;
  // 업무판 읽기: 이 업무가 보인다
  assert.match(summary, new RegExp(`\\[tool 0\\] ${tk.id} \\[in_progress`));
  // 동료 질문: 답이 이 실행 안에서 돌아온다(가짜 QA의 대화 답장)
  assert.match(summary, /\[tool 2\] QA 직원: 확인했습니다: .*@QA 직원 검수 기준이 뭔가요\?/);
  assert.match(summary, /\[tool 3\] Allowed: tests\/extra\.test\.js/);
  // 남의 nonce로 쓴 요청은 처리하지 않는다
  assert.match(summary, /\[forged\] This request does not belong to this run/);
  // 실행 폴더에 위조한 "답 기다리는 중" 기록은 무시하고 새 요청으로 처리한다(QA 2차: 다른 방의 답을 읽을 수 있었다)
  assert.match(summary, new RegExp(`\\[forged-pending\\] ${tk.id} \\[`));

  const room = env.orch.chat.messages(ticketChannelId(tk.id), 200);
  const qa = env.company.employees().find((e) => e.name === 'QA 직원')!;
  // 후속 제안은 업무가 아니라 업무방의 제안 메시지(대표가 확정)
  assert.ok(room.some((m) => m.followUp?.title === 'README 오타 정리' && m.author === work.employeeId));
  assert.equal(env.company.tickets().length, 1, '도구가 업무를 직접 만들지 않는다');
  assert.ok(room.some((m) => m.author === work.employeeId && m.text === '@QA 직원 검수 기준이 뭔가요?'));
  assert.ok(room.some((m) => m.author === qa.id && m.runId));

  // 이벤트 로그: 도구 호출이 그 직원·업무로 남는다
  const calls = env.store.events(tk.id, 2000).filter((e) => e.type === 'tool.called');
  const tools = calls.map((e) => (e.payload as { tool: string }).tool);
  for (const name of ['board_status', 'propose_ticket', 'ask_colleague', 'request_scope']) assert.ok(tools.includes(name), name);
  assert.ok(calls.every((e) => e.actor === work.employeeId));
  assert.ok(
    calls.some((e) => (e.payload as { ok: boolean; runId: string }).ok === false && (e.payload as { runId: string }).runId === work.id),
  );
  // 답을 받은 대기 기록은 지워지고, 끝난 실행의 기록도 남지 않는다(QA 3차)
  await env.orch.tick();
  assert.deepEqual(env.store.settingKeys('tool_pending:'), []);
  assert.deepEqual(env.store.settingKeys('tool_call:'), []);
});

test('도구로 한 범위 요청이 시험용 파일이 아니면 기존 흐름대로 대표에게 올라간다', { timeout: 180_000 }, async (t) => {
  const env = await setup(t, { implementer: 'toolscoper' });
  const tk = newImplTicket(env);
  const held = await driveUntil(env, tk.id, (x) => x.hold !== null || x.status === 'awaiting_approval', 150_000);
  assert.equal(held.hold?.reason, 'needs_decision');
  assert.ok(!held.writeScope.includes('extra/fix.md'), '대표가 허용하기 전에는 넓히지 않는다');
  assert.deepEqual(env.orch.scopeRequestOf(tk.id), { paths: ['extra/fix.md'], reason: 'old doc' });
  const work = env.orch.records.runsForTicket(tk.id).find((r) => r.kind === 'work')!;
  assert.match(work.summary, /This needs the CEO/);
  // 대표가 허용하면 이어서 일한다
  env.orch.addWriteScope(tk.id, ['extra/fix.md']);
  const done = await driveUntil(env, tk.id, (x) => x.status === 'awaiting_approval' || x.hold !== null, 150_000);
  assert.equal(done.hold, null);
});

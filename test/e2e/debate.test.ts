// 토론 모드: 입장 → 반박 → 사회자 정리 → 결정(규칙으로 남김). 업무 토론은 결론이 날 때까지 업무를 멈춘다(대표 요청 2026-10-02).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { driveUntil, newImplTicket, setup } from './helpers.ts';
import type { Orchestrator } from '../../src/app/orchestrator.ts';

async function untilPhase(orch: Orchestrator, id: string, phase: string, maxMs = 90_000): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (orch.debates.get(id)?.phase !== phase) {
    if (Date.now() > deadline) throw new Error(`토론이 ${phase}에 오지 않음: ${orch.debates.get(id)?.phase}`);
    await orch.tick();
    // 타이머가 돌 틈을 준다(tick·idle이 곧바로 끝나면 실행 시작이 타이머를 기다리다 멈춘다)
    await new Promise((r) => setTimeout(r, 50));
  }
}

test('대표가 연 토론: 각자 입장과 반박이 방에 올라오고, 사회자 정리 뒤 대표가 고르면 규칙이 된다', { timeout: 180_000 }, async (t) => {
  const env = await setup(t);
  const d = await env.orch.debates.start({ topic: '저장은 파일로 할까 SQLite로 할까', origin: 'ceo', projectId: env.projectId });
  assert.equal(d.participants.length, 2);
  await untilPhase(env.orch, d.id, 'decide');
  const got = env.orch.debates.get(d.id)!;
  assert.equal(Object.keys(got.positions).length, 2);
  assert.equal(Object.keys(got.rebuttals).length, 2);
  assert.equal(got.options.length, 2);
  assert.equal(got.recommendation, 1);
  const msgs = env.orch.chat.messages(d.channelId, 50);
  assert.ok(msgs.filter((m) => m.kind === 'chat').length >= 5, '입장 2 + 반박 2 + 정리 1');
  env.orch.debates.decide(d.id, { option: 0 });
  assert.equal(env.orch.debates.get(d.id)!.phase, 'done');
  assert.ok(env.orch.records.decisions(env.projectId, 'current').some((x) => x.text.includes('저장은 JSON 파일로 한다')));
});

test('시작 도중 정기 점검이 돌아도 입장 단계를 건너뛰지 않는다', { timeout: 120_000 }, async (t) => {
  // 실측(2026-10-02, 가계부 할부 토론): 사본 준비 중 tick이 "기대 0, 답 0"으로 보고 반박까지 띄웠다.
  const env = await setup(t);
  const starting = env.orch.debates.start({ topic: '저장 방식', origin: 'ceo', projectId: env.projectId });
  await env.orch.tick();
  await env.orch.tick();
  const d = await starting;
  assert.equal(d.phase, 'opening');
  assert.equal(Object.keys(d.runs).length, d.participants.length);
  // 실행이 다 끝나야 임시 폴더를 지울 수 있다(윈도우: 실행 중인 폴더는 지워지지 않는다)
  await untilPhase(env.orch, d.id, 'decide');
});

test('전권 위임 중이면 사회자 추천안으로 바로 결정한다', { timeout: 180_000 }, async (t) => {
  const env = await setup(t);
  env.orch.delegation.set(true);
  const d = await env.orch.debates.start({ topic: '저장 방식', origin: 'ceo', projectId: env.projectId });
  await untilPhase(env.orch, d.id, 'done');
  assert.equal(env.orch.debates.get(d.id)!.decision, '저장은 SQLite로 한다');
  assert.match(env.orch.debates.get(d.id)!.decidedBy ?? '', /^delegate:/);
});

test('검수에서 두 번 반려되면 담당자·검수자가 토론하고, 결론이 나야 다시 고친다', { timeout: 300_000 }, async (t) => {
  const env = await setup(t, { reviewer: 'harsh' });
  const tk = newImplTicket(env);
  const held = await driveUntil(env, tk.id, (x) => x.hold?.reason === 'on_hold' || x.hold?.reason === 'needs_decision', 200_000);
  assert.equal(held.hold?.reason, 'on_hold', `보류: ${held.hold?.note}`);
  assert.match(held.hold!.note, /토론 중/);
  const d = env.orch.debates.list().find((x) => x.ticketId === tk.id)!;
  assert.equal(d.origin, 'review');
  await untilPhase(env.orch, d.id, 'decide');
  env.orch.debates.decide(d.id, { text: '검수 지적대로 테스트를 보강한다' });
  const after = env.company.requireTicket(tk.id);
  assert.equal(after.hold, null, '결론이 나면 업무를 이어간다');
  assert.ok(env.orch.chat.messages(`t:${tk.id}`, 50).some((m) => m.author === 'ceo' && m.text.includes('토론 결론')));
});

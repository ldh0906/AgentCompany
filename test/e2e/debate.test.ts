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

test(
  '토론이 건 보류는 토론 할 일 하나로 보이고, 토론 결론은 그 보류만 푼다(그사이 다른 이유로 멈췄으면 그대로)',
  { timeout: 60_000 },
  async (t) => {
    const env = await setup(t);
    const tk = newImplTicket(env);
    const host = (
      env.orch.debates as unknown as {
        h: { holdTicket(id: string, note: string, debateId: string): void; resumeTicket(id: string, text: string): void };
      }
    ).h;
    // 열려 있는 토론(진행 중)
    env.store.setSetting('debate:D-open', JSON.stringify({ id: 'D-open', phase: 'opening' }));
    host.holdTicket(tk.id, '토론 중: 저장 방식', 'D-open');
    const held = env.company.requireTicket(tk.id);
    assert.equal(held.hold?.reason, 'on_hold');
    assert.ok(!env.orch.desk.ceoTodos().some((x) => x.key.startsWith(`hold:${tk.id}:`)), '업무 보류 할 일을 따로 띄우지 않는다');
    // 대표가 업무를 풀었다가 다른 이유로 다시 멈춤 → 토론 결론은 그 보류를 풀지 않는다
    env.orch.releaseHold(tk.id);
    env.company.applyTicket(tk.id, { type: 'hold', reason: 'needs_decision', note: '대표 결정 필요' }, { kind: 'ceo' });
    host.resumeTicket(tk.id, '토론 결론: SQLite');
    assert.equal(env.company.requireTicket(tk.id).hold?.reason, 'needs_decision', '토론이 걸지 않은 보류는 그대로');
    assert.ok(
      env.orch.desk.ceoTodos().some((x) => x.key.startsWith(`hold:${tk.id}:`)),
      '이 보류는 대표 할 일로 보인다',
    );
    // 토론이 건 보류는 토론 결론으로 풀린다
    const tk2 = newImplTicket(env);
    host.holdTicket(tk2.id, '토론 중', 'D-open');
    host.resumeTicket(tk2.id, '토론 결론: 파일');
    assert.equal(env.company.requireTicket(tk2.id).hold, null);
    // 토론이 없어지거나 끝났는데 보류가 남았으면 대표에게 보인다(숨은 채 멈추지 않게)
    const tk3 = newImplTicket(env);
    host.holdTicket(tk3.id, '토론 중', 'D-gone');
    assert.ok(env.orch.desk.ceoTodos().some((x) => x.key.startsWith(`hold:${tk3.id}:`)));
  },
);

test('토론 잇기는 끝나지 않은 토론을 먼저 고른다: 끝난 최신 토론이 20개 넘게 쌓여도 오래된 진행 중 토론을 잇는다', async (t) => {
  const env = await setup(t);
  const ids = ['D-old', ...Array.from({ length: 25 }, (_, i) => `D-done-${i}`)].reverse(); // 최신이 앞
  env.store.setSetting('debate_index', JSON.stringify(ids));
  for (const id of ids) env.store.setSetting(`debate:${id}`, JSON.stringify({ id, phase: id === 'D-old' ? 'opening' : 'done', topic: id }));
  const advanced: string[] = [];
  (env.orch.debates as unknown as { advance: (id: string) => Promise<void> }).advance = async (id) => void advanced.push(id);
  await env.orch.debates.sweep();
  assert.deepEqual(advanced, ['D-old']);
});

test('토론 색인을 최근 50개로 자를 때도 끝나지 않은 토론은 남는다(새 토론 60개가 생겨도 이어진다)', async (t) => {
  const env = await setup(t);
  const save = (env.orch.debates as unknown as { save: (d: unknown) => void }).save.bind(env.orch.debates);
  save({ id: 'D-old', channelId: 'g:old', phase: 'opening', topic: 'old' });
  for (let i = 0; i < 60; i++) save({ id: `D-done-${i}`, channelId: `g:${i}`, phase: 'done', topic: String(i) });
  const index = JSON.parse(env.store.getSetting('debate_index') ?? '[]') as string[];
  assert.ok(index.includes('D-old'), '진행 중인 토론은 색인에 남는다');
  assert.ok(index.length <= 51);
  const advanced: string[] = [];
  (env.orch.debates as unknown as { advance: (id: string) => Promise<void> }).advance = async (id) => void advanced.push(id);
  await env.orch.debates.sweep();
  assert.deepEqual(advanced, ['D-old']);
});

test('업그레이드: 예전 버전이 색인에서 뺀 진행 중 토론도 다시 찾아 잇는다', async (t) => {
  const env = await setup(t);
  env.store.setSetting('debate:D-lost', JSON.stringify({ id: 'D-lost', channelId: 'g:lost', phase: 'rebuttal', topic: 'lost' }));
  env.store.setSetting('debate:D-over', JSON.stringify({ id: 'D-over', channelId: 'g:over', phase: 'done', topic: 'over' }));
  env.store.setSetting('debate_index', JSON.stringify([]));
  const advanced: string[] = [];
  (env.orch.debates as unknown as { advance: (id: string) => Promise<void> }).advance = async (id) => void advanced.push(id);
  await env.orch.debates.sweep();
  assert.deepEqual(advanced, ['D-lost']);
  assert.deepEqual(JSON.parse(env.store.getSetting('debate_index') ?? '[]'), ['D-lost'], '끝난 토론은 되살리지 않는다');
});

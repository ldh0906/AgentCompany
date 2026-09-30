// 재점검(2026-09-30, 메이플 MVP 재개)에서 찾은 문제의 회귀 테스트.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWorkPrompt } from '../../src/agents/prompt.ts';
import { driveUntil, newImplTicket, setup } from './helpers.ts';

test('직원이 대표 결정을 요청하면: 대표가 "직원 판단에 맡기기"로 결정을 남기고 바로 재개', { timeout: 120_000 }, async (t) => {
  const env = await setup(t, { implementer: 'asker' });
  const tk = newImplTicket(env);
  const held = await driveUntil(env, tk.id, (x) => x.hold !== null);
  assert.equal(held.hold?.reason, 'needs_decision');
  assert.equal(held.status, 'assigned');
  env.orch.answerTicket(tk.id, null);
  const d = env.orch.records.decisions(env.projectId, 'current');
  assert.ok(
    d.some((x) => x.text.includes('시작 레벨은?') && x.text.includes('담당 직원이')),
    '질문과 위임이 결정으로 남는다',
  );
  const done = await driveUntil(env, tk.id, (x) => x.status === 'awaiting_approval' || x.hold !== null);
  assert.equal(done.status, 'awaiting_approval', `보류: ${done.hold?.note}`);
});

test('대표가 직접 답하면 그 답이 결정으로 기록된다', { timeout: 120_000 }, async (t) => {
  const env = await setup(t, { implementer: 'asker' });
  const tk = newImplTicket(env);
  await driveUntil(env, tk.id, (x) => x.hold !== null);
  env.orch.answerTicket(tk.id, '레벨 1');
  assert.ok(env.orch.records.decisions(env.projectId, 'current').some((x) => x.text.includes('→ 레벨 1')));
  assert.throws(() => env.orch.answerTicket(tk.id, 'x'), /결정|decision/, '보류가 아니면 거부');
});

test('작업 지시: 업무가 값을 정하라고 하면 직원이 합리적인 값을 정한다(결정이 없다고 멈추지 않는다)', async (t) => {
  const env = await setup(t);
  const [emp] = env.company.employees();
  const prompt = buildWorkPrompt({
    employee: emp!,
    project: env.company.requireProject(env.projectId),
    ticket: newImplTicket(env),
    nonce: 'n',
    decisions: [],
    feedback: null,
    language: 'ko',
  });
  assert.match(prompt, /propose sensible values, implement them, and write down the reasoning/);
  assert.doesNotMatch(prompt, /Do NOT decide game rules, product numbers/);
});

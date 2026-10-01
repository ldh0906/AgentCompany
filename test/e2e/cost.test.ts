// 비용: 업무별 토큰 예산(넘으면 멈추고 묻기), 하루 한도(넘으면 전체 일시정지·다음 날 자동 재개), 난이도별 예상치.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PRIOR_ESTIMATE, DEFAULT_TOKEN_BUDGET, tokenBudget } from '../../src/app/cost.ts';
import { followUpsFromSummary } from '../../src/agents/report.ts';
import { driveUntil, newImplTicket, setup } from './helpers.ts';

test('업무 예산을 넘으면 멈추고, 예산을 늘리면 다시 돈다', { timeout: 180_000 }, async (t) => {
  const env = await setup(t, { reviewer: 'harsh' });
  const tk = newImplTicket(env);
  env.company.setTicketTokenBudget(tk.id, 100_000);
  const held = await driveUntil(env, tk.id, (x) => x.hold !== null);
  assert.equal(held.hold?.reason, 'needs_decision');
  assert.match(held.hold!.note, /토큰 예산/);
  const { used, budget } = env.orch.ticketBudget(held);
  assert.ok(used >= budget);
  const next = env.orch.raiseTokenBudget(tk.id);
  assert.ok(tokenBudget(next) > used, '쓴 양보다 크게 늘린다');
  assert.equal(next.hold, null, '예산 때문에 멈춘 것은 바로 푼다');
});

test('하루 한도에 닿으면 회사 전체를 멈추고, 대표가 풀면 그날은 다시 멈추지 않는다', { timeout: 120_000 }, async (t) => {
  const env = await setup(t);
  const tk = newImplTicket(env);
  await driveUntil(env, tk.id, (x) => x.status === 'awaiting_approval' || x.hold !== null);
  env.orch.setDailyTokenLimit(10_000);
  await env.orch.tick();
  assert.equal(env.orch.paused, true);
  assert.ok(env.orch.chat.messages('general').some((m) => /한도/.test(m.text)));
  env.orch.setPaused(false);
  env.orch.setDailyTokenLimit(10_000); // 다시 검사하게
  await env.orch.tick();
  assert.equal(env.orch.paused, false, '그날은 대표 결정 우선');
});

test('예상치: 기록이 없으면 기본값, 끝난 업무가 2개 이상이면 실제 평균', { timeout: 60_000 }, async (t) => {
  const env = await setup(t);
  const e0 = env.orch.tokenEstimates();
  assert.equal(e0.normal.tokens, PRIOR_ESTIMATE.normal);
  assert.equal(e0.normal.samples, 0);
  assert.equal(tokenBudget(newImplTicket(env)), DEFAULT_TOKEN_BUDGET.normal);
});

test(
  '병합 뒤 package.json에 test·typecheck가 생기면: 검증 명령이 없으면 자동 추가, 있으면 추천으로 남긴다',
  { timeout: 60_000 },
  async (t) => {
    const env = await setup(t, { verify: [] });
    const { writeFileSync } = await import('node:fs');
    const { git } = await import('../../src/workspace/git.ts');
    const path = await import('node:path');
    writeFileSync(path.join(env.origin, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run', typecheck: 'tsc --noEmit' } }));
    await git(['add', 'package.json'], env.origin);
    await git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'pkg'], env.origin);
    await env.orch.autoVerifyCommands(env.projectId);
    const p = env.company.requireProject(env.projectId);
    assert.deepEqual(
      p.verifyCommands.map((v) => v.argv.join(' ')),
      ['npm test', 'npm run typecheck'],
    );
    assert.ok(env.orch.chat.messages('general').some((m) => /자동으로 추가/.test(m.text)));
    // 이미 있으면 추천만
    env.company.updateProject(env.projectId, { verifyCommands: [p.verifyCommands[0]!] });
    await env.orch.autoVerifyCommands(env.projectId);
    assert.deepEqual(
      env.orch.verifySuggestions(env.projectId).map((v) => v.argv.join(' ')),
      ['npm run typecheck'],
    );
    // 스크립트 본문과 같은 명령이 이미 있으면 겹치는 추천을 하지 않는다(실측: node --test tests가 있는데 npm test 추천)
    env.company.updateProject(env.projectId, {
      verifyCommands: [
        { label: 'unit', argv: ['vitest', 'run'], evidenceType: 'unit_test' },
        { label: 'tc', argv: ['tsc', '--noEmit'], evidenceType: 'static_check' },
      ],
    });
    await env.orch.autoVerifyCommands(env.projectId);
    assert.deepEqual(env.orch.verifySuggestions(env.projectId), []);
  },
);

test('요약 속 "범위 밖"·"후속 티켓" 문장을 후속 업무 제안으로 잡는다', () => {
  const got = followUpsFromSummary(
    '상점을 구현했습니다. 범위 밖 참고: README는 쓰기 범위 밖이라 갱신하지 않았으니 필요하면 후속 티켓으로 처리해 주세요.\n테스트는 모두 통과합니다.',
  );
  assert.equal(got.length, 1);
  assert.match(got[0]!.title, /^README/);
  assert.deepEqual(followUpsFromSummary('모든 요구사항을 충족했습니다.'), []);
});

test('예산은 같은 난이도 실제 평균의 2.5배까지 늘어난다(대표가 정한 값이 있으면 그 값)', () => {
  const hard = { budget: {}, difficulty: 'hard' } as unknown as Parameters<typeof tokenBudget>[0];
  assert.equal(tokenBudget(hard), DEFAULT_TOKEN_BUDGET.hard);
  assert.equal(tokenBudget(hard, 8_110_000), 20_275_000);
  assert.equal(tokenBudget(hard, 1_000_000), DEFAULT_TOKEN_BUDGET.hard, '평균이 작으면 기본값');
  const fixed = { budget: { maxTokens: 3_000_000 }, difficulty: 'hard' } as unknown as Parameters<typeof tokenBudget>[0];
  assert.equal(tokenBudget(fixed, 8_110_000), 3_000_000);
  // 조사는 웹 페이지를 읽어 3배(실측: 보통 조사 한 번 629만 > 기본 400만)
  const research = { budget: {}, difficulty: 'normal', type: 'research' } as unknown as Parameters<typeof tokenBudget>[0];
  assert.equal(tokenBudget(research), DEFAULT_TOKEN_BUDGET.normal * 3);
});

test('제출 뒤(검사·검수만 남음) 예산을 넘으면 멈추지 않고 알리기만 한다', { timeout: 240_000 }, async (t) => {
  // 실행 한 번에 약 3만: 작업 → 반려 → 재작업까지 약 9.5만, 두 번째 검수에서 10만을 넘는다(이미 제출된 상태)
  const env = await setup(t, { reviewer: 'picky' });
  const tk = newImplTicket(env);
  env.company.setTicketTokenBudget(tk.id, 100_000);
  const after = await driveUntil(env, tk.id, (x) => x.status === 'awaiting_approval' || x.hold !== null, 150_000);
  assert.equal(after.hold, null, '제출 뒤에는 멈추지 않는다');
  assert.equal(after.status, 'awaiting_approval');
  assert.ok(env.orch.desk.notices().some((n) => /토큰 예산을 넘었습니다/.test(n.title)));
});

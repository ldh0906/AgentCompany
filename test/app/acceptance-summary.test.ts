// 요청 승인 카드의 인수 시험 요약: 요청에 정한 시험 수로 세고, 결과 없음·실패한 실행은 남은 것으로(QA 1·2차).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setLanguage } from '../../src/core/i18n.ts';
import { acceptanceSummary } from '../../src/app/acceptance.ts';
import type { AcceptanceRound } from '../../src/app/records.ts';

setLanguage('ko');
const req = {
  acceptance: [
    { id: 'A1', check: '로그인', how: '해 본다' },
    { id: 'A2', check: '로그아웃', how: '해 본다' },
    { id: 'A3', check: '저장', how: '해 본다' },
  ],
};
const round = (over: Partial<AcceptanceRound>): AcceptanceRound => ({
  round: 1,
  state: 'done',
  at: '2026-10-08T00:00:00.000Z',
  runId: null,
  results: [],
  report: '',
  fixTickets: [],
  ...over,
});

test('모두 통과하면 남은 것이 없다', () => {
  const s = acceptanceSummary(req, round({ results: ['A1', 'A2', 'A3'].map((id) => ({ id, mark: '✅' as const, why: '' })) }));
  assert.deepEqual([s.passed, s.total, s.left], [3, 3, []]);
});

test('빈 결과는 "0/0 통과"가 아니라 정한 시험 3개가 모두 결과 없음', () => {
  const s = acceptanceSummary(req, round({ results: [] }));
  assert.equal(s.passed, 0);
  assert.equal(s.total, 3);
  assert.deepEqual(s.left, ['A1 ❓ 결과 없음', 'A2 ❓ 결과 없음', 'A3 ❓ 결과 없음']);
});

test('일부만 답하고 모르는 ID를 섞어도 정한 시험 기준으로 센다', () => {
  const s = acceptanceSummary(
    req,
    round({
      results: [
        { id: 'A1', mark: '✅', why: '' },
        { id: 'A2', mark: '⚠', why: '버튼이 없다' },
        { id: 'ZZ', mark: '✅', why: '엉뚱한 항목' },
      ],
    }),
  );
  assert.deepEqual([s.passed, s.total], [1, 3]);
  assert.deepEqual(s.left, ['A2 ⚠ 버튼이 없다', 'A3 ❓ 결과 없음']);
});

test('실행이 실패한 회차는 실패로 남긴다', () => {
  const s = acceptanceSummary(req, round({ state: 'failed', results: [] }));
  assert.equal(s.passed, 0);
  assert.match(s.left[0]!, /실행이 실패/);
});

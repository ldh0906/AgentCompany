// 할 일 화면의 보류 한 줄 설명과 바로 할 일(대표 요청 2026-10-03: 보류 메모 원문이 줄줄이 나열돼 읽기 불친절했다).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { holdReason } from '../../src/app/ceo-desk.ts';
import type { Ticket } from '../../src/core/types.ts';

const held = (reason: string, note: string) => ({ id: 'T-1', hold: { reason, note, since: '2026-10-03T00:00:00Z' } }) as unknown as Ticket;

test('보류 한 줄 설명: 범위 요청은 허용, 회차 초과·검증 실패는 다시 검증, 멈춰 둔 업무는 다시 진행', () => {
  const scope = holdReason(
    held('needs_decision', '이 파일도 고쳐야 한다고 요청했습니다: research/a.cjs, research/b.cjs\n이유: 테스트가 고정 경로 때문에 실패'),
  );
  assert.equal(scope.reason, '파일 2개 더 고치게 해 달라는 요청');
  assert.deepEqual(scope.action, { kind: 'allow', paths: ['research/a.cjs', 'research/b.cjs'] });

  const rounds = holdReason(held('needs_decision', '수정 회차 3회 초과 — 마지막 실패: 시스템 검증 실패\nCannot find module'));
  assert.equal(rounds.reason, '수정 3회를 넘겨 멈춤 · 자동 검사 실패');
  assert.deepEqual(rounds.action, { kind: 'reverify' });

  const old = holdReason(held('needs_decision', '수정 회차 3회 초과'));
  assert.equal(old.reason, '수정 3회를 넘겨 멈춤');

  assert.deepEqual(holdReason(held('on_hold', '대표가 멈춤')).action, { kind: 'release' });
  assert.equal(holdReason(held('usage_limit', '')).action, null);
});

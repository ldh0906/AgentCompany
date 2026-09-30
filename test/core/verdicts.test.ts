import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verdictsOf } from '../../src/core/verdicts.ts';

test('QA 의견에서 요구사항별 한 줄 결론과 대표 확인 방법을 뽑는다', () => {
  const v = verdictsOf(
    'R1 ✅ 배경과 보스가 보임\n2.png: 보랏빛 신전\n\nR2 ❓ 처치 장면이 없음\n7.png: 100%\n대표 확인: 폐허 끝 포털에서 ↑, 보스를 때려 바가 줄어드는지 보기\n\nR3 ⚠️ 글자가 잘림',
  );
  assert.deepEqual(
    v.map((x) => [x.id, x.mark, x.ceo]),
    [
      ['R1', '✅', null],
      ['R2', '❓', '폐허 끝 포털에서 ↑, 보스를 때려 바가 줄어드는지 보기'],
      ['R3', '⚠', null],
    ],
  );
  assert.deepEqual(verdictsOf('예전 형식 R1: 괜찮음'), []);
});

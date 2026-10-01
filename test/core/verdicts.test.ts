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

test('⚠인데 "사진으로는 판단할 수 없다"면 확실하지 않은 것으로 표시한다(자동 돌려보내기 제외)', () => {
  const v = verdictsOf(
    'R2 ✅ 잘 보입니다\nR3 ⚠ 배너가 없습니다\n7.png: 타이머가 00:05라 아직 울릴 시각이 아니었던 것으로 보입니다. 기능 고장인지는 사진으로 판단할 수 없습니다.\nR4 ⚠ 버튼 글자가 잘립니다\n9.png: 오른쪽이 잘려 있습니다',
  );
  assert.equal(v.find((x) => x.id === 'R3')!.unsure, true);
  assert.equal(v.find((x) => x.id === 'R4')!.unsure, undefined);
});

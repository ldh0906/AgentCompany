// 원본 출력 창: 직원이 읽은 화면 사진(base64)은 줄여서 보여 준다(실측 2026-10-02, 퀴즈 T-55).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shortenBase64 } from '../../src/server/api.ts';

test('긴 base64는 생략 표시로, 보통 글·경로·해시는 그대로', () => {
  const img = 'iVBORw0KGgo' + 'A'.repeat(2000) + '==';
  assert.equal(shortenBase64(`{"data":"${img}"} 다음 줄`), '{"data":"[그림 데이터 생략 1 KB]"} 다음 줄');
  const plain = 'commit 3a0c2f4b8e1d9f2a7c6b5e4d3c2b1a0f9e8d7c6b src/app/x.ts C:/Users/a/b';
  assert.equal(shortenBase64(plain), plain);
});

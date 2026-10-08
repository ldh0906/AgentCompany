// Windows에서 대상 파일을 다른 프로세스가 잠깐 잡고 있으면 rename이 EPERM으로 실패한다: 잠깐 뒤 다시 한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renameWithRetry } from '../../src/runner/process.ts';

const fail = (code: string) => Object.assign(new Error(code), { code });

test('일시적인 잠금(EPERM·EACCES·EBUSY)은 다시 시도해 성공한다', async () => {
  const codes = ['EPERM', 'EACCES', 'EBUSY'];
  let calls = 0;
  await renameWithRetry('a', 'b', async () => {
    if (calls < codes.length) throw fail(codes[calls++]!);
    calls++;
  });
  assert.equal(calls, 4);
});

test('다른 오류는 바로, 잠금이 계속되면 횟수를 넘긴 뒤 던진다', async () => {
  let calls = 0;
  await assert.rejects(
    renameWithRetry('a', 'b', async () => {
      calls++;
      throw fail('ENOENT');
    }),
    /ENOENT/,
  );
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(
    renameWithRetry(
      'a',
      'b',
      async () => {
        calls++;
        throw fail('EPERM');
      },
      3,
    ),
    /EPERM/,
  );
  assert.equal(calls, 3);
});

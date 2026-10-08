// 병렬 실행 격리: 비어 있는 포트와 고유 DB 이름(Emdash의 $EMDASH_PORT처럼).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { freePort, isolationEnv } from '../../src/runner/ports.ts';

test('freePort: 실제로 열 수 있는 포트를 준다', async () => {
  const port = await freePort();
  assert.ok(port > 0);
  const srv = createServer();
  await new Promise<void>((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(port, '127.0.0.1', resolve);
  });
  await new Promise<void>((r) => srv.close(() => r()));
});

test('isolationEnv: PORT·AC_PORT가 같고, 실행마다 DB 이름이 다르며 이름에 쓸 수 없는 글자는 바꾼다', async () => {
  const a = await isolationEnv('R-abc');
  const b = await isolationEnv('verify-T-1.2');
  assert.equal(a.PORT, a.AC_PORT);
  assert.equal(a.AC_DB_NAME, 'ac_r_abc');
  assert.equal(b.AC_DB_NAME, 'ac_verify_t_1_2');
  assert.notEqual(a.AC_DB_NAME, b.AC_DB_NAME);
});

test('동시에 여러 실행이 받아도 같은 포트를 두 번 내주지 않는다(내준 포트는 다시 쓰지 않음)', async () => {
  const ports = await Promise.all(Array.from({ length: 40 }, () => freePort()));
  assert.equal(new Set(ports).size, ports.length);
  const more = await Promise.all(Array.from({ length: 20 }, () => freePort()));
  assert.ok(more.every((p) => !ports.includes(p)), '앞서 내준 포트를 다시 주지 않는다');
});

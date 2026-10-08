// 병렬 실행 격리: 직원 실행과 검사 명령이 각자 비어 있는 PORT와 고유 AC_DB_NAME을 받는다(Emdash의 $EMDASH_PORT처럼).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { driveUntil, newImplTicket, setup } from './helpers.ts';

// 직원(portcheck)은 받은 PORT·AC_DB_NAME을 src/ports.txt에 적는다. 검사 명령은 자기 환경과 비교한다:
// 둘 다 있어야 하고, PORT=AC_PORT, DB 이름은 직원 실행 것(ac_r_…)과 달라야 한다.
const CHECK = [
  "const [p, db] = require('fs').readFileSync('src/ports.txt', 'utf8').trim().split(' ');",
  'const e = process.env;',
  "const ok = /^[0-9]+$/.test(p) && db.startsWith('ac_r_') && e.PORT && e.PORT === e.AC_PORT && e.AC_DB_NAME && e.AC_DB_NAME !== db;",
  'process.exit(ok ? 0 : 1);',
].join(' ');

test('직원 실행과 검사 명령은 서로 다른 PORT·AC_DB_NAME을 받는다', { timeout: 180_000 }, async (t) => {
  const env = await setup(t, {
    implementer: 'portcheck',
    verify: [{ label: 'isolation', argv: ['node', '-e', CHECK], evidenceType: 'unit_test' }],
  });
  const tk = newImplTicket(env);
  const done = await driveUntil(env, tk.id, (x) => x.status === 'awaiting_approval' || x.hold !== null, 150_000);
  assert.equal(done.status, 'awaiting_approval', `보류: ${done.hold?.note ?? ''}`);
  assert.ok(
    env.orch.records.evidenceFor(tk.id).some((e) => e.label === 'isolation' && e.passed),
    '검사 명령이 격리 환경을 확인했다',
  );
});

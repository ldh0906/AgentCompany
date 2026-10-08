// 병렬 실행끼리 포트·DB가 부딪히지 않게: 실행마다 비어 있는 포트와 고유 DB 이름을 환경 변수로 준다.
// 직원 실행·검사 명령·미리보기가 같은 3000번을 동시에 잡거나 같은 테스트 DB를 지우는 일을 막는다.
// 앱이 PORT(대부분의 서버·개발 서버가 읽는다)나 AC_PORT, AC_DB_NAME을 쓰면 저절로 나뉜다.
import { createServer } from 'node:net';

/**
 * 이 데몬이 내준 포트(포트 → 만료 시각). 운영체제는 방금 닫은 포트를 곧바로 다시 줄 수 있어, 실행이 실제로 서버를 열기 전에
 * 다른 실행이 같은 포트를 받을 수 있었다(QA). 내준 포트는 일정 시간 다시 내주지 않는다(회사 밖 프로세스까지 막지는 못한다).
 */
const leased = new Map<number, number>();
const LEASE_MS = 6 * 60 * 60_000;

function osPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error('no port'))));
    });
  });
}

/** 지금 비어 있고, 이 데몬이 최근에 내주지 않은 포트. 내준 포트는 기록한다. */
export async function freePort(): Promise<number> {
  const now = Date.now();
  for (const [p, until] of leased) if (until < now) leased.delete(p);
  for (let i = 0; i < 50; i++) {
    const port = await osPort();
    if (leased.has(port)) continue;
    leased.set(port, now + LEASE_MS);
    return port;
  }
  throw new Error('no unleased port');
}

/** 실행 하나의 격리 환경 변수. slot은 실행·검사를 구분하는 이름(실행 ID 등). */
export async function isolationEnv(slot: string): Promise<Record<string, string>> {
  const port = String(await freePort());
  const id = slot.replace(/[^A-Za-z0-9]/g, '_').toLowerCase();
  return { PORT: port, AC_PORT: port, AC_SLOT: id, AC_DB_NAME: `ac_${id}` };
}

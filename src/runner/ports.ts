// 병렬 실행끼리 포트·DB가 부딪히지 않게: 실행마다 비어 있는 포트와 고유 DB 이름을 환경 변수로 준다.
// 직원 실행·검사 명령·미리보기가 같은 3000번을 동시에 잡거나 같은 테스트 DB를 지우는 일을 막는다.
// 앱이 PORT(대부분의 서버·개발 서버가 읽는다)나 AC_PORT, AC_DB_NAME을 쓰면 저절로 나뉜다.
import { createServer } from 'node:net';

/** 지금 비어 있는 포트(운영체제가 고른다). 잡았다 바로 놓으므로 드물게 그사이 다른 것이 잡을 수 있다. */
export function freePort(): Promise<number> {
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

/** 실행 하나의 격리 환경 변수. slot은 실행·검사를 구분하는 이름(실행 ID 등). */
export async function isolationEnv(slot: string): Promise<Record<string, string>> {
  const port = String(await freePort());
  const id = slot.replace(/[^A-Za-z0-9]/g, '_').toLowerCase();
  return { PORT: port, AC_PORT: port, AC_SLOT: id, AC_DB_NAME: `ac_${id}` };
}

// 결과물 미리보기 정적 서버: Host 확인(DNS 리바인딩 방어), 깨진 주소·폴더 밖 경로 거부(보안 점검 2026-10-01).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { staticServer } from '../../src/app/preview.ts';

function get(port: number, pathname: string, host = `127.0.0.1:${port}`): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: pathname, headers: { host } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
}

test('미리보기 서버: 다른 Host·깨진 주소·폴더 밖은 거부하고 앱을 죽이지 않는다', async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ac-prev-'));
  writeFileSync(path.join(dir, 'index.html'), '<h1>ok</h1>');
  const server = await staticServer(dir);
  t.after(() => {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const port = (server.address() as { port: number }).port;
  assert.equal(await get(port, '/'), 200);
  assert.equal(await get(port, '/', `evil.example:${port}`), 403, 'DNS 리바인딩');
  assert.equal(await get(port, '/%E0%A4%A'), 400, '깨진 주소');
  assert.equal(await get(port, '/..%2f..%2fetc'), 403, '폴더 밖');
  assert.equal(await get(port, '/'), 200, '그 뒤에도 서버가 살아 있다');
});

// 자동 화면 점검: 보이지 않는 크롬으로 페이지를 열어 세 장을 찍고, 콘솔 오류·키 입력 반응을 잡는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { captureScreens, findChrome } from '../../src/app/screen-check.ts';

const PAGE = `<!doctype html><body style="margin:0;background:#123"><h1 id="h">시작 화면</h1><script>
console.error('boom from page');
addEventListener('keydown', (e) => { if (e.code === 'Enter') document.getElementById('h').textContent = '게임 시작'; });
</script></body>`;

test('크롬으로 열어 세 장을 찍고 콘솔 오류와 첫 화면 글자를 모은다', { skip: !findChrome(), timeout: 60_000 }, async () => {
  const server = createServer((_q, r) => r.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE));
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const port = (server.address() as { port: number }).port;
  try {
    const out = await mkdtemp(path.join(os.tmpdir(), 'ac-shots-'));
    const cap = await captureScreens(`http://127.0.0.1:${port}/`, out);
    assert.equal(cap.shots.length, 3);
    for (const s of cap.shots) assert.ok((await stat(s.file)).size > 1000, s.file);
    assert.match(cap.text, /시작 화면/);
    assert.ok(
      cap.errors.some((e) => /boom from page/.test(e)),
      cap.errors.join('\n'),
    );
  } finally {
    server.close();
  }
});

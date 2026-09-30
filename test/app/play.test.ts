// 고급 QA 플레이 세션: 명령마다 같은 크롬에 붙어 조작하고, 새 화면 사진 경로와 페이지 오류를 돌려준다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { findChrome } from '../../src/app/screen-check.ts';
import { playCommand } from '../../src/app/play.ts';

const PAGE = `<!doctype html><meta charset="utf-8"><body><h1 id="h">대기</h1><button onclick="document.getElementById('h').textContent='시작함'">시작</button>
<script>addEventListener('keydown', (e) => { if (e.code === 'KeyZ') console.error('z ' + e.key); });</script></body>`;

test('play: 시작 → 글자로 클릭 → 키 → 멈춤, 명령마다 사진 경로와 오류를 준다', { skip: !findChrome(), timeout: 60_000 }, async () => {
  const server = createServer((_q, r) => r.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE));
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ac-play-'));
  try {
    const a = await playCommand(['start', '--url', url, '--dir', dir]);
    assert.match(a, /shot: .*0001\.jpg/);
    assert.match(await playCommand(['click', '--text', '시작', '--dir', dir]), /0002\.jpg/);
    const k = await playCommand(['key', 'KeyZ', '--times', '2', '--dir', dir]);
    assert.match(k, /page errors: z z \| z z/);
    assert.match(k, /actions used: 3\//);
    assert.match(await playCommand(['bogus', '--dir', dir]), /unknown command/);
    assert.equal(await playCommand(['stop', '--dir', dir]), 'stopped');
    assert.ok(!existsSync(path.join(dir, 'session.json')));
    assert.match(await playCommand(['look', '--dir', dir]), /no session/);
  } finally {
    server.close();
  }
});

// 자동 화면 점검: 보이지 않는 크롬으로 페이지를 열어 세 장을 찍고, 콘솔 오류·키 입력 반응을 잡는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { captureScreens, findChrome } from '../../src/app/screen-check.ts';
import { screenStepsOf } from '../../src/agents/report.ts';

const PAGE = `<!doctype html><body style="margin:0;background:#123"><h1 id="h">시작 화면</h1><div style="width:600px;height:10px"></div><script>
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
    assert.equal(cap.shots.length, 4, '흔한 조작 3장 + 휴대폰 폭 1장');
    assert.equal(cap.shots.at(-1)!.label, '휴대폰 폭(375px)');
    assert.ok(
      cap.errors.some((e) => /가로로 넘침/.test(e)),
      '넓은 요소는 휴대폰 폭에서 넘친다고 알린다',
    );
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

test('확인 창(confirm)은 "확인"으로 닫고 문구를 알려 준다(창 때문에 멈추지 않음)', { skip: !findChrome(), timeout: 60_000 }, async () => {
  const page = `<!doctype html><body><h1 id="h">메모 1개</h1><button onclick="if (confirm('정말 지울까요?')) document.getElementById('h').textContent = '메모 0개'">삭제</button></body>`;
  const server = createServer((_q, r) => r.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(page));
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const port = (server.address() as { port: number }).port;
  try {
    const out = await mkdtemp(path.join(os.tmpdir(), 'ac-shots-'));
    const cap = await captureScreens(
      `http://127.0.0.1:${port}/`,
      out,
      undefined,
      [
        {
          requirementId: 'R1',
          steps: [
            { do: 'click', text: '삭제' },
            { do: 'shot', label: '지운 뒤' },
          ],
        },
      ],
      { mobile: false },
    );
    assert.match(cap.text, /confirm: 정말 지울까요\?/);
    assert.ok(cap.shots.some((s) => /지운 뒤/.test(s.label)));
  } finally {
    server.close();
  }
});

test(
  '화면 점검 "open" 단계: 같은 앱의 다른 주소(빠른 확인 모드)를 열고, 다른 사이트는 열지 않는다',
  { skip: !findChrome(), timeout: 60_000 },
  async () => {
    const seen: string[] = [];
    const server = createServer((q, r) => {
      seen.push(q.url ?? '');
      r.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<!doctype html><body><h1>게임</h1></body>');
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    const port = (server.address() as { port: number }).port;
    try {
      const out = await mkdtemp(path.join(os.tmpdir(), 'ac-shots-'));
      const steps = screenStepsOf(
        [
          {
            requirementId: 'R1',
            steps: [
              { do: 'open', path: '?check=boss' },
              { do: 'shot', label: '보스' },
              { do: 'open', path: 'https://example.com/' },
            ],
          },
        ],
        ['R1'],
      );
      assert.deepEqual(
        steps[0]!.steps.map((s) => s.do),
        ['open', 'shot'],
        '다른 사이트 주소는 읽을 때 버린다',
      );
      const cap = await captureScreens(`http://127.0.0.1:${port}/`, out, undefined, steps, { mobile: false });
      assert.ok(seen.includes('/?check=boss'), `빠른 확인 주소를 열었다: ${seen.join(', ')}`);
      assert.ok(cap.shots.some((s) => /보스/.test(s.label)));
    } finally {
      server.close();
    }
  },
);

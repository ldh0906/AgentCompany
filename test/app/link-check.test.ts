// 출처 링크 확인: 깨진 링크(없는 주소·404)만 돌려보내고, 봇 차단·시간 초과는 "확인 못 함"으로 둔다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkLinks, extractLinks, isPrivateHost, linkSummary } from '../../src/app/link-check.ts';

test('링크 뽑기: 마크다운 링크·맨 주소, 끝 문장부호 제외, 괄호 든 위키 주소 유지, 중복 제거', () => {
  const text = [
    '근거 [1](https://example.com/a). 또 https://example.com/b, 그리고',
    '- https://ko.wikipedia.org/wiki/커피_(음료) 참고',
    '[다시](https://example.com/a)',
  ].join('\n');
  assert.deepEqual(extractLinks(text), ['https://example.com/a', 'https://example.com/b', 'https://ko.wikipedia.org/wiki/커피_(음료)']);
});

test('내 PC·내부망 주소는 열지 않는다', () => {
  for (const h of ['localhost', '127.0.0.1', '10.1.2.3', '192.168.0.5', '172.20.1.1', '169.254.1.1', '[::1]', 'printer.local'])
    assert.equal(isPrivateHost(h), true, h);
  for (const h of ['example.com', '8.8.8.8', '172.32.0.1', 'fcbarcelona.com']) assert.equal(isPrivateHost(h), false, h);
});

const res = (status: number) => new Response(null, { status });
const netErr = (code: string) => Object.assign(new TypeError('fetch failed'), { cause: { code } });

test('판정: 열림 / 깨짐(404·없는 주소) / 확인 못 함(403·시간 초과), HEAD를 거절하면 GET으로', async () => {
  const calls: string[] = [];
  const fetchFn = async (url: string, init: RequestInit) => {
    calls.push(`${init.method} ${url}`);
    if (url.includes('ok')) return res(200);
    if (url.includes('headless')) return init.method === 'HEAD' ? res(405) : res(200);
    if (url.includes('gone')) return res(404);
    if (url.includes('bot')) return res(403);
    if (url.includes('slow')) throw Object.assign(new Error('t'), { name: 'TimeoutError' });
    throw netErr('ENOTFOUND');
  };
  const r = await checkLinks(
    [
      'https://ok.example',
      'https://headless.example',
      'https://gone.example',
      'https://bot.example',
      'https://slow.example',
      'https://nxdomain.example',
      'http://localhost:3000',
    ],
    { fetchFn },
  );
  assert.deepEqual(
    r.map((x) => x.state),
    ['ok', 'ok', 'dead', 'unknown', 'unknown', 'dead', 'unknown'],
  );
  assert.ok(calls.includes('GET https://headless.example'));
  assert.ok(!calls.some((c) => c.includes('localhost')), '내부 주소는 요청하지 않는다');
  const s = linkSummary(r, true);
  assert.match(s, /^링크 7개: 2개 열림, 2개 깨짐, 3개 확인 못 함/);
  assert.match(s, /깨짐 \(404\): https:\/\/gone\.example/);
});

test('인터넷이 끊겨 모든 주소가 "이름 없음"이면 깨짐으로 보지 않는다', async () => {
  const r = await checkLinks(['https://a.example', 'https://b.example'], {
    fetchFn: async () => {
      throw netErr('ENOTFOUND');
    },
  });
  assert.deepEqual(
    r.map((x) => x.state),
    ['unknown', 'unknown'],
  );
});

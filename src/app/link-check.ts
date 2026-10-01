// 링크 확인: 조사·문서 결과물에 적힌 출처 링크를 실제로 열어 본다(내용은 저장하지 않고 열리는지만).
// 대표 요청(2026-10-01): 조사 결과를 믿을 수 있게. AI가 쓴 인용 링크는 지어낸 것이 섞인다(연구마다 14~95%).
// - 깨짐: 주소가 없거나(DNS·연결 실패) 404/410. 이것만 돌려보낸다.
// - 확인 못 함: 401/403/429/5xx/시간 초과. 봇을 막는 사이트가 많아 실패로 보지 않고 검수자에게 알린다.
// - 내 PC·내부망 주소(localhost, 10.x, 192.168.x 등)는 열지 않는다.

export interface LinkResult {
  url: string;
  state: 'ok' | 'dead' | 'unknown';
  detail: string;
}

/** 글에서 http(s) 링크를 뽑는다(마크다운 링크·맨 주소). 끝 문장부호와 닫는 괄호는 뺀다. */
export function extractLinks(text: string): string[] {
  const out = new Set<string>();
  // 괄호는 짝이 맞을 때만 주소에 넣는다(위키 "커피_(음료)"는 살리고, 마크다운 "(주소)"의 닫는 괄호는 뺀다).
  for (const m of text.matchAll(/https?:\/\/[^\s<>"'`[\]()]+(?:\([^\s<>"'`()]*\)[^\s<>"'`[\]()]*)*/g)) {
    const url = m[0].replace(/[.,;:!?*_~]+$/, '');
    try {
      new URL(url);
      out.add(url);
    } catch {
      // 잘못된 주소는 건너뛴다
    }
  }
  return [...out];
}

/** 내 PC·내부망 주소: 열지 않는다. */
export function isPrivateHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (h.includes(':')) return h === '::1' || /^(fc|fd|fe80)/.test(h);
  const v4 = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!v4) return false;
  const [a, b] = [Number(v4[1]), Number(v4[2])];
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';

async function checkOne(url: string, fetchFn: Fetch, timeoutMs: number): Promise<LinkResult> {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return { url, state: 'dead', detail: 'invalid URL' };
  }
  if (isPrivateHost(host)) return { url, state: 'unknown', detail: 'local address (not opened)' };
  const attempt = async (method: 'HEAD' | 'GET') => {
    const res = await fetchFn(url, {
      method,
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,*/*' },
    });
    await res.body?.cancel().catch(() => {});
    return res.status;
  };
  try {
    let status = await attempt('HEAD');
    // HEAD를 받지 않는 서버가 많다: 실패 응답이면 GET으로 한 번 더.
    if (status >= 400) status = await attempt('GET');
    if (status < 400) return { url, state: 'ok', detail: String(status) };
    if (status === 404 || status === 410) return { url, state: 'dead', detail: String(status) };
    return { url, state: 'unknown', detail: String(status) };
  } catch (e) {
    const err = e as Error & { cause?: { code?: string } };
    if (err.name === 'TimeoutError' || err.name === 'AbortError') return { url, state: 'unknown', detail: 'timeout' };
    const code = err.cause?.code ?? '';
    // 주소 자체가 없는 경우만 깨짐으로 본다(일시적인 연결 끊김은 확인 못 함).
    if (['ENOTFOUND', 'EAI_NONAME', 'ERR_INVALID_URL'].includes(code)) return { url, state: 'dead', detail: code };
    return { url, state: 'unknown', detail: code || err.message.slice(0, 80) };
  }
}

export async function checkLinks(
  urls: string[],
  opts: { fetchFn?: Fetch; timeoutMs?: number; max?: number; concurrency?: number } = {},
): Promise<LinkResult[]> {
  const list = urls.slice(0, opts.max ?? 40);
  const fetchFn = opts.fetchFn ?? ((u, i) => fetch(u, i));
  const out: LinkResult[] = new Array(list.length);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < list.length; i = next++) out[i] = await checkOne(list[i]!, fetchFn, opts.timeoutMs ?? 12_000);
  };
  await Promise.all(Array.from({ length: Math.min(opts.concurrency ?? 6, list.length) }, worker));
  // 모든 주소가 "이름 없음"이면 인터넷이 끊긴 것: 깨짐으로 돌려보내지 않는다.
  if (out.length > 1 && out.every((r) => r.state === 'dead' && /ENOTFOUND|EAI_NONAME/.test(r.detail)))
    return out.map((r) => ({ ...r, state: 'unknown', detail: `${r.detail} (offline?)` }));
  return out;
}

/** 증거 요약(한국어/영어는 호출하는 쪽 tr로). 깨진 링크와 확인 못 한 링크를 위에 둔다. */
export function linkSummary(results: LinkResult[], ko: boolean): string {
  const dead = results.filter((r) => r.state === 'dead');
  const unknown = results.filter((r) => r.state === 'unknown');
  const ok = results.length - dead.length - unknown.length;
  const head = ko
    ? `링크 ${results.length}개: ${ok}개 열림, ${dead.length}개 깨짐, ${unknown.length}개 확인 못 함`
    : `${results.length} links: ${ok} open, ${dead.length} broken, ${unknown.length} unconfirmed`;
  const lines = [
    ...dead.map((r) => `${ko ? '깨짐' : 'broken'} (${r.detail}): ${r.url}`),
    ...unknown.map((r) => `${ko ? '확인 못 함' : 'unconfirmed'} (${r.detail}): ${r.url}`),
  ];
  return [head, ...lines].join('\n');
}

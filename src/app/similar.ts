// 비슷한 문장인지(후속 업무 제안 중복 거르기). 단어를 뽑아 조사·흔한 동사를 떼고 겹치는 정도를 본다.
// 실측(2026-10-03, 4777): 같은 playwright 문제를 직원마다 다른 말로 6개 방에 제안했다. 실제 제목 37개로 맞춰 본 기준:
// 겹친 단어 2개 이상이면서 짧은 쪽의 60% 이상이면 같은 제안(37개 중 10개를 걸렀고 잘못 거른 것은 없었다).

const STOP = new Set([
  '및',
  '정리',
  '정비',
  '수정',
  '확인',
  '추가',
  '작성',
  '해결',
  '반영',
  '보완',
  '검토',
  '필요',
  '처리',
  '방식',
  '안내',
  '문서',
]);
const PARTICLE = /(에서|에게|으로|의|를|을|가|이|은|는|에|와|과|로|도|만)$/u;

export function keywords(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .split(/[\s·,()'"`:;]+/)
      .map((w) => w.replace(PARTICLE, ''))
      .filter((w) => w.length >= 2 && !STOP.has(w)),
  );
}

export function similarTitle(a: string, b: string): boolean {
  const A = keywords(a);
  const B = keywords(b);
  const shared = [...A].filter((x) => B.has(x)).length;
  return shared >= 2 && shared / Math.max(1, Math.min(A.size, B.size)) >= 0.6;
}

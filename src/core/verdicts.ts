// 화면 점검 QA 의견의 요구사항별 한 줄 결론(승인 카드 요약용). 형식은 buildScreenCheckPrompt가 정한다.

/** QA 의견에서 요구사항별 한 줄 결론을 뽑는다: "R2 ❓ 한 줄" 과 그 아래 "대표 확인: ..." 줄. */
export function verdictsOf(opinion: string): { id: string; mark: string; line: string; ceo: string | null }[] {
  const out: { id: string; mark: string; line: string; ceo: string | null }[] = [];
  for (const block of opinion.split(/\n(?=R\d+\s*(?:✅|⚠|❓))/)) {
    const m = /^(R\d+)\s*(✅|⚠️?|❓)\s*(.*)$/m.exec(block.trim());
    if (!m) continue;
    const ceo = /^(?:대표 확인|CEO check)\s*[:：]\s*(.+)$/m.exec(block)?.[1] ?? null;
    out.push({ id: m[1]!, mark: m[2]!.startsWith('⚠') ? '⚠' : m[2]!, line: m[3]!.trim(), ceo });
  }
  return out;
}

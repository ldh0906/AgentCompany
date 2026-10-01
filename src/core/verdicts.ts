// 화면 점검 QA 의견의 요구사항별 한 줄 결론(승인 카드 요약용). 형식은 buildScreenCheckPrompt가 정한다.

/** QA 의견에서 요구사항별 한 줄 결론을 뽑는다: "R2 ❓ 한 줄" 과 그 아래 "대표 확인: ..." 줄. */
export function verdictsOf(opinion: string): { id: string; mark: string; line: string; ceo: string | null; unsure?: boolean }[] {
  const out: { id: string; mark: string; line: string; ceo: string | null; unsure?: boolean }[] = [];
  for (const block of opinion.split(/\n(?=R\d+\s*(?:✅|⚠|❓))/)) {
    const m = /^(R\d+)\s*(✅|⚠️?|❓)\s*(.*)$/m.exec(block.trim());
    if (!m) continue;
    const ceo = /^(?:대표 확인|CEO check)\s*[:：]\s*(.+)$/m.exec(block)?.[1] ?? null;
    const mark = m[2]!.startsWith('⚠') ? '⚠' : m[2]!;
    // ⚠인데 설명이 "사진으로는 판단할 수 없다"면 문제를 본 것이 아니다(자동 돌려보내기에서 뺀다).
    // 실측(2026-10-01, 물 마시기): "촬영 타이밍 문제, 고장인지 판단할 수 없음"을 ⚠로 적어 멀쩡한 업무가 돌아갔다.
    const unsure =
      mark === '⚠' &&
      /판단할 수 없|확인할 수 없|알 수 없|증명되지 않|찍히지 않|촬영 타이밍|cannot tell|can't tell|not captured|too early/i.test(block);
    out.push({ id: m[1]!, mark, line: m[3]!.trim(), ceo, ...(unsure ? { unsure } : {}) });
  }
  return out;
}

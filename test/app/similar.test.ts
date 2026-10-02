// 후속 업무 제안 중복 거르기(실측 2026-10-03, 4777의 실제 제목).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { similarTitle } from '../../src/app/similar.ts';

test('비슷한 제안: 같은 문제를 다르게 쓴 제목은 같다고 보고, 다른 일은 다르다고 본다', () => {
  const same: [string, string][] = [
    ['game-ui 검사의 Playwright 의존성 해결', 'game-ui 배치/동작 검사의 playwright 모듈 누락 해결'],
    ['research/game-ui-skill 검사 스크립트의 playwright 모듈 탐색 보완', 'game-ui 검사 스크립트의 playwright 해석 경로 수정'],
    ['game-ui-skill 밖 스크립트 7개의 고정 경로 정비', 'game-ui-skill 밖 스크립트 7개의 고정 경로 정리'],
    ['검사 스크립트의 이전 절대 경로 정비', '고정된 절대 경로 검사 스크립트 정비'],
  ];
  for (const [a, b] of same) assert.ok(similarTitle(a, b), `${a} ~ ${b}`);
  const different: [string, string][] = [
    ['docs/2026-09-22.md 빈 파일 정리', '활성 문서의 옛 작업 경로 정리'],
    ['Unity 게임 코드 접근 방법 결정', 'UI 코드 자동 검사 추가 검토'],
    ['02-repo-and-tech.md와 03-readiness.md를 본 저장소에 반영', '01 문서 결정 수 미기재 행 재확인 및 4절 끝 공백 정리'],
  ];
  for (const [a, b] of different) assert.ok(!similarTitle(a, b), `${a} ≁ ${b}`);
});

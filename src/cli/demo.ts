// 데모 회사: 구독 없이 제품 흐름을 체험한다. 성실·게으름·범위 위반 직원이 섞여 있어
// 시스템이 거짓 완료와 범위 밖 수정을 어떻게 잡는지 볼 수 있다.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Company } from '../app/company.ts';
import type { Orchestrator } from '../app/orchestrator.ts';
import { AGENT_IDENTITY, git } from '../workspace/git.ts';

export async function seedDemo(company: Company, orch: Orchestrator, dataDir: string, language = 'ko'): Promise<void> {
  process.env.FAKE_DELAY_MS ??= '2500';
  if (company.projects().length > 0) return;
  const en = language === 'en';
  const L = (ko: string, eng: string) => (en ? eng : ko);

  const repo = path.join(dataDir, 'demo-repo');
  if (!existsSync(repo)) {
    mkdirSync(path.join(repo, 'src'), { recursive: true });
    mkdirSync(path.join(repo, 'docs'), { recursive: true });
    mkdirSync(path.join(repo, 'test'), { recursive: true });
    writeFileSync(path.join(repo, 'README.md'), L('# 데모 게임 서버\n\n대표만 수정할 수 있는 보호 문서입니다.\n', '# Demo game server\n\nProtected file: only the CEO may change it.\n'));
    writeFileSync(path.join(repo, 'src', 'party.js'), 'export function partySize(members) {\n  return members.length;\n}\n');
    writeFileSync(
      path.join(repo, 'test', 'party.test.js'),
      "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { partySize } from '../src/party.js';\n\ntest('party size', () => assert.equal(partySize(['a', 'b']), 2));\n",
    );
    writeFileSync(path.join(repo, 'package.json'), '{ "name": "demo-game", "type": "module", "private": true }\n');
    writeFileSync(path.join(repo, 'docs', 'design.md'), L('# 설계 문서\n\n## 파티 규칙\n- 최대 인원: (미정)\n', '# Design\n\n## Party rules\n- Max party size: (undecided)\n'));
    await git(['init', '-q', '-b', 'main'], repo);
    await git(['add', '-A'], repo);
    await git([...AGENT_IDENTITY, 'commit', '-q', '-m', 'demo: initial'], repo);
  }

  const project = company.registerProject({
    name: L('데모 게임 서버', 'Demo game server'),
    originPath: repo,
    protectedPaths: ['README.md'],
    verifyCommands: [{ label: L('단위 테스트 (node --test)', 'Unit tests (node --test)'), argv: ['node', '--test'], evidenceType: 'unit_test' }],
    integrationMode: 'manual',
    docRules: L('- docs/ 의 담당 문서 본문이 현재 기준이다.\n- 대표가 확정하지 않은 수치는 "(미정)"으로 둔다.', '- The body of docs/ is the source of truth.\n- Numbers the CEO has not decided stay "(undecided)".'),
  });

  company.hireEmployee({ name: L('하나 (성실)', 'Ada (diligent)'), roles: ['implementer'], cli: 'fake', model: 'diligent' });
  company.hireEmployee({ name: L('둘 (게으름)', 'Lou (lazy)'), roles: ['recorder', 'planner'], cli: 'fake', model: 'lazy' });
  company.hireEmployee({ name: L('셋 (QA·비서실장)', 'Quinn (QA, chief of staff)'), roles: ['qa', 'chief-of-staff'], cli: 'fake', model: 'diligent' });
  company.hireEmployee({ name: L('넷 (범위 위반)', 'Rex (rogue)'), roles: ['implementer'], cli: 'fake', model: 'rogue' });

  orch.records.recordDecision(project.id, L('파티 최대 인원은 아직 정하지 않았다. 구현자는 임의로 정하지 않는다.', 'Max party size is not decided yet. Implementers must not pick a number.'));

  company.createTicket({
    projectId: project.id,
    type: 'impl',
    title: L('파티 합류 기능', 'Join a party'),
    purpose: L('새 모험가가 파티에 합류할 수 있게 한다', 'Let a new adventurer join a party'),
    requirements: [{ text: L('합류 함수와 단위 테스트', 'Join function with unit tests'), evidenceType: 'unit_test' }],
    doneCriteria: L('단위 테스트 통과', 'Unit tests pass'),
    writeScope: ['src/**', 'test/**'],
  });
  company.createTicket({
    projectId: project.id,
    type: 'doc',
    title: L('파티 규칙 문서 정리', 'Tidy the party rules doc'),
    purpose: L('설계 문서의 파티 규칙 절을 정리한다', 'Clean up the party rules section'),
    requirements: [{ text: L('파티 규칙 절 갱신 (미정 수치는 미정으로 유지)', 'Update the section, keep undecided numbers undecided'), evidenceType: 'inspection' }],
    doneCriteria: L('검수자가 문서를 확인', 'Reviewer checks the doc'),
    writeScope: ['docs/**'],
  });
  company.createTicket({
    projectId: project.id,
    type: 'review',
    title: L('설계 문서 빈칸·충돌 교차 검토', 'Blind cross-review of design gaps'),
    purpose: L('구현자가 임의로 정해야 하는 빈칸과 문서 충돌을 찾는다 (블라인드 분석 → 교차 판정 → 재답변)', 'Find gaps implementers would have to guess (blind analysis → cross-verdicts → rebuttal)'),
    requirements: [{ text: L('구현자가 임의로 결정해야 하는 빈칸 목록', 'List of gaps implementers would have to decide'), evidenceType: 'inspection' }],
    doneCriteria: L('미해결 이견은 대표에게 상신', 'Unresolved disputes go to the CEO'),
  });
  company.createTicket({
    projectId: project.id,
    type: 'impl',
    title: L('파티 해산 기능', 'Disband a party'),
    purpose: L('파티를 해산할 수 있게 한다', 'Allow disbanding a party'),
    requirements: [{ text: L('해산 함수와 단위 테스트', 'Disband function with unit tests'), evidenceType: 'unit_test' }],
    doneCriteria: L('단위 테스트 통과', 'Unit tests pass'),
    writeScope: ['src/disband/**'],
  });
}

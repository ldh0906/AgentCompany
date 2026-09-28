// 데모 회사: 구독 없이 제품 흐름을 체험한다. 성실·게으름·범위 위반 직원이 섞여 있어
// 시스템이 거짓 완료와 범위 밖 수정을 어떻게 잡는지 볼 수 있다.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Company } from '../app/company.ts';
import type { Orchestrator } from '../app/orchestrator.ts';
import { AGENT_IDENTITY, git } from '../workspace/git.ts';

export async function seedDemo(company: Company, orch: Orchestrator, dataDir: string): Promise<void> {
  process.env.FAKE_DELAY_MS ??= '2500';
  if (company.projects().length > 0) return;

  const repo = path.join(dataDir, 'demo-repo');
  if (!existsSync(repo)) {
    mkdirSync(path.join(repo, 'src'), { recursive: true });
    mkdirSync(path.join(repo, 'docs'), { recursive: true });
    mkdirSync(path.join(repo, 'test'), { recursive: true });
    writeFileSync(path.join(repo, 'README.md'), '# 데모 게임 서버\n\n대표만 수정할 수 있는 보호 문서입니다.\n');
    writeFileSync(path.join(repo, 'src', 'party.js'), 'export function partySize(members) {\n  return members.length;\n}\n');
    writeFileSync(
      path.join(repo, 'test', 'party.test.js'),
      "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { partySize } from '../src/party.js';\n\ntest('파티 인원', () => assert.equal(partySize(['a', 'b']), 2));\n",
    );
    writeFileSync(path.join(repo, 'package.json'), '{ "name": "demo-game", "type": "module", "private": true }\n');
    writeFileSync(path.join(repo, 'docs', 'design.md'), '# 설계 문서\n\n## 파티 규칙\n- 최대 인원: (미정)\n');
    await git(['init', '-q', '-b', 'main'], repo);
    await git(['add', '-A'], repo);
    await git([...AGENT_IDENTITY, 'commit', '-q', '-m', 'demo: initial'], repo);
  }

  const project = company.registerProject({
    name: '데모 게임 서버',
    originPath: repo,
    protectedPaths: ['README.md'],
    verifyCommands: [{ label: '단위 테스트 (node --test)', argv: ['node', '--test'], evidenceType: 'unit_test' }],
    integrationMode: 'manual',
    docRules: '- docs/ 의 담당 문서 본문이 현재 기준이다.\n- 대표가 확정하지 않은 수치는 "(미정)"으로 둔다.',
  });

  company.hireEmployee({ name: '하나 (성실)', roles: ['implementer'], cli: 'fake', model: 'diligent' });
  company.hireEmployee({ name: '둘 (게으름)', roles: ['recorder', 'planner'], cli: 'fake', model: 'lazy' });
  company.hireEmployee({ name: '셋 (QA)', roles: ['qa'], cli: 'fake', model: 'diligent' });
  company.hireEmployee({ name: '넷 (범위 위반)', roles: ['implementer'], cli: 'fake', model: 'rogue' });

  orch.records.recordDecision(project.id, '파티 최대 인원은 아직 정하지 않았다. 구현자는 임의로 정하지 않는다.');

  company.createTicket({
    projectId: project.id,
    type: 'impl',
    title: '파티 합류 기능',
    purpose: '새 모험가가 파티에 합류할 수 있게 한다',
    requirements: [{ text: '합류 함수와 단위 테스트', evidenceType: 'unit_test' }],
    doneCriteria: '단위 테스트 통과',
    writeScope: ['src/**', 'test/**'],
  });
  company.createTicket({
    projectId: project.id,
    type: 'doc',
    title: '파티 규칙 문서 정리',
    purpose: '설계 문서의 파티 규칙 절을 정리한다',
    requirements: [{ text: '파티 규칙 절 갱신 (미정 수치는 미정으로 유지)', evidenceType: 'inspection' }],
    doneCriteria: '검수자가 문서를 확인',
    writeScope: ['docs/**'],
  });
  company.createTicket({
    projectId: project.id,
    type: 'impl',
    title: '파티 해산 기능',
    purpose: '파티를 해산할 수 있게 한다',
    requirements: [{ text: '해산 함수와 단위 테스트', evidenceType: 'unit_test' }],
    doneCriteria: '단위 테스트 통과',
    writeScope: ['src/disband/**'],
  });
}

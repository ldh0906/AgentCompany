// 팀장이 한 명뿐인 회사의 어려운 업무: 멈추지 않고 하위 직급(남은 최고 직급)이 검수, 대표 최종 확인 표시
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { driveUntil, setup } from './helpers.ts';

test('팀장 한 명: 어려운 업무를 팀장이 하고 선임이 검수 → 하위 직급 검수 표시로 대표 승인 대기', { timeout: 120_000 }, async (t) => {
  const env = await setup(t);
  const [impl, qa] = env.company.employees();
  env.company.setEmployeeRank(impl!.id, 'lead');
  const tk = env.company.createTicket({
    projectId: env.projectId,
    type: 'impl',
    title: '어려운 구조 변경',
    purpose: 'p',
    requirements: [{ text: '구조 변경과 단위 테스트', evidenceType: 'unit_test' }],
    doneCriteria: 'd',
    writeScope: ['src/**'],
    difficulty: 'hard',
  });
  const done = await driveUntil(env, tk.id, (x) => x.status === 'awaiting_approval' || x.hold !== null);
  assert.equal(done.status, 'awaiting_approval', `보류: ${done.hold?.note}`);
  assert.equal(done.assigneeId, impl!.id, '팀장이 담당');
  assert.equal(done.reviewerId, qa!.id, '남은 최고 직급(선임)이 검수');
  assert.equal(done.reviewBelowRank, true, '대표 최종 확인을 위한 표시');
});

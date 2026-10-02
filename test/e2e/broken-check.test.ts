// 업무와 무관하게 실패하는 검사(환경 문제 등)는 업무를 막지 않고, 대표에게 한 번 알린다.
// 실측(2026-10-03, 4777 PUBG): playwright가 없어 실패하는 검사 때문에 문서 업무 7개가 모두 대표 결정 보류에 걸렸다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { driveUntil, setup } from './helpers.ts';

test('기준 커밋에서도 실패하는 검사는 업무 탓으로 보지 않고 막지 않는다, 대표에게는 한 번 알린다', { timeout: 180_000 }, async (t) => {
  const env = await setup(t, {
    verify: [
      { label: 'unit tests', argv: ['node', '-e', 'process.exit(0)'], evidenceType: 'unit_test' },
      {
        label: 'game-ui 배치 검사',
        argv: ['node', '-e', 'console.error("Cannot find module \'playwright\'"); process.exit(1)'],
        evidenceType: 'runtime',
      },
    ],
  });
  const mk = (title: string, dir: string) =>
    env.company.createTicket({
      projectId: env.projectId,
      type: 'doc',
      title,
      purpose: 'p',
      requirements: [{ text: '문서를 쓴다', evidenceType: 'inspection' }],
      doneCriteria: 'd',
      writeScope: [`${dir}/**`],
    });
  const a = mk('온보딩 문서', 'docs');
  const b = mk('준비 목록', 'notes');
  for (const tk of [a, b]) {
    const r = await driveUntil(env, tk.id, (x) => ['awaiting_approval', 'done'].includes(x.status) || x.hold !== null, 150_000);
    assert.equal(r.hold, null, `${tk.id} 보류: ${r.hold?.note ?? ''}`);
  }
  const ev = env.orch.records.evidenceFor(a.id).find((e) => e.label.startsWith('game-ui 배치 검사'));
  assert.match(ev!.label, /기준에서도 실패/);
  assert.equal(ev!.passed, false, '실패는 실패로 남긴다(숨기지 않는다)');
  const notices = env.orch.desk.notices().filter((n) => n.title.includes('game-ui 배치 검사'));
  assert.equal(notices.length, 1, '대표에게는 한 번만');
});

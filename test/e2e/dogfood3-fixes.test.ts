// 3차 개선: 확정하면 남은 질문은 제안대로, 직원이 남긴 화면 점검 순서를 기계가 따라 한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { screenStepsOf } from '../../src/agents/report.ts';
import { captureScreens, findChrome } from '../../src/app/screen-check.ts';
import { driveUntil, newImplTicket, setup } from './helpers.ts';

test('초안을 확정하면 답하지 않은 질문은 제안대로 규칙이 된다(제안 없는 질문은 그대로)', { timeout: 30_000 }, async (t) => {
  const env = await setup(t);
  const [emp] = env.company.employees();
  env.orch.records.saveRequest({
    id: 'Q-1',
    projectId: env.projectId,
    text: '최고 점수 표시',
    status: 'drafted',
    employeeId: emp!.id,
    runId: null,
    summary: '',
    drafts: [
      {
        type: 'impl',
        difficulty: 'easy',
        title: '최고 점수 표시',
        purpose: '첫 화면에 최고 점수',
        requirements: [{ text: '최고 점수가 보인다', evidenceType: 'human_attest' }],
        doneCriteria: '대표 확인',
        writeScope: ['src/**'],
        dependsOn: [],
      },
    ],
    questions: ['기록이 없으면?', '글자 색?', '애니메이션?'],
    proposals: ['0을 보여 준다', '초록', null],
    answers: [null, '흰색', null],
    error: null,
    ticketIds: [],
    createdAt: new Date().toISOString(),
  });
  const [tk] = env.orch.acceptRequest('Q-1');
  assert.ok(tk);
  const req = env.orch.records.request('Q-1')!;
  assert.equal(req.status, 'accepted');
  assert.deepEqual(req.answers, ['0을 보여 준다', '흰색', null], '대표 답은 그대로, 빈 질문은 제안대로, 제안 없으면 비움');
  const rules = env.orch.records.decisions(env.projectId, 'current').map((d) => d.text);
  assert.ok(rules.some((d) => d.includes('기록이 없으면? → 0을 보여 준다')));
});

test('화면 점검 순서: 모르는 단계·없는 요구사항·찍기 없는 순서는 버린다', () => {
  const got = screenStepsOf(
    [
      {
        requirementId: 'R1',
        steps: [{ do: 'setStorage', key: 'hs', value: '42' }, { do: 'reload' }, { do: 'eval', code: 'x' }, { do: 'shot', label: '점수' }],
      },
      { requirementId: 'R9', steps: [{ do: 'shot', label: 'x' }] },
      { requirementId: 'R2', steps: [{ do: 'key', key: 'ArrowRight', holdMs: 99_999 }] },
    ],
    ['R1', 'R2'],
  );
  assert.equal(got.length, 1);
  assert.deepEqual(
    got[0]!.steps.map((s) => s.do),
    ['setStorage', 'reload', 'shot'],
  );
  // 실측(Codex): 요구사항 없이 단계만 나열해도 한 순서로 받는다
  const flat = screenStepsOf([{ do: 'setStorage', key: 'k', value: '1' }, { do: 'reload' }, { do: 'shot', label: 'x' }], ['R1']);
  assert.deepEqual(
    flat.map((x) => [x.requirementId, x.steps.length]),
    [['*', 3]],
  );
});

const PAGE = `<!doctype html><body><h1 id="h">대기</h1><button id="go">시작</button><script>
document.getElementById('h').textContent = '최고 ' + (localStorage.getItem('hs') || '0');
document.getElementById('go').onclick = () => console.error('clicked hs=' + localStorage.getItem('hs'));
addEventListener('keydown', (e) => { if (e.code === 'KeyZ') console.error('key ' + e.key); });
</script></body>`;

test(
  '직원이 남긴 순서를 따라 한다: 저장값 넣기 → 새로고침 → 글자로 클릭 → 키 → 찍기',
  { skip: !findChrome(), timeout: 90_000 },
  async () => {
    const server = createServer((_q, r) => r.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE));
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
    try {
      const out = await mkdtemp(path.join(os.tmpdir(), 'ac-steps-'));
      const cap = await captureScreens(url, out, findChrome(), [
        {
          requirementId: 'R1',
          steps: [
            { do: 'setStorage', key: 'hs', value: '42' },
            { do: 'reload' },
            { do: 'click', text: '시작' },
            { do: 'key', key: 'KeyZ' },
            { do: 'click', text: '없는 버튼' },
            { do: 'shot', label: '새로고침 뒤 최고 42' },
          ],
        },
        // 다음 순서는 저장소를 비우고 시작한다
        {
          requirementId: 'R2',
          steps: [
            { do: 'click', selector: '#go' },
            { do: 'shot', label: '빈 저장소' },
          ],
        },
      ]);
      assert.deepEqual(
        cap.shots.map((s) => s.label),
        ['첫 화면', 'R1: 새로고침 뒤 최고 42', 'R2: 빈 저장소', '휴대폰 폭(375px)'],
      );
      assert.ok(
        cap.errors.some((e) => e.includes('clicked hs=42')),
        cap.errors.join('\n'),
      );
      assert.ok(
        cap.errors.some((e) => e.includes('key z')),
        '코드 KeyZ → key z',
      );
      assert.ok(
        cap.errors.some((e) => e.includes('[R1]') && e.includes('없는 버튼')),
        '못 찾은 단계는 오류로 남긴다',
      );
      assert.ok(
        cap.errors.some((e) => e.includes('clicked hs=null')),
        '순서마다 저장소를 비운다',
      );
    } finally {
      server.close();
    }
  },
);

test('범위 밖 수정으로 멈추면 대표가 고른다: 보호 경로는 허용 불가, 되돌리게 하면 수정 요청', { timeout: 120_000 }, async (t) => {
  const env = await setup(t, { implementer: 'rogue' });
  const tk = newImplTicket(env);
  const held = await driveUntil(env, tk.id, (x) => x.hold?.reason === 'needs_permission');
  assert.equal(held.status, 'verifying');
  assert.throws(() => env.orch.resolveScopeHold(tk.id, true), /보호 경로/);
  const back = env.orch.resolveScopeHold(tk.id, false);
  assert.equal(back.status, 'changes_requested');
  assert.equal(back.hold, null);
});

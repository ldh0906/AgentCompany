// 3차 개선: 확정하면 남은 질문은 제안대로, 직원이 남긴 화면 점검 순서를 기계가 따라 한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { screenStepsOf } from '../../src/agents/report.ts';
import { captureScreens, findChrome, inspectDownload } from '../../src/app/screen-check.ts';
import { driveUntil, newImplTicket, setup } from './helpers.ts';
import { requestTokens } from '../../src/app/cost.ts';

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
const dl = document.createElement('button'); dl.textContent = 'CSV 내보내기'; document.body.appendChild(dl);
dl.onclick = () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['\\uFEFF날짜,금액\\n2026-09-30,1000'], { type: 'text/csv' })); a.download = '가계부.csv'; a.click(); };
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
            { do: 'click', text: 'CSV 내보내기' },
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
      const csv = cap.downloads.find((d) => d.name.endsWith('.csv'));
      assert.ok(csv, `내려받은 파일을 모은다: ${JSON.stringify(cap.downloads)}`);
      assert.equal(csv!.text?.bom, true);
      assert.match(csv!.verdict, /엑셀에서 한글이 정상/);
      // 녹화: 조작이 있는 순서마다 한 편, 조작 직후 몇 초만(순서당 최대 40장)
      assert.deepEqual(
        cap.clips.map((c) => c.label),
        ['R1', 'R2'],
      );
      for (const c of cap.clips) assert.ok(c.frames.length > 0 && c.frames.length <= 40, `${c.label}: ${c.frames.length}장`);
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

test('검수 통과하면 자동 반영: 켜 둔 프로젝트에서 대표 확인 항목이 없는 업무만', { timeout: 180_000 }, async (t) => {
  const env = await setup(t);
  env.company.updateProject(env.projectId, { autoApprove: true });
  const plain = newImplTicket(env);
  const done = await driveUntil(env, plain.id, (x) => x.hold !== null || ['done', 'failed'].includes(x.status));
  assert.equal(done.status, 'done', `보류: ${done.hold?.note}`);
  const a = env.orch.records.approvals().find((x) => x.ticketId === plain.id && x.kind === 'integrate')!;
  assert.equal((a.detail as { auto?: boolean }).auto, true, '대표가 누른 승인과 구분해 기록한다');

  const attest = env.company.createTicket({
    projectId: env.projectId,
    type: 'impl',
    title: '화면',
    purpose: '눈으로 확인',
    requirements: [{ text: '보기 좋다', evidenceType: 'human_attest' }],
    doneCriteria: '대표 확인',
    writeScope: ['src/**'],
  });
  const waiting = await driveUntil(env, attest.id, (x) => x.hold !== null || x.status === 'awaiting_approval');
  await env.orch.tick();
  assert.equal(env.company.requireTicket(attest.id).status, 'awaiting_approval', '대표 확인 항목이 있으면 대표를 기다린다');
  assert.equal(waiting.hold, null);
});

test('내려받은 CSV 판정: BOM이 없으면 엑셀 한글 깨짐 경고, UTF-8이 아니면 알림', () => {
  assert.match(inspectDownload('a.csv', Buffer.from('날짜,금액\n', 'utf8')).verdict, /깨질 수/);
  assert.match(inspectDownload('a.csv', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('날짜', 'utf8')])).verdict, /정상/);
  assert.match(inspectDownload('a.csv', Buffer.from([0xb3, 0xaf, 0xc2, 0xa5])).verdict, /UTF-8이 아닙니다/);
  assert.equal(inspectDownload('a.png', Buffer.from([1, 2, 3])).text, undefined);
});

test('내려받은 파일 미리보기는 앞뒤를 함께 보여 준다(합계 행이 끝에 있다)', () => {
  const rows = ['날짜,금액', ...Array.from({ length: 10 }, (_, i) => `2026-09-${10 + i},${i}`), '합계,45'].join('\n');
  const p = inspectDownload('a.csv', Buffer.from(rows, 'utf8')).text!.preview;
  assert.match(p, /^날짜,금액/);
  assert.match(p, /…/);
  assert.match(p, /합계,45$/);
});

test('혼자 하기엔 크면 담당자가 나눈다: 조각은 다른 직원이 맡고, 끝나면 원래 업무가 이어서 마무리한다', { timeout: 240_000 }, async (t) => {
  const env = await setup(t, { implementer: 'splitter' });
  env.company.updateProject(env.projectId, { autoApprove: true });
  const parent = newImplTicket(env);
  const held = await driveUntil(env, parent.id, (x) => x.hold?.reason === 'waiting_dependency' || x.status === 'done');
  assert.equal(held.hold?.reason, 'waiting_dependency', '나누면 조각을 기다린다');
  const parts = env.company.tickets().filter((x) => x.id !== parent.id);
  assert.equal(parts.length, 2);
  assert.deepEqual(held.dependsOn.sort(), parts.map((p) => p.id).sort());
  assert.ok(parts.every((p) => p.difficulty === 'normal' && p.writeScope[0]!.startsWith('src/')));
  assert.ok(env.orch.chat.messages('general', 50).some((m) => /나눴습니다/.test(m.text)));
  const done = await driveUntil(
    env,
    parent.id,
    (x) => x.status === 'done' || (x.hold !== null && x.hold.reason !== 'waiting_dependency'),
    180_000,
  );
  assert.equal(done.status, 'done', `보류: ${done.hold?.note}`);
  assert.ok(parts.every((p) => env.company.requireTicket(p.id).status === 'done'));
  // 조각은 다시 나누지 않는다(조각 업무의 지시에는 나누기 규칙이 없다)
  assert.equal(env.company.tickets().length, 3);
});

test('범위 밖 파일이 필요하면 담당자가 허가를 요청하고, 대표가 한 번에 허용하면 이어서 한다', { timeout: 180_000 }, async (t) => {
  const env = await setup(t, { implementer: 'scoper' });
  const tk = newImplTicket(env);
  const held = await driveUntil(env, tk.id, (x) => x.hold !== null);
  assert.equal(held.hold?.reason, 'needs_decision');
  assert.match(held.hold!.note, /extra\/fix\.md/);
  assert.deepEqual(env.orch.scopeRequestOf(tk.id)?.paths, ['extra/fix.md']);
  assert.throws(() => env.orch.addWriteScope(tk.id, ['README.md']), /보호/, '보호된 파일은 허용 불가');
  const next = env.orch.addWriteScope(tk.id, ['extra/fix.md']);
  assert.equal(next.hold, null, '요청한 파일을 허용하면 바로 다시 돈다');
  assert.ok(next.writeScope.includes('extra/fix.md'));
  const waiting = await driveUntil(env, tk.id, (x) => x.hold !== null || x.status === 'awaiting_approval');
  assert.equal(waiting.status, 'awaiting_approval', `보류: ${waiting.hold?.note}`);
});

test('대표 알림: 할 일 목록(승인·결정)과 요청이 모두 끝났다는 알림', { timeout: 180_000 }, async (t) => {
  const env = await setup(t);
  const tk = newImplTicket(env);
  const [emp] = env.company.employees();
  env.orch.records.saveRequest({
    id: 'Q-9',
    projectId: env.projectId,
    text: '버전 표시',
    status: 'accepted',
    employeeId: emp!.id,
    runId: null,
    summary: '',
    drafts: [],
    questions: [],
    error: null,
    ticketIds: [tk.id],
    createdAt: new Date().toISOString(),
  });
  await driveUntil(env, tk.id, (x) => x.status === 'awaiting_approval');
  assert.ok(
    env.orch.desk.ceoTodos().some((x) => x.kind === 'approval' && x.link === `/tickets/${tk.id}`),
    '승인이 할 일에 뜬다',
  );
  const a = env.orch.records.pendingApprovalFor(tk.id, 'integrate')!;
  env.orch.decideIntegration(a.id, 'approved');
  await driveUntil(env, tk.id, (x) => x.status === 'done');
  assert.equal(env.orch.desk.ceoTodos().length, 0, '처리하면 할 일에서 빠진다');
  assert.ok(
    env.orch.desk.notices().some((n) => /요청이 끝났습니다/.test(n.title)),
    '요청의 업무가 모두 끝나면 알린다',
  );
  // 요청별 비용 보고: 알림에 합계와 업무별 토큰
  const used = requestTokens(env.orch.records, { id: 'Q-9', ticketIds: [tk.id] });
  assert.ok(used.total > 0 && used.byTicket[tk.id] === used.total, '초안 실행이 없으면 업무 토큰이 곧 합계');
  assert.match(env.orch.desk.notices().at(-1)!.body, new RegExp(`토큰 약 .+ 사용 \\(${tk.id} `));
});

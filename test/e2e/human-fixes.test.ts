// "사람 대표" 실측(2026-10-01, 눈 휴식 앱) 수정: 확인할 수 없는 걸 체크하게 만들지 않기, 열어 볼 페이지, 지시문.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDraftPrompt, buildWorkPrompt } from '../../src/agents/prompt.ts';
import { pageOf } from '../../src/agents/report.ts';
import { nodeTestArgs } from '../../src/app/repo-inspect.ts';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { driveUntil, newImplTicket, setup, statusIs } from './helpers.ts';
import { ticketChannelId } from '../../src/app/chat.ts';

test('나중에 확인: 확인 못 한 항목은 체크 대신 미루고 반영, 할 일에 남았다가 확인/문제로 끝난다', { timeout: 180_000 }, async (t) => {
  const env = await setup(t);
  env.company.hireEmployee({ name: '팀장', roles: ['chief-of-staff', 'planner'], cli: 'fake', model: 'diligent' });
  const tk = env.company.createTicket({
    projectId: env.projectId,
    type: 'impl',
    title: '알림음',
    purpose: '작고 부드러운 소리',
    requirements: [
      { text: '들어 보면 작고 부드럽다', evidenceType: 'human_attest' },
      { text: '끝날 때 더 작은 소리', evidenceType: 'human_attest' },
    ],
    doneCriteria: '대표 확인',
    writeScope: ['src/**'],
  });
  await driveUntil(env, tk.id, statusIs('awaiting_approval'));
  const a = env.orch.records.pendingApprovalFor(tk.id, 'integrate')!;
  const [r1, r2] = env.company.requireTicket(tk.id).requirements;
  assert.throws(() => env.orch.decideIntegration(a.id, 'approved', { attested: [r1!.id] }), /확인하고 체크/, '그냥은 안 된다');
  env.orch.decideIntegration(a.id, 'approved', { attested: [r1!.id], deferred: [r2!.id] });
  await driveUntil(env, tk.id, statusIs('done'));
  assert.deepEqual(
    env.orch.laterChecks(tk.id).map((x) => x.id),
    [r2!.id],
  );
  assert.ok(
    env.orch.desk.ceoTodos().some((x) => x.kind === 'later' && x.link === `/tickets/${tk.id}`),
    '대표 할 일에 남는다',
  );
  assert.ok(
    env.orch.records.evidenceFor(tk.id).every((e) => e.requirementId !== r2!.id),
    '미룬 항목은 확인 기록을 남기지 않는다(확인한 척 하지 않음)',
  );

  // 문제가 있으면 비서실장에게 고칠 요청이 간다
  const { requestId } = await env.orch.resolveLaterCheck(tk.id, r2!.id, false, '끝나는 소리가 안 들려요');
  assert.ok(requestId);
  assert.match(env.orch.records.request(requestId!)!.text, /끝날 때 더 작은 소리[\s\S]*끝나는 소리가 안 들려요/);
  assert.equal(env.orch.laterChecks(tk.id).length, 0);
  assert.ok(!env.orch.desk.ceoTodos().some((x) => x.kind === 'later'));
  await assert.rejects(env.orch.resolveLaterCheck(tk.id, r2!.id, true), /나중에 확인할 항목이 아닙니다/);
});

test('열어 볼 페이지 경로: 폴더 안 .html만 받는다', () => {
  assert.equal(pageOf('src/sound/demo.html'), 'src/sound/demo.html');
  assert.equal(pageOf('./demo.htm'), 'demo.htm');
  assert.equal(pageOf('src\\sound\\demo.html'), 'src/sound/demo.html');
  for (const bad of ['../x.html', '/etc/x.html', 'C:/x.html', 'src/app.js', '', 3]) assert.equal(pageOf(bad), null, String(bad));
});

test('지시문: 대표 확인은 화면이 생기는 업무에만, 기다려야 보이는 건 빠른 확인 방법, 열어 볼 페이지', async (t) => {
  const env = await setup(t);
  const [emp] = env.company.employees();
  const project = env.company.requireProject(env.projectId);
  const draft = buildDraftPrompt({ employee: emp!, project, requestId: 'Q', request: 'x', nonce: 'n', decisions: [], language: 'ko' });
  assert.match(draft, /only on a ticket whose result the CEO can actually open/);
  assert.match(draft, /quick-check way/);
  const ticket = env.company.createTicket({
    projectId: env.projectId,
    type: 'impl',
    title: '휴식 화면',
    purpose: '20분마다',
    requirements: [{ text: '휴식 화면이 뜬다', evidenceType: 'human_attest' }],
    doneCriteria: '대표 확인',
    writeScope: ['src/**'],
  });
  const work = buildWorkPrompt({ employee: emp!, project, ticket, nonce: 'n', decisions: [], feedback: null, language: 'ko' });
  assert.match(work, /checkable within a minute/);
  assert.match(work, /"previewPage"/);
});

test('검증 명령: node --test에 폴더를 주면 그 안의 테스트 파일 패턴으로 바꿔 실행한다(Node 22+는 폴더를 못 연다)', () => {
  const d = mkdtempSync(path.join(os.tmpdir(), 'ac-nt-'));
  try {
    mkdirSync(path.join(d, 'tests', 'sound'), { recursive: true });
    assert.deepEqual(nodeTestArgs(['node', '--test', 'tests/'], d), ['node', '--test', 'tests/**/*.test.*', 'tests/**/*.spec.*']);
    assert.deepEqual(nodeTestArgs(['node', '--test', 'tests/a.test.js'], d), ['node', '--test', 'tests/a.test.js'], '파일은 그대로');
    assert.deepEqual(nodeTestArgs(['node', '--test'], d), ['node', '--test']);
    assert.deepEqual(nodeTestArgs(['npm', 'test'], d), ['npm', 'test']);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('시험용 파일만 더 쓰겠다는 요청은 대표에게 묻지 않고 바로 허용한다', { timeout: 180_000 }, async (t) => {
  const env = await setup(t, { implementer: 'testscoper' });
  const tk = newImplTicket(env);
  const done = await driveUntil(env, tk.id, (x) => x.status === 'awaiting_approval' || x.hold !== null, 120_000);
  assert.equal(done.hold, null, '대표 결정으로 멈추지 않는다');
  assert.ok(done.writeScope.includes('tests/extra.test.js'));
  assert.ok(env.orch.chat.messages(ticketChannelId(tk.id)).some((m) => /시험용 파일이라 바로 허용/.test(m.text)));
});

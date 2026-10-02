// 요청 단위 V모델: 업무가 다 끝나면 인수 시험 → 떨어진 항목은 고칠 업무 → 끝나면 다시 시험(대표 요청 2026-10-02).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AcceptanceHost } from '../../src/app/acceptance.ts';
import type { CeoRequest, RunRecord } from '../../src/app/records.ts';
import type { Ticket } from '../../src/core/types.ts';
import { requestTokens } from '../../src/app/cost.ts';
import { findChrome } from '../../src/app/screen-check.ts';
import { AGENT_IDENTITY, git } from '../../src/workspace/git.ts';
import { setup } from './helpers.ts';

test('인수 시험: 1회차에서 떨어진 항목은 고칠 업무가 되고, 그 업무가 끝나면 2회차로 통과한다', { timeout: 420_000 }, async (t) => {
  const env = await setup(t, { integrationMode: 'auto_after_approval' });
  env.company.hireEmployee({ name: '팀장', roles: ['chief-of-staff'], cli: 'fake', model: 'diligent', rank: 'lead' });
  env.orch.delegation.set(true); // 승인은 위임: 루프가 대표 없이 끝까지 도는지 본다
  const req = await env.orch.submitRequest(env.projectId, '파티 해산 기능');
  await env.orch.idle();
  const deadline = Date.now() + 380_000;
  const rounds = () => env.orch.records.request(req.id)?.acceptanceRounds ?? [];
  while (!(rounds().length >= 2 && rounds()[1]!.state === 'done')) {
    if (Date.now() > deadline)
      throw new Error(
        `시간 초과: ${JSON.stringify(rounds().map((r) => [r.round, r.state, r.fixTickets]))} ${env.company
          .tickets()
          .map((x) => `${x.id}:${x.status}:${x.hold?.reason ?? ''}`)
          .join(' ')}`,
      );
    await env.orch.tick();
    await new Promise((r) => setTimeout(r, 50));
  }
  const accepted = env.orch.records.request(req.id)!;
  assert.equal(accepted.acceptance?.length, 2, '비서실장이 초안 때 정한 인수 시험');
  const [r1, r2] = rounds();
  assert.deepEqual(
    r1!.results.map((r) => r.mark),
    ['✅', '⚠'],
  );
  assert.equal(r1!.fixTickets.length, 1, '떨어진 항목마다 고칠 업무');
  const fix = env.company.requireTicket(r1!.fixTickets[0]!);
  assert.match(fix.title, /^\[인수 1\]/);
  assert.ok(accepted.ticketIds.includes(fix.id), '고칠 업무가 요청에 붙는다');
  assert.equal(fix.status, 'done');
  assert.deepEqual(
    r2!.results.map((r) => r.mark),
    ['✅', '✅'],
  );
  assert.equal(r2!.fixTickets.length, 0);
  // 인수 시험 방에 든 토큰도 요청 비용에 들어간다
  assert.ok('acceptance' in requestTokens(env.orch.records, accepted).byTicket);
});

test(
  '인수 시험 화면 사진: 반영된 결과를 띄워 찍고, 대표가 띄운 게 아니면 다시 끈다',
  { skip: !findChrome(), timeout: 120_000 },
  async (t) => {
    const env = await setup(t, { screenCheck: true });
    writeFileSync(join(env.origin, 'index.html'), '<!doctype html><body><h1>단어 퀴즈</h1></body>');
    await git(['add', '-A'], env.origin);
    await git([...AGENT_IDENTITY, 'commit', '-q', '-m', 'page'], env.origin);
    const project = env.company.requireProject(env.projectId);
    const out = join(env.dataDir, 'acc-shots', '.acceptance-shots');
    const screens = await (env.orch as unknown as { acceptanceScreens: AcceptanceHost['acceptanceScreens'] }).acceptanceScreens(
      project,
      [{ requirementId: 'T-1 R2', steps: [{ do: 'shot', label: '첫 화면' }] }],
      out,
    );
    assert.ok(screens && screens.shots.length > 0, '사진을 찍는다');
    assert.ok(
      screens.shots.every((s) => s.file.startsWith('.acceptance-shots/')),
      '시험 직원 폴더 기준 경로',
    );
    assert.ok(
      screens.shots.some((s) => s.label.includes('T-1 R2')),
      '어느 업무의 점검 순서인지 사진 이름에 남는다',
    );
    assert.match(screens.text, /단어 퀴즈/);
    assert.ok(!env.orch.previewList().some((p) => p.projectId === env.projectId && p.state === 'running'), '시험용으로 띄운 것은 끈다');
    // 화면이 아닌 결과물은 찍지 않는다
    const doc = { ...project, profile: { ...project.profile!, deliverable: 'document' as const } };
    assert.equal(
      await (env.orch as unknown as { acceptanceScreens: AcceptanceHost['acceptanceScreens'] }).acceptanceScreens(doc, [], out),
      null,
    );
  },
);

test('인수 시험을 끈 프로젝트는 요청이 끝나도 시험하지 않는다', async (t) => {
  const env = await setup(t);
  env.company.updateProject(env.projectId, { acceptanceTests: false });
  const req = { id: 'Q-off', projectId: env.projectId, text: 'r', ticketIds: ['T-1'], acceptance: [{ id: 'A1', check: 'c', how: 'h' }] };
  await env.orch.acceptance.onRequestDone(req as unknown as CeoRequest, [{ id: 'T-1', status: 'done' } as Ticket]);
  assert.equal(env.orch.records.request('Q-off'), null, '시험 기록을 만들지 않는다');
  assert.ok(!env.company.store.getSetting('acceptance_room:Q-off'), '시험 방도 만들지 않는다');
});

/** 인수 시험 답을 바로 넣어 본다(실제 실행 없이): 요청 하나와 nonce를 만들어 onChatReply를 부른다. */
function replyWith(env: Awaited<ReturnType<typeof setup>>, json: Record<string, unknown>) {
  const req = {
    id: 'Q-fix',
    projectId: env.projectId,
    text: '기획서',
    status: 'accepted',
    employeeId: 'E',
    runId: null,
    summary: '',
    drafts: [],
    questions: [],
    ticketIds: [],
    acceptance: [
      { id: 'A1', check: 'c1', how: 'h' },
      { id: 'A2', check: 'c2', how: 'h' },
      { id: 'A3', check: 'c3', how: 'h' },
    ],
    createdAt: new Date().toISOString(),
  } as unknown as CeoRequest;
  env.orch.records.saveRequest(req);
  env.company.store.setSetting('acceptance_nonce:n1', JSON.stringify({ requestId: req.id, round: 1 }));
  const text = '```json\n' + JSON.stringify({ nonce: 'n1', kind: 'chat', reply: 'r', ...json }) + '\n```';
  env.orch.acceptance.onChatReply({ id: 'R-1', nonce: 'n1' } as RunRecord, 'r', text);
  return env.orch.records.request(req.id)!;
}

const fix = (title: string, scope: string[], forId: string) => ({
  title,
  purpose: title,
  requirements: [{ text: title, evidenceType: 'inspection' }],
  writeScope: scope,
  difficulty: 'easy',
  for: forId,
});

test('인수 시험 고칠 업무: 같은 파일을 고치는 수정은 한 업무로 합치고, 다른 파일은 따로 만든다', async (t) => {
  const env = await setup(t);
  const r = replyWith(env, {
    results: [
      { id: 'A1', mark: '⚠', why: '일정' },
      { id: 'A2', mark: '⚠', why: '이유' },
      { id: 'A3', mark: '⚠', why: '표' },
    ],
    fixes: [
      fix('회차표 고치기', ['docs/plan.md'], 'A1'),
      fix('선정 이유 넣기', ['docs/plan.md'], 'A2'),
      fix('조사표 보완', ['research/**'], 'A3'),
    ],
  });
  const created = r.acceptanceRounds![0]!.fixTickets.map((id) => env.company.requireTicket(id));
  assert.equal(created.length, 2, '기획서 수정 둘은 하나로');
  const merged = created.find((x) => x.writeScope.includes('docs/plan.md'))!;
  assert.equal(merged.requirements.length, 2);
  assert.match(merged.title, /회차표 고치기 · 선정 이유 넣기/);
  assert.match(merged.purpose, /A1, A2/);
});

test('인수 시험: 다 통과해도 검수자가 짚은 작은 실수가 남았으면 고치고, ❓는 대표 할 일로 알린다', async (t) => {
  const env = await setup(t);
  const r = replyWith(env, {
    results: [
      { id: 'A1', mark: '✅', why: 'ok' },
      { id: 'A2', mark: '✅', why: 'ok' },
      { id: 'A3', mark: '❓', why: '도서관(02-449-8855)에 세미나실 요금을 전화로 물어보세요' },
    ],
    fixes: [fix('5·6월 장르 표기 맞추기', ['docs/books.md'], 'review')],
  });
  assert.equal(r.acceptanceRounds![0]!.fixTickets.length, 1, '검수 메모로 고칠 업무');
  // 고칠 업무가 없으면 ❓는 알림에 대표 할 일로 남는다
  const r2 = replyWith(env, {
    results: [
      { id: 'A1', mark: '✅', why: 'ok' },
      { id: 'A3', mark: '❓', why: '도서관에 전화로 요금 확인' },
    ],
    fixes: [],
  });
  assert.equal(r2.acceptanceRounds![0]!.fixTickets.length, 0);
  assert.ok(env.orch.desk.notices().some((n) => /대표가 직접 확인할 것: A3 도서관에 전화로 요금 확인/.test(n.body)));
});

test('검수자의 작은 실수는 마지막 승인 검수에서 가져온다', async (t) => {
  const env = await setup(t);
  const review = (id: string, verdict: string, minorFixes: string[]) =>
    ({
      id,
      ticketId: 'T-x',
      kind: 'review',
      status: 'succeeded',
      startedAt: `2026-10-02T00:00:0${id.at(-1) === 'a' ? 1 : id.at(-1) === 'b' ? 2 : 3}Z`,
      report: { kind: 'review', verdict, minorFixes },
    }) as unknown as RunRecord;
  env.orch.records.saveRun(review('R-a', 'approve', ['옛 메모']));
  env.orch.records.saveRun(review('R-b', 'request_changes', ['반려 때 메모']));
  env.orch.records.saveRun(review('R-c', 'approve', ['5·6월 장르 표기']));
  assert.deepEqual(env.orch.records.minorFixesOf('T-x'), ['5·6월 장르 표기']);
  assert.deepEqual(env.orch.records.minorFixesOf('T-none'), []);
});

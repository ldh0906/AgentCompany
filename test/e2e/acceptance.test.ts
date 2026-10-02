// 요청 단위 V모델: 업무가 다 끝나면 인수 시험 → 떨어진 항목은 고칠 업무 → 끝나면 다시 시험(대표 요청 2026-10-02).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AcceptanceHost } from '../../src/app/acceptance.ts';
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

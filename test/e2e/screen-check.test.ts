// 자동 화면 점검: 대표 직접 확인 요구가 있는 업무가 승인 대기에 오면, 앱이 결과물을 띄워 화면을 찍고 QA 직원 의견을 받는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { findChrome } from '../../src/app/screen-check.ts';
import { ticketChannelId } from '../../src/app/chat.ts';
import { AGENT_IDENTITY, git } from '../../src/workspace/git.ts';
import { driveUntil, setup } from './helpers.ts';

test('승인 대기에 오면 띄워서 세 장을 찍고, QA 직원이 의견을 업무방에 단다', { skip: !findChrome(), timeout: 180_000 }, async (t) => {
  const env = await setup(t, { screenCheck: true });
  writeFileSync(join(env.origin, 'index.html'), '<!doctype html><body><h1>데모 게임</h1><canvas width="320" height="200"></canvas></body>');
  await git(['add', '-A'], env.origin);
  await git([...AGENT_IDENTITY, 'commit', '-q', '-m', 'page'], env.origin);
  const ticket = env.company.createTicket({
    projectId: env.projectId,
    type: 'impl',
    title: '화면 연출',
    purpose: '런타임에서 눈으로 확인해야 하는 기능',
    requirements: [{ text: '첫 화면에 게임 제목이 보인다', evidenceType: 'human_attest' }],
    doneCriteria: '대표가 직접 확인',
    writeScope: ['src/**'],
  });
  const waiting = await driveUntil(env, ticket.id, (x) => x.hold !== null || x.status === 'awaiting_approval');
  assert.equal(waiting.status, 'awaiting_approval', `보류: ${waiting.hold?.note}`);
  const deadline = Date.now() + 90_000;
  let view = env.orch.screenCheckView(ticket.id);
  while (Date.now() < deadline && !(view?.state === 'failed' || view?.opinion)) {
    await env.orch.tick();
    await new Promise((r) => setTimeout(r, 300));
    view = env.orch.screenCheckView(ticket.id);
  }
  assert.equal(view?.state, 'done', view?.note ?? '');
  assert.equal(view!.shots.length, 4);
  assert.ok(view!.opinion, 'QA 의견이 승인 카드에 붙는다');
  assert.equal(view!.qaBy, env.company.employees().find((e) => e.name === 'QA 직원')!.id, '담당자가 아닌 QA가 본다');
  const imgs = await env.orch.screenImages(ticket.id);
  assert.equal(imgs.length, 4);
  assert.match(imgs[0]!.dataUrl, /^data:image\/png;base64,/);
  const room = env.orch.chat.messages(ticketChannelId(ticket.id), 100);
  assert.ok(room.some((m) => /자동 화면 점검/.test(m.text)));
  assert.ok(
    env.orch.previewList().some((p) => p.ticketId === ticket.id && p.state === 'running'),
    '대표도 바로 해 볼 수 있게 띄운 채 둔다',
  );

  // 같은 제출물로는 다시 찍지 않는다
  const at = view!.at;
  await env.orch.tick();
  assert.equal(env.orch.screenCheckView(ticket.id)!.at, at);

  // 끝나면 정리: 내려받은 파일·녹화 폴더는 지우고 사진은 남긴다
  const approval = env.orch.records.pendingApprovalFor(ticket.id, 'integrate')!;
  env.orch.decideIntegration(approval.id, 'approved', { attested: ['R1'] });
  await driveUntil(env, ticket.id, (x) => x.status === 'done');
  (env.orch as unknown as { lastScreenSweep: number }).lastScreenSweep = 0;
  await env.orch.tick();
  const dir = join(env.dataDir, 'screens', ticket.id);
  const [sha] = readdirSync(dir);
  assert.ok(!existsSync(join(dir, sha!, 'downloads')), '내려받은 파일 폴더를 지운다');
  assert.ok(existsSync(join(dir, sha!, '1.png')), '사진은 남긴다');
});

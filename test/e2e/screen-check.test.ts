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
  let view = env.orch.screens.screenCheckView(ticket.id);
  while (Date.now() < deadline && !(view?.state === 'failed' || view?.opinion)) {
    await env.orch.tick();
    await new Promise((r) => setTimeout(r, 300));
    view = env.orch.screens.screenCheckView(ticket.id);
  }
  assert.equal(view?.state, 'done', view?.note ?? '');
  assert.equal(view!.shots.length, 4);
  assert.ok(view!.opinion, 'QA 의견이 승인 카드에 붙는다');
  assert.equal(view!.qaBy, env.company.employees().find((e) => e.name === 'QA 직원')!.id, '담당자가 아닌 QA가 본다');
  const imgs = await env.orch.screens.screenImages(ticket.id);
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
  assert.equal(env.orch.screens.screenCheckView(ticket.id)!.at, at);

  // 끝나면 정리: 내려받은 파일·녹화 폴더는 지우고 사진은 남긴다
  const approval = env.orch.records.pendingApprovalFor(ticket.id, 'integrate')!;
  env.orch.decideIntegration(approval.id, 'approved', { attested: ['R1'] });
  await driveUntil(env, ticket.id, (x) => x.status === 'done');
  (env.orch.screens as unknown as { lastScreenSweep: number }).lastScreenSweep = 0;
  await env.orch.tick();
  const dir = join(env.dataDir, 'screens', ticket.id);
  const [sha] = readdirSync(dir);
  assert.ok(!existsSync(join(dir, sha!, 'downloads')), '내려받은 파일 폴더를 지운다');
  assert.ok(existsSync(join(dir, sha!, '1.png')), '사진은 남긴다');
});

test(
  '화면 QA가 문제(⚠)를 찾으면 대표를 거치지 않고 돌려보낸다: 두 번까지, 그다음은 대표에게',
  { skip: !findChrome(), timeout: 300_000 },
  async (t) => {
    const env = await setup(t, { screenCheck: true, reviewer: 'picky' });
    env.company.updateProject(env.projectId, { profile: { summary: 'PC 웹 게임', mobile: false, game: true } });
    writeFileSync(join(env.origin, 'index.html'), '<!doctype html><body><h1>데모 게임</h1></body>');
    await git(['add', '-A'], env.origin);
    await git([...AGENT_IDENTITY, 'commit', '-q', '-m', 'page'], env.origin);
    const ticket = env.company.createTicket({
      projectId: env.projectId,
      type: 'impl',
      title: '제목 화면',
      purpose: '눈으로 확인',
      requirements: [{ text: '제목이 잘리지 않는다', evidenceType: 'human_attest' }],
      doneCriteria: '대표 확인',
      writeScope: ['src/**'],
    });
    // QA가 두 번 돌려보내고(회차가 3까지 오름), 세 번째 문제는 대표에게 넘긴다.
    const deadline = Date.now() + 240_000;
    for (;;) {
      await env.orch.tick();
      const stopped = env.orch.chat.messages(`t:${ticket.id}`, 300).some((m) => /두 번까지/.test(m.text));
      if (stopped) break;
      if (Date.now() > deadline)
        throw new Error(`시간 초과: ${env.company.requireTicket(ticket.id).status} r${env.company.requireTicket(ticket.id).round}`);
      await new Promise((r) => setTimeout(r, 300));
    }
    const final = env.company.requireTicket(ticket.id);
    assert.equal(final.status, 'awaiting_approval', '세 번째는 대표에게 넘긴다');
    assert.equal(final.round, 3, '두 번 돌려보냈다');
    assert.equal(env.store.getSetting(`qa_rejects:${ticket.id}`), '2');
    assert.ok(env.orch.chat.messages('general', 200).some((m) => /돌려보냈습니다/.test(m.text)));
    // PC 전용이면 휴대폰 폭 사진이 없다
    assert.ok(!env.orch.screens.screenCheckView(ticket.id)!.shots.some((s) => /휴대폰/.test(s.label)));
  },
);

test(
  '고급 QA: 업무를 직접 플레이하게 하고 결과를 기록·알림, 게임이면 요청이 끝날 때 자동으로 한 번',
  { skip: !findChrome(), timeout: 240_000 },
  async (t) => {
    const env = await setup(t);
    env.company.updateProject(env.projectId, { profile: { summary: 'PC 게임', mobile: false, game: true }, autoPlaytest: true });
    writeFileSync(join(env.origin, 'index.html'), '<!doctype html><meta charset="utf-8"><body><h1>데모 게임</h1></body>');
    await git(['add', '-A'], env.origin);
    await git([...AGENT_IDENTITY, 'commit', '-q', '-m', 'page'], env.origin);
    // 게임 코드를 바꾸는 업무(문서만 바꾼 요청은 자동 플레이를 하지 않는다: 실행할 게 없다)
    const tk = env.company.createTicket({
      projectId: env.projectId,
      type: 'impl',
      title: '보스 패턴',
      purpose: '게임 코드 수정',
      requirements: [{ text: '보스가 두 번째 패턴을 쓴다', evidenceType: 'unit_test' }],
      doneCriteria: 'd',
      writeScope: ['src/game.js'],
    });
    await driveUntil(env, tk.id, (x) => x.status === 'awaiting_approval');
    await env.orch.playtests.startPlaytest({ ticketId: tk.id }, 'ceo');
    const waitDone = async (key: string) => {
      const deadline = Date.now() + 60_000;
      while (env.orch.playtests.playtestOf(key)?.state === 'running' || !env.orch.playtests.playtestOf(key)) {
        if (Date.now() > deadline) throw new Error('시간 초과');
        await env.orch.tick();
        await new Promise((r) => setTimeout(r, 300));
      }
      return env.orch.playtests.playtestOf(key)!;
    };
    const p = await waitDone(tk.id);
    assert.equal(p.state, 'done');
    assert.match(p.opinion ?? '', /R1 ✅/);
    assert.ok(env.orch.desk.notices().some((n) => /고급 QA 결과/.test(n.title)));
    assert.ok(existsSync(join(p.dir, 'play')), 'QA가 쓸 ./play 명령이 있다');

    // 요청이 끝나면 자동으로
    const [emp] = env.company.employees();
    env.orch.records.saveRequest({
      id: 'Q-7',
      projectId: env.projectId,
      text: '데모',
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
    env.orch.decideIntegration(env.orch.records.pendingApprovalFor(tk.id, 'integrate')!.id, 'approved');
    await driveUntil(env, tk.id, (x) => x.status === 'done');
    const auto = await waitDone('Q:Q-7');
    assert.equal(auto.by, 'auto');
    assert.equal(auto.state, 'done');
  },
);

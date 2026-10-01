// 멈춘 실행: 출력이 10분 넘게 없으면 대표 할 일·알림에 뜨고, 대표가 끊으면 메모와 함께 다시 시킨다.
// 실측(첫 사용, 2026-10-01): 직원이 띄운 시험 스크립트가 끝나지 않아 업무가 10분 넘게 멈췄는데 대표에게 알릴 길이 없었다.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { ticketChannelId } from '../../src/app/chat.ts';
import { Orchestrator } from '../../src/app/orchestrator.ts';
import { driveUntil, newImplTicket, setup, statusIs } from './helpers.ts';

test('조용한 실행은 할 일에 뜨고, 끊으면 다시 시켜 끝까지 간다', { timeout: 180_000 }, async (t) => {
  const env = await setup(t);
  const before = process.env.FAKE_DELAY_MS;
  process.env.FAKE_DELAY_MS = '120000'; // 첫 실행은 2분 동안 아무 출력 없이 기다린다
  t.after(() => {
    if (before === undefined) delete process.env.FAKE_DELAY_MS;
    else process.env.FAKE_DELAY_MS = before;
  });
  const tk = newImplTicket(env);
  await driveUntil(env, tk.id, statusIs('in_progress'));
  const run = env.orch.records.runsForTicket(tk.id).at(-1)!;
  assert.equal(env.orch.stalledRuns().length, 0, '막 시작한 실행은 멈춘 게 아니다');
  // 직원 프로세스가 뜰 때까지(pid.json에 CLI pid가 적힌 뒤)
  for (
    let i = 0;
    i < 200 &&
    !/"cliPid":\d/.test(existsSync(path.join(run.runDir, 'pid.json')) ? readFileSync(path.join(run.runDir, 'pid.json'), 'utf8') : '');
    i++
  )
    await new Promise((r) => setTimeout(r, 50));

  mock.timers.enable({ apis: ['Date'], now: Date.now() + Orchestrator.STALL_MS + 60_000 });
  t.after(() => mock.timers.reset());
  await env.orch.tick();
  assert.deepEqual(
    env.orch.stalledRuns().map((s) => s.runId),
    [run.id],
  );
  assert.ok(
    env.orch.desk.ceoTodos().some((x) => x.kind === 'stalled' && x.link === `/live/${run.id}`),
    '대표 할 일에 뜬다',
  );
  assert.ok(
    env.orch.desk.notices().some((n) => /아무 신호가 없습니다/.test(n.title)),
    '알림도 한 번',
  );
  mock.timers.reset();

  process.env.FAKE_DELAY_MS = '300'; // 다시 시킨 실행은 정상
  await env.orch.restartRun(run.id);
  const done = await driveUntil(env, tk.id, statusIs('awaiting_approval'), 120_000);
  assert.equal(done.runCount, 2, '끊은 실행도 1회로 센다');
  assert.equal(env.orch.records.run(run.id)!.status, 'failed');
  assert.ok(
    env.orch.chat.messages(ticketChannelId(tk.id)).some((m) => m.author === 'ceo' && /끝나지 않는 명령/.test(m.text)),
    '다음 지시에 들어갈 대표 메모를 남긴다',
  );
  const second = env.orch.records.runsForTicket(tk.id).find((r) => r.kind === 'work' && r.id !== run.id)!;
  assert.match(readFileSync(path.join(second.runDir, 'prompt.md'), 'utf8'), /끝나지 않는 명령/, '다시 시킨 실행의 지시에 들어간다');
  await assert.rejects(env.orch.restartRun(run.id), /이미 끝난/);
});

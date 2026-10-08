// CLI 옵션 점검(실행 전): 설치된 CLI의 도움말에 우리가 쓰는 것이 없으면 띄우지 않고 이유와 함께 멈춘다.
// CLI가 고쳐지면(다시 점검) 보류를 풀어 이어간다(OpenRig 비교 2026-10-08).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeAdapter } from '../../src/adapters/fake.ts';
import { driveUntil, newImplTicket, setup, statusIs } from './helpers.ts';

test('업데이트로 쓰는 하위 명령이 없어진 CLI는 실행 전에 멈추고, 고쳐지면 이어간다', { timeout: 180_000 }, async (t) => {
  const env = await setup(t);
  const help = ['-e', 'process.stdout.write("Commands:\\n  run   Run a task")'];
  fakeAdapter.helpChecks = [{ args: help, tokens: ['app-server'] }];
  t.after(() => delete fakeAdapter.helpChecks);
  const tk = newImplTicket(env);
  const held = await driveUntil(env, tk.id, (x) => x.hold !== null, 120_000);
  assert.equal(held.hold?.reason, 'needs_decision');
  assert.match(held.hold!.note, /app-server/);
  const run = env.orch.records.runsForTicket(tk.id).find((r) => r.kind === 'work')!;
  assert.equal(run.pid, null, '프로세스를 띄우지 않았다');
  assert.deepEqual((JSON.parse(env.store.getSetting('cli_caps:fake')!) as { missing: string[] }).missing, ['app-server']);
  assert.ok(env.store.events('fake', 50).some((e) => e.type === 'cli.incompatible'));

  // CLI가 고쳐졌다: 다시 점검하고 보류를 풀면 끝까지 간다
  // 고쳐진 CLI: 정상 도움말(Usage·Commands)에 app-server가 있다 — 도움말로 인식한 뒤 통과해야 한다
  fakeAdapter.helpChecks = [
    { args: ['-e', 'process.stdout.write("Usage: fake [OPTIONS]\\nCommands:\\n  app-server   Run")'], tokens: ['app-server'] },
  ];
  env.orch.forgetCliCaps();
  env.orch.releaseHold(tk.id);
  const done = await driveUntil(env, tk.id, statusIs('awaiting_approval'), 120_000);
  assert.equal(done.hold, null);
  const caps = JSON.parse(env.store.getSetting('cli_caps:fake')!) as { missing: string[]; error?: string };
  assert.deepEqual([caps.missing, caps.error], [[], undefined], '도움말로 인식해 확인한 결과다(근거 없음으로 통과한 것이 아니다)');
});

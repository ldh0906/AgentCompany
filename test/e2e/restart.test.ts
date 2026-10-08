import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Store } from '../../src/store/db.ts';
import { Company } from '../../src/app/company.ts';
import { Orchestrator } from '../../src/app/orchestrator.ts';
import { isAlive } from '../../src/runner/process.ts';
import { driveUntil, newImplTicket, setup, statusIs } from './helpers.ts';

const here = path.dirname(fileURLToPath(import.meta.url));

test('데몬이 직원 실행 도중 강제 종료돼도, 새 데몬이 같은 실행에 재연결해 끝까지 진행', { timeout: 180_000 }, async (t) => {
  const env = await setup(t, { implementer: 'slow' });
  const ticket = newImplTicket(env);
  env.store.close(); // 첫 데몬(자식 프로세스)이 DB를 쓰게 한다

  process.env.FAKE_DELAY_MS = '6000';
  const child = spawn(process.execPath, ['--no-warnings', path.join(here, 'daemon-child.ts'), env.dbPath, env.dataDir, ticket.id], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const line = await new Promise<string>((resolve, reject) => {
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += String(d);
      if (buf.includes('\n')) resolve(buf.trim());
    });
    child.once('exit', (c) => reject(new Error(`첫 데몬이 먼저 종료됨: ${c}`)));
  });
  const [, runId, pidText] = line.split(' ');
  const agentPid = Number(pidText);
  child.kill('SIGKILL'); // 데몬만 강제 종료(직원 프로세스는 살아 있음)
  await new Promise((r) => child.once('exit', r));
  assert.ok(isAlive(agentPid), '데몬이 죽어도 직원 CLI는 계속 실행 중');

  // 두 번째 데몬
  const store2 = new Store(env.dbPath);
  const company2 = new Company(store2);
  const orch2 = new Orchestrator(company2, { dataDir: env.dataDir });
  const report = await orch2.recover();
  assert.equal(report.chainOk, true);
  assert.deepEqual(report.reattached, [runId], '살아 있는 실행에 재연결');
  // 복구 기록: 실행마다 판단 근거가 남고, 다음 시작까지 대표가 볼 수 있다
  assert.equal(report.runs?.[0]?.action, 'reattached');
  assert.match(report.runs![0]!.reason, /같은 프로세스가 살아 있음/);
  assert.deepEqual(
    orch2.lastRecovery()?.runs?.map((r) => r.runId),
    [runId],
  );

  const env2 = { ...env, store: store2, company: company2, orch: orch2 };
  const t2 = await driveUntil(env2, ticket.id, (x) => x.status === 'awaiting_approval' || x.hold !== null, 120_000);
  assert.equal(t2.status, 'awaiting_approval', `보류: ${t2.hold?.note}`);
  const run = orch2.records.run(runId!);
  assert.equal(run?.status, 'succeeded', '재시작 전 시작한 실행의 결과를 파일에서 수거');
  assert.equal(t2.runCount, 1, '같은 실행을 이어받았고 다시 실행하지 않음');
  delete process.env.FAKE_DELAY_MS;
  await orch2.idle();
  store2.close();
});

test('데몬이 꺼져 있는 동안 직원 실행이 끝났어도, 재시작 시 파일에서 결과를 수거', { timeout: 180_000 }, async (t) => {
  const env = await setup(t, { implementer: 'slow' });
  const ticket = newImplTicket(env);
  env.store.close();
  process.env.FAKE_DELAY_MS = '1500';
  const child = spawn(process.execPath, ['--no-warnings', path.join(here, 'daemon-child.ts'), env.dbPath, env.dataDir, ticket.id], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const line = await new Promise<string>((resolve) => child.stdout.on('data', (d) => resolve(String(d).trim())));
  const agentPid = Number(line.split(' ')[2]);
  child.kill('SIGKILL');
  while (isAlive(agentPid)) await new Promise((r) => setTimeout(r, 200)); // 데몬 없이 직원 실행 종료
  delete process.env.FAKE_DELAY_MS;

  const store2 = new Store(env.dbPath);
  const orch2 = new Orchestrator(new Company(store2), { dataDir: env.dataDir });
  const report = await orch2.recover();
  assert.equal(report.ingestedAfterRestart.length, 1);
  assert.equal(report.orphaned.length, 0);
  assert.equal(report.runs?.[0]?.action, 'collected');
  assert.match(report.runs![0]!.reason, /종료 기록 있음: 종료 코드 0/);
  assert.equal(report.runs![0]!.status, 'succeeded', '처리한 뒤의 상태');
  const env2 = { ...env, store: store2, company: orch2.company, orch: orch2 };
  const done = await driveUntil(env2, ticket.id, statusIs('awaiting_approval'), 120_000);
  assert.equal(done.status, 'awaiting_approval');
  await orch2.idle();
  store2.close();
});

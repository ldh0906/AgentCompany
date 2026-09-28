// Codex 5차 검수(2026-09-28) 지적의 회귀 테스트
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { abandonAndTerminate, isAlive, startProcess } from '../../src/runner/process.ts';
import { setup } from './helpers.ts';

function tmp(t: { after: (fn: () => void) => void }): string {
  const d = mkdtempSync(path.join(tmpdir(), 'ac-rf4-'));
  t.after(() => rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  return d;
}

test('[P1] 셔틀은 죽었지만 CLI가 살아 있으면 복구가 CLI를 정리', { timeout: 30_000 }, async (t) => {
  const d = tmp(t);
  const runDir = path.join(d, 'run');
  mkdirSync(runDir);
  const started = Date.now();
  const cli = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
    stdio: 'ignore',
    windowsHide: true,
    detached: process.platform !== 'win32',
  });
  await new Promise((r) => cli.once('spawn', r));
  writeFileSync(path.join(runDir, 'pid.json'), JSON.stringify({ shimPid: 999_998, cliPid: cli.pid, startedAtMs: started }));
  assert.ok(isAlive(cli.pid!));
  await abandonAndTerminate(runDir);
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(isAlive(cli.pid!), false, '고아 CLI 종료');
});

test('[P1] 남은 검증 실행 기록은 실행 폴더를 유지해 재시작 후 정리할 수 있음', { timeout: 60_000 }, async (t) => {
  const env = await setup(t);
  const runDir = path.join(env.dataDir, 'leftover-verify');
  const proc = await startProcess({
    file: process.execPath,
    args: ['-e', 'setInterval(()=>{},1000)'],
    cwd: env.root,
    env: process.env,
    stdinText: null,
    runDir,
    timeoutMs: 60_000,
  });
  env.store.setSetting('verify_proc:T-9', JSON.stringify({ runDir }));
  await (env.orch as unknown as { stopLeftoverVerify: (id: string) => Promise<void> }).stopLeftoverVerify('T-9');
  const o = await proc.done;
  assert.ok(o.killed || o.exitCode !== 0 || o.signal !== null, '이전 검증 프로세스가 종료됨');
  assert.equal(env.store.getSetting('verify_proc:T-9'), '');
});

test('[P1] 복구가 포기 표시를 남긴 뒤 시작하는 셔틀은 CLI를 띄우지 않음', { timeout: 30_000 }, async (t) => {
  const d = tmp(t);
  const runDir = path.join(d, 'run');
  mkdirSync(runDir);
  const marker = path.join(d, 'ran.txt');
  const done = abandonAndTerminate(runDir); // 표시를 먼저 쓰고 1.5초 기다림
  await new Promise((r) => setTimeout(r, 100));
  const proc = await startProcess({
    file: process.execPath,
    args: ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`],
    cwd: d,
    env: process.env,
    stdinText: null,
    runDir,
    timeoutMs: 10_000,
  });
  await Promise.all([done, proc.done]);
  const { existsSync } = await import('node:fs');
  assert.equal(existsSync(marker), false);
});

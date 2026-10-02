// 앱이 강제로 꺼져 남은 "실행해 보기" 서버 정리(실측 2026-10-03: vite 미리보기가 며칠씩 남아 있었다).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { killStalePreviews } from '../../src/app/preview.ts';

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test(
  '남은 미리보기 정리: 이 회사 폴더의 preview 안에서 도는 것만 끄고, 이름이 비슷한 다른 회사 폴더는 건드리지 않는다',
  { timeout: 30_000 },
  async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), 'ac-stale-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const mine = path.join(root, 'Company');
    const other = path.join(root, 'Company-dogfood');
    // 실제 vite 대신 오래 도는 node를 띄우고, 명령줄에 미리보기 경로를 넣는다(파일은 없어도 된다)
    const keep = 'setInterval(() => {}, 1000)';
    const leftover = spawn(process.execPath, ['-e', keep, path.join(mine, 'projects', 'P-1', 'preview', 'T-1', 'vite.js')], {
      stdio: 'ignore',
    });
    const bystander = spawn(process.execPath, ['-e', keep, path.join(other, 'projects', 'P-1', 'preview', 'T-1', 'vite.js')], {
      stdio: 'ignore',
    });
    t.after(() => {
      for (const c of [leftover, bystander]) if (c.exitCode === null) c.kill();
    });
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(await killStalePreviews(mine), 1);
    const deadline = Date.now() + 10_000;
    while (alive(leftover.pid!) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
    assert.equal(alive(leftover.pid!), false, '이 회사의 남은 미리보기는 꺼진다');
    assert.equal(alive(bystander.pid!), true, '다른 회사(이름이 앞부분만 같은 폴더)의 미리보기는 그대로');
  },
);

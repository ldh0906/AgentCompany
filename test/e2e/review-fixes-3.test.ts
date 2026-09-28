// Codex 3차 검수(2026-09-28) 지적의 회귀 테스트
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../../src/store/db.ts';
import { Records } from '../../src/app/records.ts';
import { acquireLock, releaseLock } from '../../src/cli/commands.ts';
import { git, gitOut } from '../../src/workspace/git.ts';
import {
  commitWorktree,
  ensureTicketWorktree,
  integrateAsBranch,
  integrateWithMerge,
  projectPaths,
  syncMirror,
} from '../../src/workspace/workspace.ts';
import { driveUntil, makeOrigin, newImplTicket, setup, statusIs } from './helpers.ts';

function tmp(t: { after: (fn: () => void) => void }): string {
  const d = mkdtempSync(path.join(tmpdir(), 'ac-rf3-'));
  t.after(() => rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  return d;
}

test('[P1] 과거 기록된 값으로 ref를 되돌려도 면제되지 않음 (전이 기록만 면제)', (t) => {
  const d = tmp(t);
  const s = new Store(path.join(d, 'c.db'));
  const r = new Records(s);
  r.recordRefMove('P', 'origin', 'refs/heads/main', 'M0', 'M1'); // 예전 정상 반영
  const window = r.currentMoveSeq(); // 이후 대표가 M2를 커밋했고, 실행이 시작됨
  assert.equal(r.explainedByMoves('P', 'origin', 'refs/heads/main', 'M2', 'M1', window), false, '직원이 M1로 되돌림 → 위반');
  r.recordRefMove('P', 'origin', 'refs/heads/main', 'M2', 'M3'); // 실행 중 정상 반영
  assert.equal(r.explainedByMoves('P', 'origin', 'refs/heads/main', 'M2', 'M3', window), true);
  assert.equal(r.explainedByMoves('P', 'origin', 'refs/heads/ac/T-9', undefined, 'X', window), false, '기록 없는 새 ref');
  s.close();
});

test('[P2] 같은 Store 실행 중 끝부분 삭제 뒤 추가해도 탐지 유지', (t) => {
  const d = tmp(t);
  const s = new Store(path.join(d, 'c.db'));
  for (let i = 0; i < 3; i++) s.appendEvent('ceo', 'x', 'E', { i });
  s.db.prepare('DELETE FROM events WHERE seq = 3').run();
  s.appendEvent('ceo', 'after', 'E', {});
  s.appendEvent('ceo', 'after', 'E', {});
  const r = s.verifyEventChain();
  s.close();
  assert.equal(r.ok, false);
});

test('[P1] 데몬 잠금: OS 배타 잠금이라 두 번째 시작은 거부되고, 소유자가 놓으면 다시 얻을 수 있음', (t) => {
  const d = tmp(t);
  assert.equal(acquireLock(d), true);
  assert.equal(acquireLock(d), false, '같은 데이터 폴더로 두 번째 데몬 불가');
  writeFileSync(path.join(d, 'daemon.lock'), JSON.stringify({ pid: 999_999, url: '', startedAt: '' }));
  assert.equal(acquireLock(d), false, '정보용 잠금 파일을 조작해도 실제 잠금은 유지');
  releaseLock();
  assert.equal(acquireLock(d), true, '소유자가 놓으면(프로세스 종료 포함) 다시 얻음');
  releaseLock();
});

test('[P1] 원본의 다른 worktree가 기준 브랜치를 체크아웃 중이면 자동 병합하지 않고, 체크아웃된 브랜치는 갱신 거부', async (t) => {
  const root = tmp(t);
  const origin = await makeOrigin(root);
  await git(['checkout', '-q', '-b', 'feature'], origin);
  await git(['worktree', 'add', '-q', path.join(root, 'linked-main'), 'main'], origin);
  const paths = projectPaths(path.join(root, 'data'), 'P');
  await syncMirror(origin, paths, 'main');
  const wt = await ensureTicketWorktree(paths, 'T-1', 'main');
  writeFileSync(path.join(wt.path, 'src', 'b.ts'), '1');
  const sha = (await commitWorktree(wt, 'x'))!;
  const mainBefore = await gitOut(['rev-parse', 'main'], origin);
  const r = await integrateWithMerge(origin, paths, 'T-1', 'main', sha, '기능');
  assert.equal(r.kind, 'downgraded');
  assert.equal(await gitOut(['rev-parse', 'main'], origin), mainBefore, '연결 worktree의 main은 그대로');
  // ac/T-1이 어딘가에 체크아웃되어 있으면 브랜치 갱신도 거부
  await git(['worktree', 'add', '-q', path.join(root, 'linked-ac'), 'ac/T-1'], origin);
  writeFileSync(path.join(wt.path, 'src', 'c.ts'), '2');
  const sha2 = (await commitWorktree(wt, 'y'))!;
  await assert.rejects(integrateAsBranch(origin, paths, 'T-1', sha2), /체크아웃/);
});

test('[P1] 실행 후 검사가 실패하면 제출로 인정하지 않음', { timeout: 120_000 }, async (t) => {
  const env = await setup(t);
  (env.orch as unknown as { postWork: () => Promise<void> }).postWork = async () => {
    throw new Error('원본 검사 불가');
  };
  const tk = newImplTicket(env);
  const r = await driveUntil(env, tk.id, (x) => x.runCount >= 1 && x.status === 'assigned');
  assert.equal(r.status, 'assigned', '제출(verifying)로 가지 않고 실행 중단 처리');
  const run = env.orch.records.runsForTicket(tk.id).at(-1)!;
  assert.equal(run.status, 'failed');
  assert.match(run.reportError ?? '', /원본 검사 불가/);
});

const EVIL_ON_MERGE =
  "const c=require('child_process');const p=c.execSync('git rev-list --parents -n 1 HEAD').toString().trim().split(' ');" +
  "if(p.length>2)require('fs').writeFileSync(require('path').join(process.env.AC_TEST_ORIGIN,'pwn-merge.txt'),'x')";

test('[P1] 병합 재검증이 원본을 건드리면 브랜치 반영으로 강등하지 않고 반영 자체를 중단', { timeout: 180_000 }, async (t) => {
  const env = await setup(t, {
    integrationMode: 'auto_after_approval',
    verify: [{ label: 'merge-only evil', argv: ['node', '-e', EVIL_ON_MERGE], evidenceType: 'unit_test' }],
  });
  process.env.AC_TEST_ORIGIN = env.origin;
  t.after(() => {
    delete process.env.AC_TEST_ORIGIN;
  });
  const tk = newImplTicket(env);
  await driveUntil(env, tk.id, statusIs('awaiting_approval'));
  env.orch.decideIntegration(env.orch.records.pendingApprovalFor(tk.id, 'integrate')!.id, 'approved');
  const r = await driveUntil(env, tk.id, (x) => x.hold !== null || x.status === 'done');
  assert.equal(r.status, 'awaiting_approval');
  assert.equal(r.hold?.reason, 'needs_decision');
  assert.ok(existsSync(path.join(env.origin, 'pwn-merge.txt')));
  assert.equal((await git(['branch', '--list', 'ac/*'], env.origin)).stdout.trim(), '', '브랜치도 반영하지 않음');
});

test('[P1] 검증 중 재시작해도 기준 스냅샷이 남아, 중단 전의 원본 변경을 새 기준으로 받아들이지 않음', { timeout: 120_000 }, async (t) => {
  const env = await setup(t);
  const project = env.company.requireProject(env.projectId);
  const paths = projectPaths(env.dataDir, env.projectId);
  await syncMirror(env.origin, paths, 'main');
  // 1차 검증 시도가 기준을 남긴 뒤 원본을 바꾸고 데몬이 죽었다고 가정
  await (env.orch as unknown as { verifyBaseline: (...a: unknown[]) => Promise<unknown> }).verifyBaseline(
    'verify_base:T-1',
    project,
    paths,
  );
  writeFileSync(path.join(env.origin, 'left-by-interrupted-verify.txt'), 'x');
  const tk = newImplTicket(env);
  const r = await driveUntil(env, tk.id, (x) => x.hold !== null || x.status === 'awaiting_approval');
  assert.equal(r.hold?.reason, 'needs_permission');
  assert.match(r.hold!.note, /검증 명령 실행 중 원본 저장소 변경/);
});

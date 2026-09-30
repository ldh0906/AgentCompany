import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git, gitOut, AGENT_IDENTITY } from '../../src/workspace/git.ts';
import {
  changedPaths,
  checkScope,
  commitWorktree,
  ensureDetachedWorktree,
  ensureTicketWorktree,
  integrateAsBranch,
  integrateWithMerge,
  originFingerprint,
  projectPaths,
  refChanges,
  scopesOverlap,
  snapshotRefs,
  syncMirror,
} from '../../src/workspace/workspace.ts';

async function setup(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), 'ac-ws-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const origin = join(root, 'origin');
  mkdirSync(origin);
  await git(['init', '-q', '-b', 'main'], origin);
  mkdirSync(join(origin, 'src'));
  writeFileSync(join(origin, 'src', 'app.ts'), 'export const x = 1;\n');
  writeFileSync(join(origin, 'README.md'), '# demo\n');
  await git(['add', '-A'], origin);
  await git([...AGENT_IDENTITY, 'commit', '-q', '-m', 'init'], origin);
  const paths = projectPaths(join(root, 'data'), 'P-1');
  return { root, origin, paths };
}

test('미러 → 티켓 worktree → 커밋 → 변경 경로(한글 파일명 포함) → 범위 검사', async (t) => {
  const { origin, paths } = await setup(t);
  const fp = await originFingerprint(origin);
  await syncMirror(origin, paths, 'main');
  assert.equal((await git(['remote'], paths.mirror)).stdout.trim(), '', '미러에는 원격이 없어야 함');

  const wt = await ensureTicketWorktree(paths, 'T-1', 'main');
  writeFileSync(join(wt.path, 'src', 'app.ts'), 'export const x = 2;\n');
  writeFileSync(join(wt.path, 'src', '한글 파일.ts'), 'export {};\n');
  const head = await commitWorktree(wt, 'T-1 round 1');
  assert.ok(head);
  const changed = await changedPaths(paths.mirror, wt.baseSha, head!);
  assert.deepEqual(changed, ['src/app.ts', 'src/한글 파일.ts']);
  assert.equal(checkScope(changed, ['src/**'], []).ok, true);

  writeFileSync(join(wt.path, 'README.md'), 'hacked\n');
  const head2 = await commitWorktree(wt, 'T-1 round 2');
  const changed2 = await changedPaths(paths.mirror, wt.baseSha, head2!);
  const scope = checkScope(changed2, ['src/**'], ['README.md']);
  assert.equal(scope.ok, false);
  assert.deepEqual(scope.outOfScope, ['README.md']);
  assert.deepEqual(scope.protectedTouched, ['README.md']);

  assert.equal(await originFingerprint(origin), fp, '반영 전 원본 저장소는 그대로여야 함');
  assert.equal(await commitWorktree(wt, 'no change'), null, '변경 없으면 커밋하지 않음');
});

test('ref 스냅샷으로 담당 브랜치 외 변경 탐지', async (t) => {
  const { origin, paths } = await setup(t);
  await syncMirror(origin, paths, 'main');
  const wt = await ensureTicketWorktree(paths, 'T-1', 'main');
  const before = await snapshotRefs(paths.mirror);
  writeFileSync(join(wt.path, 'src', 'b.ts'), '1');
  await commitWorktree(wt, 'x');
  await git(['branch', 'sneaky'], wt.path);
  const after = await snapshotRefs(paths.mirror);
  assert.deepEqual(refChanges(before, after, ['refs/heads/ac/T-1']), ['refs/heads/sneaky']);
});

test('검증용 분리 worktree는 제출 SHA의 깨끗한 사본', async (t) => {
  const { origin, paths } = await setup(t);
  await syncMirror(origin, paths, 'main');
  const wt = await ensureTicketWorktree(paths, 'T-1', 'main');
  writeFileSync(join(wt.path, 'src', 'b.ts'), 'v1');
  const sha = (await commitWorktree(wt, 'x'))!;
  writeFileSync(join(wt.path, 'src', 'dirty.ts'), '커밋 안 된 변경');
  const v = await ensureDetachedWorktree(paths, 'verify', 'T-1', sha);
  assert.equal(await gitOut(['rev-parse', 'HEAD'], v), sha);
  assert.equal((await git(['status', '--porcelain'], v)).stdout.trim(), '');
  writeFileSync(join(v, 'junk.txt'), 'x');
  await ensureDetachedWorktree(paths, 'verify', 'T-1', sha);
  assert.equal((await git(['status', '--porcelain'], v)).stdout.trim(), '', '재사용 시 정리됨');
});

test('manual 반영: 원본에 브랜치만 생성, 승인 후 head가 바뀌면 거부', async (t) => {
  const { origin, paths } = await setup(t);
  await syncMirror(origin, paths, 'main');
  const wt = await ensureTicketWorktree(paths, 'T-1', 'main');
  writeFileSync(join(wt.path, 'src', 'b.ts'), '1');
  const sha = (await commitWorktree(wt, 'x'))!;
  const mainBefore = await gitOut(['rev-parse', 'main'], origin);
  await assert.rejects(integrateAsBranch(origin, paths, 'T-1', 'deadbeef'), /바뀌었습니다/);
  const r = await integrateAsBranch(origin, paths, 'T-1', sha);
  assert.equal(r.kind, 'branch');
  assert.equal(await gitOut(['rev-parse', 'ac/T-1'], origin), sha);
  assert.equal(await gitOut(['rev-parse', 'main'], origin), mainBefore, 'main은 그대로');
});

test('auto 반영: 깨끗한 체크아웃이면 fast-forward 병합', async (t) => {
  const { origin, paths } = await setup(t);
  await syncMirror(origin, paths, 'main');
  const wt = await ensureTicketWorktree(paths, 'T-1', 'main');
  writeFileSync(join(wt.path, 'src', 'b.ts'), '1');
  const sha = (await commitWorktree(wt, 'x'))!;
  const r = await integrateWithMerge(origin, paths, 'T-1', 'main', sha, '기능', async () => ({ ok: true }));
  assert.equal(r.kind, 'merged');
  if (r.kind !== 'merged') return;
  assert.equal(await gitOut(['rev-parse', 'main'], origin), r.mergeSha);
  assert.equal((await git(['status', '--porcelain'], origin)).stdout.trim(), '');
});

test('auto 반영: 원본 작업 트리가 더러우면 브랜치 반영으로 강등', async (t) => {
  const { origin, paths } = await setup(t);
  await syncMirror(origin, paths, 'main');
  const wt = await ensureTicketWorktree(paths, 'T-1', 'main');
  writeFileSync(join(wt.path, 'src', 'b.ts'), '1');
  const sha = (await commitWorktree(wt, 'x'))!;
  writeFileSync(join(origin, 'README.md'), '대표가 작업 중인 변경\n');
  const mainBefore = await gitOut(['rev-parse', 'main'], origin);
  const r = await integrateWithMerge(origin, paths, 'T-1', 'main', sha, '기능');
  assert.equal(r.kind, 'downgraded');
  assert.equal(await gitOut(['rev-parse', 'main'], origin), mainBefore);
  assert.match((await git(['status', '--porcelain'], origin)).stdout, /README/, '대표 변경은 보존');
});

test('auto 반영: 재검증 실패 시 강등', async (t) => {
  const { origin, paths } = await setup(t);
  await syncMirror(origin, paths, 'main');
  const wt = await ensureTicketWorktree(paths, 'T-1', 'main');
  writeFileSync(join(wt.path, 'src', 'b.ts'), '1');
  const sha = (await commitWorktree(wt, 'x'))!;
  const r = await integrateWithMerge(origin, paths, 'T-1', 'main', sha, '기능', async () => ({ ok: false, reason: '테스트 실패' }));
  assert.equal(r.kind, 'downgraded');
});

test('auto 반영: 기준 브랜치가 체크아웃되지 않았으면 ref만 fast-forward', async (t) => {
  const { origin, paths } = await setup(t);
  await git(['checkout', '-q', '-b', 'other'], origin);
  await syncMirror(origin, paths, 'main');
  const wt = await ensureTicketWorktree(paths, 'T-1', 'main');
  writeFileSync(join(wt.path, 'src', 'b.ts'), '1');
  const sha = (await commitWorktree(wt, 'x'))!;
  const r = await integrateWithMerge(origin, paths, 'T-1', 'main', sha, '기능');
  assert.equal(r.kind, 'merged');
  if (r.kind === 'merged') assert.equal(await gitOut(['rev-parse', 'main'], origin), r.mergeSha);
  assert.equal((await git(['symbolic-ref', '--short', 'HEAD'], origin)).stdout.trim(), 'other');
});

test('쓰기 범위 겹침 판정', () => {
  assert.equal(scopesOverlap(['src/auth/**'], ['src/**']), true);
  assert.equal(scopesOverlap(['src/auth/**'], ['docs/**']), false);
  assert.equal(scopesOverlap(['README.md'], ['README.md']), true);
});

test('범위·보호 경로는 점으로 시작하는 이름도 맞춘다', () => {
  // 실측: src/ui/** 안의 src/ui/.gitignore가 범위 밖으로 막혔다
  assert.equal(checkScope(['src/ui/.gitignore', 'src/.cache/a.js'], ['src/**'], []).ok, true);
  // 보호 경로 docs/**는 docs/.env도 지킨다
  assert.deepEqual(checkScope(['docs/.env'], ['**'], ['docs/**']).protectedTouched, ['docs/.env']);
  // 패턴에 적은 점 이름은 그대로
  assert.equal(checkScope(['.github/workflows/ci.yml'], ['.github/**'], []).ok, true);
  assert.equal(checkScope(['.github/workflows/ci.yml'], ['src/**'], []).ok, false);
});

// 작업공간: 원본 저장소 → (bare 미러) → 티켓 worktree / 검증 worktree → 승인 후 원본 반영.
// 직원은 원본 저장소를 절대 직접 만지지 않는다.

import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { AGENT_IDENTITY, git, gitOut, splitZ } from './git.ts';

export interface ProjectPaths {
  root: string;       // <dataDir>/projects/<projectId>
  mirror: string;     // bare 미러
  worktrees: string;  // 티켓 worktree 상위
  verify: string;     // 검증 worktree 상위
  review: string;     // 검수용 읽기 사본 상위
}

export function projectPaths(dataDir: string, projectId: string): ProjectPaths {
  const root = path.join(dataDir, 'projects', projectId);
  return {
    root,
    mirror: path.join(root, 'mirror.git'),
    worktrees: path.join(root, 'wt'),
    verify: path.join(root, 'verify'),
    review: path.join(root, 'review'),
  };
}

export function ticketBranch(ticketId: string): string {
  return `ac/${ticketId}`;
}

/** 미러를 만들거나 원본의 기준 브랜치를 가져와 갱신한다. 미러에는 원격이 없다(직원이 push할 곳이 없음). */
export async function syncMirror(originPath: string, paths: ProjectPaths, baseBranch: string): Promise<string> {
  if (!existsSync(paths.mirror)) {
    await mkdir(paths.root, { recursive: true });
    await git(['clone', '--bare', '--local', '--no-tags', originPath, paths.mirror], paths.root);
    await git(['remote', 'remove', 'origin'], paths.mirror, { allowFail: true });
    await git(['config', 'core.longpaths', 'true'], paths.mirror);
  }
  await git(['fetch', '--no-tags', originPath, `+refs/heads/${baseBranch}:refs/heads/${baseBranch}`], paths.mirror);
  return gitOut(['rev-parse', `refs/heads/${baseBranch}`], paths.mirror);
}

export interface TicketWorktree {
  path: string;
  branch: string;
  baseSha: string;
}

/** 티켓 전용 worktree. 이미 있으면 재사용한다(수정 회차가 바뀌어도 같은 작업공간). */
export async function ensureTicketWorktree(paths: ProjectPaths, ticketId: string, baseBranch: string): Promise<TicketWorktree> {
  const wtPath = path.join(paths.worktrees, ticketId);
  const branch = ticketBranch(ticketId);
  if (!existsSync(wtPath)) {
    await mkdir(paths.worktrees, { recursive: true });
    const exists = (await git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], paths.mirror, { allowFail: true })).code === 0;
    if (exists) await git(['worktree', 'add', wtPath, branch], paths.mirror);
    else await git(['worktree', 'add', '-b', branch, wtPath, `refs/heads/${baseBranch}`], paths.mirror);
  }
  const baseSha = await gitOut(['merge-base', `refs/heads/${baseBranch}`, `refs/heads/${branch}`], paths.mirror);
  return { path: wtPath, branch, baseSha };
}

/** 직원 실행이 끝난 뒤 오케스트레이터가 대신 커밋한다. 변경이 없으면 null. */
export async function commitWorktree(wt: TicketWorktree, message: string): Promise<string | null> {
  await git(['add', '-A'], wt.path);
  const staged = await git(['diff', '--cached', '--quiet'], wt.path, { allowFail: true });
  if (staged.code === 0) return null;
  await git([...AGENT_IDENTITY, 'commit', '--no-verify', '-q', '-m', message], wt.path);
  return gitOut(['rev-parse', 'HEAD'], wt.path);
}

export async function headSha(repoOrWt: string, ref = 'HEAD'): Promise<string> {
  return gitOut(['rev-parse', ref], repoOrWt);
}

/** base..head 사이에 바뀐 경로(이름 변경은 옛 경로와 새 경로 모두). */
export async function changedPaths(repo: string, baseSha: string, head: string): Promise<string[]> {
  const out = (await git(['diff', '--name-status', '-z', '--find-renames', `${baseSha}..${head}`], repo)).stdout;
  const parts = splitZ(out);
  const paths = new Set<string>();
  for (let i = 0; i < parts.length; ) {
    const status = parts[i++]!;
    if (status.startsWith('R') || status.startsWith('C')) {
      paths.add(parts[i++]!);
      paths.add(parts[i++]!);
    } else {
      paths.add(parts[i++]!);
    }
  }
  return [...paths].sort();
}

export async function diffText(repo: string, baseSha: string, head: string, maxBytes = 2_000_000): Promise<string> {
  const out = (await git(['diff', '--find-renames', `${baseSha}..${head}`], repo)).stdout;
  return out.length > maxBytes ? out.slice(0, maxBytes) + '\n... (잘림)' : out;
}

export interface ScopeCheck {
  ok: boolean;
  outOfScope: string[];
  protectedTouched: string[];
}

/** Windows·macOS 기본 파일시스템은 대소문자를 구분하지 않는다: SRC/x 와 src/x 는 같은 파일이다. */
export const CASE_INSENSITIVE_FS = process.platform === 'win32' || process.platform === 'darwin';

function norm(p: string, caseInsensitive: boolean): string {
  const posix = p.replaceAll('\\', '/');
  return caseInsensitive ? posix.toLowerCase() : posix;
}

function matches(p: string, globs: string[], caseInsensitive: boolean): boolean {
  const target = norm(p, caseInsensitive);
  return globs.some((g) => path.posix.matchesGlob(target, norm(g, caseInsensitive)));
}

/** 변경 경로가 쓰기 범위 안에 있고 보호 경로를 건드리지 않았는지. */
export function checkScope(paths: string[], writeScope: string[], protectedPaths: string[], caseInsensitive = CASE_INSENSITIVE_FS): ScopeCheck {
  const outOfScope = paths.filter((p) => !matches(p, writeScope, caseInsensitive));
  const protectedTouched = paths.filter((p) => matches(p, protectedPaths, caseInsensitive));
  return { ok: outOfScope.length === 0 && protectedTouched.length === 0, outOfScope, protectedTouched };
}

/** 두 쓰기 범위가 겹칠 수 있는지(보수적 판정: 디렉터리 접두사 비교). */
export function scopesOverlap(a: string[], b: string[], caseInsensitive = CASE_INSENSITIVE_FS): boolean {
  const prefix = (g: string) => {
    const n = norm(g, caseInsensitive);
    const idx = n.search(/[*?[{]/);
    return idx === -1 ? n : n.slice(0, idx);
  };
  for (const x of a) {
    for (const y of b) {
      const px = prefix(x);
      const py = prefix(y);
      if (px.startsWith(py) || py.startsWith(px)) return true;
    }
  }
  return false;
}

export type RefSnapshot = Record<string, string>;

export async function snapshotRefs(repo: string): Promise<RefSnapshot> {
  const out = await gitOut(['for-each-ref', '--format=%(refname) %(objectname)'], repo);
  const snap: RefSnapshot = {};
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const [ref, sha] = line.split(' ');
    if (ref && sha) snap[ref] = sha;
  }
  return snap;
}

/** 허용된 ref(담당 브랜치) 외에 바뀐 ref 목록. */
export function refChanges(before: RefSnapshot, after: RefSnapshot, allowed: string[]): string[] {
  const refs = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...refs].filter((r) => !allowed.includes(r) && before[r] !== after[r]).sort();
}

/** 원본 저장소의 작업 트리 상태 요약(직원이 원본을 건드렸는지 비교용). */
export async function originFingerprint(originPath: string): Promise<string> {
  const status = (await git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], originPath)).stdout;
  const head = (await git(['rev-parse', 'HEAD'], originPath, { allowFail: true })).stdout.trim();
  return `${head}\n${status}`;
}

/** 제출 SHA의 깨끗한 분리 worktree. 검증·검수용. 있으면 그 SHA로 되돌려 재사용. */
export async function ensureDetachedWorktree(paths: ProjectPaths, kind: 'verify' | 'review', ticketId: string, sha: string): Promise<string> {
  const parent = kind === 'verify' ? paths.verify : paths.review;
  const wtPath = path.join(parent, ticketId);
  if (!existsSync(wtPath)) {
    await mkdir(parent, { recursive: true });
    await git(['worktree', 'add', '--detach', wtPath, sha], paths.mirror);
  } else {
    await git(['checkout', '--detach', '--force', sha], wtPath);
    await git(['reset', '--hard', sha], wtPath);
    await git(['clean', '-fd'], wtPath);
  }
  return wtPath;
}

export async function removeWorktree(paths: ProjectPaths, wtPath: string): Promise<void> {
  await git(['worktree', 'remove', '--force', wtPath], paths.mirror, { allowFail: true });
  await rm(wtPath, { recursive: true, force: true });
  await git(['worktree', 'prune'], paths.mirror, { allowFail: true });
}

// ---- 반영 ----

export type IntegrationResult =
  | { kind: 'branch'; branch: string; sha: string }
  | { kind: 'merged'; baseBranch: string; mergeSha: string; previousBaseSha: string }
  | { kind: 'downgraded'; branch: string; sha: string; reason: string };

/** manual: 원본 저장소에 ac/<ticket> 브랜치만 만든다. 대표가 직접 병합한다. */
export async function integrateAsBranch(originPath: string, paths: ProjectPaths, ticketId: string, expectedHead: string): Promise<IntegrationResult> {
  const branch = ticketBranch(ticketId);
  const head = await headSha(paths.mirror, `refs/heads/${branch}`);
  if (head !== expectedHead) throw new Error(`승인 이후 브랜치가 바뀌었습니다(${expectedHead.slice(0, 8)} → ${head.slice(0, 8)}). 다시 승인이 필요합니다.`);
  // 브랜치 이름이 아니라 승인된 SHA를 고정한 임시 ref로 가져온다(확인과 반영 사이에 브랜치가 움직여도 승인된 커밋만 들어감).
  const pinned = `refs/ac-approved/${ticketId}`;
  await git(['update-ref', pinned, expectedHead], paths.mirror);
  try {
    await git(['fetch', '--no-tags', paths.mirror, `+${pinned}:refs/heads/${branch}`], originPath);
  } finally {
    await git(['update-ref', '-d', pinned], paths.mirror, { allowFail: true });
  }
  const got = await gitOut(['rev-parse', `refs/heads/${branch}`], originPath);
  if (got !== expectedHead) throw new Error(`반영된 커밋이 승인된 커밋과 다릅니다(${got.slice(0, 8)}).`);
  return { kind: 'branch', branch, sha: expectedHead };
}

/**
 * auto_after_approval: 미러에서 --no-ff 병합 커밋을 만들고, 원본 기준 브랜치를 fast-forward로만 옮긴다.
 * 대표의 작업 파일을 덮어쓰지 않기 위해, 기준 브랜치가 체크아웃되어 있고 작업 트리가 더러우면 브랜치 반영으로 강등한다.
 * verifyMerge가 주어지면 병합 결과로 검증을 다시 돌리고, 실패하면 강등한다.
 */
export async function integrateWithMerge(
  originPath: string,
  paths: ProjectPaths,
  ticketId: string,
  baseBranch: string,
  expectedHead: string,
  title: string,
  verifyMerge?: (mergeSha: string) => Promise<{ ok: boolean; reason?: string }>,
): Promise<IntegrationResult> {
  const branch = ticketBranch(ticketId);
  const downgrade = async (reason: string): Promise<IntegrationResult> => {
    const r = await integrateAsBranch(originPath, paths, ticketId, expectedHead);
    return { kind: 'downgraded', branch, sha: r.kind === 'branch' ? r.sha : expectedHead, reason };
  };

  const head = await headSha(paths.mirror, `refs/heads/${branch}`);
  if (head !== expectedHead) throw new Error('승인 이후 브랜치가 바뀌었습니다. 다시 승인이 필요합니다.');

  const originBase = await syncMirror(originPath, paths, baseBranch);
  const tmp = path.join(paths.root, 'merge-tmp', ticketId);
  await rm(tmp, { recursive: true, force: true });
  await mkdir(path.dirname(tmp), { recursive: true });
  await git(['worktree', 'add', '--detach', tmp, originBase], paths.mirror);
  let mergeSha: string;
  try {
    // 브랜치 이름이 아니라 승인된 SHA를 병합한다.
    const merged = await git([...AGENT_IDENTITY, 'merge', '--no-ff', '--no-edit', '-m', `${ticketId}: ${title}`, expectedHead], tmp, { allowFail: true });
    if (merged.code !== 0) {
      await git(['merge', '--abort'], tmp, { allowFail: true });
      return await downgrade('기준 브랜치와 충돌해 자동 병합할 수 없습니다.');
    }
    mergeSha = await headSha(tmp);
  } finally {
    await removeWorktree(paths, tmp);
  }

  if (verifyMerge) {
    const v = await verifyMerge(mergeSha);
    if (!v.ok) return downgrade(`병합 결과 재검증 실패: ${v.reason ?? ''}`);
  }

  const mergeRef = `refs/ac-merge/${ticketId}`;
  await git(['update-ref', mergeRef, mergeSha], paths.mirror);
  const current = (await git(['symbolic-ref', '--short', '-q', 'HEAD'], originPath, { allowFail: true })).stdout.trim();
  if (current === baseBranch) {
    const dirty = (await git(['status', '--porcelain', '--untracked-files=no'], originPath)).stdout.trim();
    if (dirty) return downgrade('원본 저장소에 커밋하지 않은 변경이 있어 자동 병합하지 않았습니다.');
    await git(['fetch', '--no-tags', paths.mirror, `${mergeRef}:refs/ac-merge/${ticketId}`], originPath);
    const ff = await git(['merge', '--ff-only', `refs/ac-merge/${ticketId}`], originPath, { allowFail: true });
    await git(['update-ref', '-d', `refs/ac-merge/${ticketId}`], originPath, { allowFail: true });
    if (ff.code !== 0) return downgrade('fast-forward가 불가능해 자동 병합하지 않았습니다.');
  } else {
    // 체크아웃되지 않은 브랜치는 + 없는 refspec이라 fast-forward가 아니면 거부된다.
    const f = await git(['fetch', '--no-tags', paths.mirror, `${mergeRef}:refs/heads/${baseBranch}`], originPath, { allowFail: true });
    if (f.code !== 0) return downgrade('fast-forward가 불가능해 자동 병합하지 않았습니다.');
  }
  await git(['update-ref', '-d', mergeRef], paths.mirror, { allowFail: true });
  return { kind: 'merged', baseBranch, mergeSha, previousBaseSha: originBase };
}

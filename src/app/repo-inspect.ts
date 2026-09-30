// 프로젝트 등록·업무 작성 도우미: 폴더 찾아보기와 저장소 자동 분석(읽기만), 새 프로젝트용 빈 저장소 만들기.
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { AGENT_IDENTITY, git } from '../workspace/git.ts';
import { tr } from '../core/i18n.ts';
import type { EvidenceType } from '../core/types.ts';

export interface DirListing {
  path: string;
  parent: string | null;
  dirs: { name: string; isGit: boolean }[];
  roots: string[];
}

const SKIP = new Set(['node_modules', '$RECYCLE.BIN', 'System Volume Information']);

/** 폴더 목록(숨김·시스템 폴더 제외). 경로가 비면 드라이브 목록(Windows) 또는 루트. */
export async function listDirs(dir: string): Promise<DirListing> {
  const roots =
    process.platform === 'win32'
      ? 'CDEFGHIJKLMNOPQRSTUVWXYZ'
          .split('')
          .map((l) => `${l}:\\`)
          .filter((r) => existsSync(r))
      : ['/'];
  // 시작 위치가 없으면 드라이브 루트(시스템 폴더투성이) 대신 사용자 홈에서 연다.
  const target = dir ? path.resolve(dir) : homedir();
  const entries = await readdir(target, { withFileTypes: true });
  const dirs = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !SKIP.has(e.name))
    .map((e) => ({ name: e.name, isGit: existsSync(path.join(target, e.name, '.git')) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const parent = path.dirname(target);
  return { path: target, parent: parent === target ? null : parent, dirs, roots };
}

export interface VerifySuggestion {
  label: string;
  evidenceType: EvidenceType;
  argv: string[];
}

export interface RepoInspection {
  path: string;
  exists: boolean;
  isGit: boolean;
  name: string;
  baseBranch: string;
  branches: string[];
  verify: VerifySuggestion[];
  dirs: string[];
  protectedSuggestions: string[];
  /** 추적 파일이 하나도 없는 새 저장소(처음부터 시작하는 프로젝트). */
  empty: boolean;
}

const PROTECT_CANDIDATES = [
  'README.md',
  'LICENSE',
  'package.json',
  'package-lock.json',
  '.github',
  'ProjectSettings',
  'Packages/manifest.json',
];

/** 저장소를 읽고 등록 폼에 채울 값을 제안한다. */
export async function inspectRepo(repo: string): Promise<RepoInspection> {
  const p = path.resolve(repo);
  const base: RepoInspection = {
    path: p,
    exists: existsSync(p),
    isGit: false,
    name: path.basename(p),
    baseBranch: 'main',
    branches: [],
    verify: [],
    dirs: [],
    protectedSuggestions: [],
    empty: false,
  };
  if (!base.exists) return base;
  // 폴더 자체가 저장소 루트여야 한다(상위 폴더의 저장소 안에 있는 하위 폴더는 등록 대상이 아니다).
  const top = await git(['rev-parse', '--show-toplevel'], p, { allowFail: true });
  const norm = (x: string) => {
    const r = path.resolve(x);
    return process.platform === 'win32' || process.platform === 'darwin' ? r.toLowerCase() : r;
  };
  if (top.code !== 0 || norm(top.stdout.trim()) !== norm(p)) return base;
  base.isGit = true;
  const head = await git(['symbolic-ref', '--short', 'HEAD'], p, { allowFail: true });
  if (head.code === 0 && head.stdout.trim()) base.baseBranch = head.stdout.trim();
  const br = await git(['branch', '--format=%(refname:short)'], p, { allowFail: true });
  base.branches = br.stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  base.dirs = await trackedDirs(p, base.baseBranch, '');
  base.empty = !(await git(['ls-files'], p, { allowFail: true })).stdout.trim();
  base.verify = await suggestVerify(p);
  base.protectedSuggestions = PROTECT_CANDIDATES.filter((c) => existsSync(path.join(p, c))).map((c) =>
    ['.github', 'ProjectSettings'].includes(c) ? `${c}/**` : c,
  );
  return base;
}

/** 기준 브랜치에서 git이 추적하는 하위 폴더(쓰기 범위 고르기용). */
export async function trackedDirs(repo: string, ref: string, sub: string): Promise<string[]> {
  const prefix = sub ? `${sub.replace(/\\/g, '/').replace(/\/+$/, '')}/` : '';
  const r = await git(['ls-tree', '-d', '--name-only', ref, ...(prefix ? ['--', prefix] : [])], repo, { allowFail: true });
  if (r.code !== 0) return [];
  return r.stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
}

async function suggestVerify(repo: string): Promise<VerifySuggestion[]> {
  const out: VerifySuggestion[] = [];
  const pkg = await readFile(path.join(repo, 'package.json'), 'utf8')
    .then((x) => JSON.parse(x) as { scripts?: Record<string, string> })
    .catch(() => null);
  const scripts = pkg?.scripts ?? {};
  if (scripts.test) out.push({ label: 'Unit tests', evidenceType: 'unit_test', argv: ['npm', 'test'] });
  for (const s of ['typecheck', 'lint', 'build']) {
    if (scripts[s]) out.push({ label: s, evidenceType: 'static_check', argv: ['npm', 'run', s] });
  }
  if (existsSync(path.join(repo, 'Cargo.toml'))) out.push({ label: 'cargo test', evidenceType: 'unit_test', argv: ['cargo', 'test'] });
  if (existsSync(path.join(repo, 'go.mod'))) out.push({ label: 'go test', evidenceType: 'unit_test', argv: ['go', 'test', './...'] });
  if (['pyproject.toml', 'pytest.ini', 'setup.cfg'].some((f) => existsSync(path.join(repo, f))))
    out.push({ label: 'pytest', evidenceType: 'unit_test', argv: ['python', '-m', 'pytest'] });
  return out;
}

/**
 * 새 프로젝트: 고른 폴더 아래에 새 폴더를 만들고 git 저장소로 초기화한다(빈 첫 커밋, 기준 브랜치 main).
 * 이미 있는 폴더는 건드리지 않는다.
 */
export async function createRepo(parent: string, name: string): Promise<string> {
  const clean = name.trim();
  if (!clean || /[\\/:*?"<>|]/.test(clean) || clean === '.' || clean === '..')
    throw new Error(tr('폴더 이름에 쓸 수 없는 문자가 있습니다.', 'The folder name has characters that are not allowed.'));
  if (!existsSync(parent)) throw new Error(tr(`상위 폴더가 없습니다: ${parent}`, `Parent folder not found: ${parent}`));
  const dir = path.join(parent, clean);
  if (existsSync(dir)) throw new Error(tr(`이미 있는 폴더입니다: ${dir}`, `Folder already exists: ${dir}`));
  await mkdir(dir);
  await git(['init', '-q', '-b', 'main'], dir);
  await git([...AGENT_IDENTITY, 'commit', '-q', '--allow-empty', '-m', 'Start project'], dir);
  return dir;
}

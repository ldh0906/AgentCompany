// 프로젝트 등록·업무 작성 도우미: 폴더 찾아보기와 저장소 자동 분석(읽기만), 새 프로젝트용 빈 저장소 만들기.
import { existsSync, readFileSync, statSync } from 'node:fs';
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
  const py = pythonTests(
    (f) => (existsSync(path.join(repo, f)) ? readFileSafe(path.join(repo, f)) : null),
    existsSync(path.join(repo, 'tests')),
  );
  if (py) out.push(py);
  return out;
}

function readFileSafe(f: string): string {
  try {
    return readFileSync(f, 'utf8');
  } catch {
    return '';
  }
}

/**
 * 파이썬 테스트 명령: pytest를 쓴다고 적힌 프로젝트만 pytest, 아니면 표준 라이브러리 unittest.
 * 실측(2026-10-01, 이 PC): Python 3.14에 pytest가 없어 "python -m pytest" 추천이 늘 실패한다.
 */
export function pythonTests(read: (f: string) => string | null, hasTestsDir: boolean): VerifySuggestion | null {
  const pytestIni = read('pytest.ini');
  const pyproject = read('pyproject.toml') ?? '';
  const setupCfg = read('setup.cfg') ?? '';
  if (pytestIni !== null || /pytest/.test(pyproject) || /\[tool:pytest\]/.test(setupCfg))
    return { label: 'pytest', evidenceType: 'unit_test', argv: ['python', '-m', 'pytest'] };
  if (hasTestsDir && (pyproject || read('requirements.txt') !== null || read('main.py') !== null || read('app.py') !== null))
    return {
      label: 'Python unittest',
      evidenceType: 'unit_test',
      argv: ['python', '-m', 'unittest', 'discover', '-s', 'tests', '-t', '.'],
    };
  return null;
}

/**
 * 브랜치(ref)의 내용으로 검증 명령을 추천한다(작업 트리가 아니라 git에서 읽는다: "브랜치만" 반영에서도 동작).
 * npm 스크립트는 실제로 도는 명령(runs)도 알려 준다: 이미 같은 명령이 있으면 겹치는 추천을 하지 않게.
 */
export async function suggestVerifyAt(repo: string, ref: string): Promise<(VerifySuggestion & { runs?: string })[]> {
  // 맨 위 목록을 한 번 읽고 있는 파일만 연다. 실측(2026-10-02): 이 PC는 git 한 번 띄우는 데 0.18초라,
  // 없는 파일까지 9번 열어 보던 것이 업무 하나에 1.6초를 썼다.
  const top = new Map<string, string>(); // 이름 → blob/tree
  for (const line of (await git(['ls-tree', ref], repo, { allowFail: true })).stdout.split('\n')) {
    const m = /^\d+ (\w+) \w+\t(.+)$/.exec(line);
    if (m) top.set(m[2]!, m[1]!);
  }
  const show = async (f: string) => {
    if (top.get(f) !== 'blob') return null;
    const r = await git(['show', `${ref}:${f}`], repo, { allowFail: true });
    return r.code === 0 ? r.stdout : null;
  };
  const out: (VerifySuggestion & { runs?: string })[] = [];
  const pkgText = await show('package.json');
  const scripts = (pkgText ? (JSON.parse(pkgText) as { scripts?: Record<string, string> }).scripts : null) ?? {};
  if (scripts.test) out.push({ label: 'Unit tests', evidenceType: 'unit_test', argv: ['npm', 'test'], runs: scripts.test.trim() });
  for (const s of ['typecheck', 'lint', 'build'])
    if (scripts[s]) out.push({ label: s, evidenceType: 'static_check', argv: ['npm', 'run', s], runs: scripts[s]!.trim() });
  if (await show('Cargo.toml')) out.push({ label: 'cargo test', evidenceType: 'unit_test', argv: ['cargo', 'test'] });
  if (await show('go.mod')) out.push({ label: 'go test', evidenceType: 'unit_test', argv: ['go', 'test', './...'] });
  const files: Record<string, string | null> = {};
  for (const f of ['pytest.ini', 'pyproject.toml', 'setup.cfg', 'requirements.txt', 'main.py', 'app.py']) files[f] = await show(f);
  const testsDir = top.get('tests') === 'tree';
  const py = pythonTests((f) => files[f] ?? null, testsDir);
  if (py) out.push(py);
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

/**
 * "node --test tests/"처럼 폴더를 넘기면 Node 22+는 그 폴더를 테스트 파일 하나로 열려다 실패한다.
 * 폴더 인자를 그 안의 테스트 파일 패턴으로 바꿔 실행한다(셸 없이 넘겨도 node가 패턴을 직접 펼친다).
 * 실측(2026-10-01, 물 마시기): 비서실장이 제안한 "node --test tests/"가 실패해, 두 업무가 우회 파일을 만들겠다며
 * 대표에게 범위 허가를 연달아 물었다.
 */
export function nodeTestArgs(argv: string[], cwd: string): string[] {
  if (argv[0] !== 'node' || !argv.includes('--test')) return argv;
  return argv.flatMap((a, i) => {
    if (i === 0 || a.startsWith('-') || /[*?{]/.test(a)) return [a];
    const dir = a.replace(/[\\/]+$/, '');
    try {
      return statSync(path.join(cwd, dir)).isDirectory() ? [`${dir}/**/*.test.*`, `${dir}/**/*.spec.*`] : [a];
    } catch {
      return [a];
    }
  });
}

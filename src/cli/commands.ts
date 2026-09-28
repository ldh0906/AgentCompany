import { setLanguage, tr } from '../core/i18n.ts';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Company } from '../app/company.ts';
import { doctor, installInfo, profileRoot } from '../app/doctor.ts';
import { Orchestrator } from '../app/orchestrator.ts';
import { isAlive } from '../runner/process.ts';
import { Api } from '../server/api.ts';
import { startServer } from '../server/http.ts';
import { Store } from '../store/db.ts';
import { git } from '../workspace/git.ts';
import { seedDemo } from './demo.ts';

const HELP = () =>
  tr(
    `Agent Company — 로컬 AI 개발 조직

사용법:
  agent-company start [--port 4777] [--data-dir DIR] [--no-open] [--user-profiles] [--language ko|en]
  agent-company demo  [--port 4777] [--no-open]      구독 없이 가짜 직원으로 체험
  agent-company doctor [--data-dir DIR]               CLI 설치·로그인 상태 점검
  agent-company info   [--data-dir DIR]               설치 위치·용량·생성 파일
  agent-company uninstall [--data-dir DIR] [--yes]    데이터 정리(미리보기 후 확인)

데이터 폴더 기본값: ~/AgentCompany (환경변수 AGENT_COMPANY_HOME 로 변경)
`,
    `Agent Company — Local AI development team

Usage:
  agent-company start [--port 4777] [--data-dir DIR] [--no-open] [--user-profiles] [--language ko|en]
  agent-company demo  [--port 4777] [--no-open]      Try fake employees without a subscription
  agent-company doctor [--data-dir DIR]               Check CLI installation and login status
  agent-company info   [--data-dir DIR]               Installation paths, size, and generated files
  agent-company uninstall [--data-dir DIR] [--yes]    Clean up data (preview, then confirm)

Default data folder: ~/AgentCompany (override with AGENT_COMPANY_HOME)
`,
  );

function selectLanguage(language?: string): void {
  language ??= Intl.DateTimeFormat().resolvedOptions().locale.startsWith('ko') ? 'ko' : 'en';
  setLanguage(language === 'en' ? 'en' : 'ko');
}

function defaultDataDir(demo: boolean): string {
  const base = process.env.AGENT_COMPANY_HOME ?? path.join(homedir(), 'AgentCompany');
  return demo ? `${base}-demo` : base;
}

function webRoot(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const c of [path.join(here, '..', 'web'), path.join(here, '..', '..', 'dist', 'web')]) {
    if (existsSync(path.join(c, 'index.html'))) return c;
  }
  return null;
}

function openBrowser(url: string): void {
  const [file, args] =
    process.platform === 'win32' ? ['explorer.exe', [url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  execFile(file, args as string[], { windowsHide: true }, () => {});
}

interface Lock {
  pid: number;
  url: string;
  startedAt: string;
}

let lockDb: DatabaseSync | null = null;

/**
 * 데이터 폴더당 데몬 하나. SQLite 배타 잠금을 잡고 종료할 때까지 놓지 않는다.
 * 프로세스가 죽으면 OS가 잠금을 자동으로 풀어 주므로 "죽은 잠금 회수" 경합이 없다.
 */
export function acquireLock(dataDir: string): boolean {
  const db = new DatabaseSync(path.join(dataDir, 'daemon.lockdb'));
  try {
    db.exec('PRAGMA busy_timeout = 0; PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE;');
  } catch {
    db.close();
    return false;
  }
  lockDb = db;
  writeFileSync(path.join(dataDir, 'daemon.lock'), JSON.stringify({ pid: process.pid, url: '', startedAt: new Date().toISOString() }), {
    mode: 0o600,
  });
  return true;
}

export function releaseLock(): void {
  if (!lockDb) return;
  try {
    lockDb.exec('ROLLBACK');
  } catch {
    /* 무시 */
  }
  lockDb.close();
  lockDb = null;
}

function readLock(dataDir: string): Lock | null {
  try {
    const lock = JSON.parse(readFileSync(path.join(dataDir, 'daemon.lock'), 'utf8')) as Lock;
    return isAlive(lock.pid) ? lock : null;
  } catch {
    return null;
  }
}

async function start(argv: string[], demo: boolean): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      port: { type: 'string' },
      'data-dir': { type: 'string' },
      'no-open': { type: 'boolean' },
      'user-profiles': { type: 'boolean' },
      language: { type: 'string' },
    },
  });
  const dataDir = path.resolve(values['data-dir'] ?? defaultDataDir(demo));
  const language = values.language ?? (Intl.DateTimeFormat().resolvedOptions().locale.startsWith('ko') ? 'ko' : 'en');
  setLanguage(language === 'en' ? 'en' : 'ko');
  mkdirSync(dataDir, { recursive: true });
  if (!acquireLock(dataDir)) {
    const existing = readLock(dataDir);
    console.log(
      tr(
        `이미 실행 중입니다 (pid ${existing?.pid ?? '?'}).\n대시보드: ${existing?.url || '(시작 중)'}`,
        `Already running (pid ${existing?.pid ?? '?'}).\nDashboard: ${existing?.url || '(starting)'}`,
      ),
    );
    if (existing?.url && !values['no-open']) openBrowser(existing.url);
    return;
  }

  const store = new Store(path.join(dataDir, 'company.db'));
  const company = new Company(store);
  let broadcast: (kind: string, id: string) => void = () => {};
  const orch = new Orchestrator(company, {
    dataDir,
    language,
    profileRoot: values['user-profiles'] ? null : profileRoot(dataDir),
    onChange: (k, id) => broadcast(k, id),
  });
  const recovery = await orch.recover();
  if (demo) await seedDemo(company, orch, dataDir, language);

  const server = await startServer({ api: new Api(orch, dataDir), port: Number(values.port ?? (demo ? 4778 : 4777)), webRoot: webRoot() });
  broadcast = server.broadcast;
  writeFileSync(
    path.join(dataDir, 'daemon.lock'),
    JSON.stringify({ pid: process.pid, url: server.url, startedAt: new Date().toISOString() }),
    { mode: 0o600 },
  );
  orch.start(1000);

  console.log(
    tr(
      `\nAgent Company ${demo ? tr('(데모) ', '(demo) ') : ''}실행 중`,
      `\nAgent Company ${demo ? tr('(데모) ', '(demo) ') : ''}is running`,
    ),
  );
  console.log(tr(`  대시보드: ${server.url}`, `  Dashboard: ${server.url}`));
  console.log(tr(`  데이터:   ${dataDir}`, `  Data:      ${dataDir}`));
  console.log(tr(`  감사 로그: ${recovery.chainDetail}`, `  Audit log: ${recovery.chainDetail}`));
  if (recovery.reattached.length || recovery.ingestedAfterRestart.length) {
    console.log(
      tr(
        `  복구: 재연결 ${recovery.reattached.length}건, 결과 수거 ${recovery.ingestedAfterRestart.length}건, 고아 ${recovery.orphaned.length}건`,
        `  Recovery: ${recovery.reattached.length} reattached, ${recovery.ingestedAfterRestart.length} results collected, ${recovery.orphaned.length} orphaned`,
      ),
    );
  }
  if (!recovery.chainOk)
    console.log(
      tr(
        '  ⚠ 감사 로그 변조가 탐지되었습니다. 대시보드의 시스템 화면을 확인하세요.',
        '  ⚠ Audit log tampering detected. Check the System page in the dashboard.',
      ),
    );
  console.log(
    tr(
      '  종료: Ctrl+C (진행 중인 직원 실행은 계속되며 다음 시작 때 이어받습니다)\n',
      '  Exit: Ctrl+C (active employee runs continue and reconnect on next startup)\n',
    ),
  );
  if (!values['no-open']) openBrowser(server.url);

  const shutdown = async () => {
    await orch.stop();
    await server.close();
    rmSync(path.join(dataDir, 'daemon.lock'), { force: true });
    store.close();
    releaseLock();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

async function runDoctor(argv: string[]): Promise<void> {
  const { values } = parseArgs({ args: argv, options: { 'data-dir': { type: 'string' }, language: { type: 'string' } } });
  selectLanguage(values.language);
  const dataDir = path.resolve(values['data-dir'] ?? defaultDataDir(false));
  const r = await doctor(dataDir);
  console.log(`Node ${r.node} · ${r.git ?? tr('git 없음', 'git not found')} · ${r.platform}\n`);
  for (const c of r.clis) {
    const mark = !c.found
      ? tr('✗ 미설치', '✗ Not installed')
      : c.login === 'ok'
        ? tr('✓ 준비됨', '✓ Ready')
        : c.login === 'missing'
          ? tr('! 로그인 필요', '! Login required')
          : tr('? 확인 불가', '? Unknown');
    console.log(`${c.displayName.padEnd(12)} ${mark}  ${c.version ?? ''}`);
    if (c.found && c.login !== 'ok') console.log(`  └ ${c.loginHelp.replaceAll('\n', '\n    ')}`);
  }
}

async function runInfo(argv: string[]): Promise<void> {
  const { values } = parseArgs({ args: argv, options: { 'data-dir': { type: 'string' }, language: { type: 'string' } } });
  selectLanguage(values.language);
  const info = await installInfo(path.resolve(values['data-dir'] ?? defaultDataDir(false)));
  console.log(JSON.stringify(info, null, 2));
}

async function uninstall(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: { 'data-dir': { type: 'string' }, yes: { type: 'boolean' }, language: { type: 'string' } },
  });
  selectLanguage(values.language);
  const dataDir = path.resolve(values['data-dir'] ?? defaultDataDir(false));
  if (!existsSync(dataDir)) {
    console.log(tr(`데이터 폴더가 없습니다: ${dataDir}`, `Data folder not found: ${dataDir}`));
    return;
  }
  if (readLock(dataDir)) {
    console.log(tr('Agent Company가 실행 중입니다. 먼저 종료하세요.', 'Agent Company is running. Stop it first.'));
    process.exitCode = 1;
    return;
  }
  const info = await installInfo(dataDir);
  console.log(
    tr(
      `삭제 대상: ${dataDir} (${(info.sizeBytes / 1024 / 1024).toFixed(1)} MB)`,
      `To delete: ${dataDir} (${(info.sizeBytes / 1024 / 1024).toFixed(1)} MB)`,
    ),
  );
  console.log(
    tr(
      '  - 회사 DB, 실행 기록, 미러 저장소, 작업공간, 앱 전용 CLI 프로필(로그인 파일 포함)',
      '  - Company database, run records, mirrors, workspaces, app CLI profiles (including login files)',
    ),
  );
  console.log(
    tr(
      '  - 대표의 원본 저장소, 전역 git·Claude·Codex·agy 설정은 건드리지 않습니다.',
      '  - Your original repositories and global git, Claude, Codex, and agy settings are left intact.',
    ),
  );
  const dirty: string[] = [];
  for (const m of info.mirrors) {
    const list = await git(['worktree', 'list', '--porcelain'], m, { allowFail: true });
    for (const line of list.stdout.split('\n').filter((l) => l.startsWith('worktree '))) {
      const wt = line.slice('worktree '.length).trim();
      if (wt === m) continue;
      const st = await git(['status', '--porcelain'], wt, { allowFail: true });
      if (st.stdout.trim()) dirty.push(wt);
    }
  }
  if (dirty.length) {
    console.log(tr('\n⚠ 커밋되지 않은 변경이 있는 작업공간:', '\n⚠ Workspaces with uncommitted changes:'));
    for (const d of dirty) console.log(`  ${d}`);
  }
  if (!values.yes) {
    console.log(tr('\n실제로 지우려면 --yes 를 붙여 다시 실행하세요.', '\nRun again with --yes to delete.'));
    return;
  }
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  console.log(
    existsSync(dataDir)
      ? tr('일부 파일을 지우지 못했습니다(사용 중일 수 있음).', 'Some files could not be deleted (they may be in use).')
      : tr('삭제했습니다. 남은 파일이 없습니다.', 'Deleted. No files remain.'),
  );
}

export async function main(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case 'start':
      return start(rest, false);
    case 'demo':
      return start(rest, true);
    case 'doctor':
      return runDoctor(rest);
    case 'info':
      return runInfo(rest);
    case 'uninstall':
      return uninstall(rest);
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      selectLanguage(parseArgs({ args: rest, options: { language: { type: 'string' } } }).values.language);
      console.log(HELP());
      return;
    default:
      selectLanguage();
      console.log(tr(`알 수 없는 명령: ${cmd}\n\n${HELP()}`, `Unknown command: ${cmd}\n\n${HELP()}`));
      process.exitCode = 1;
  }
}

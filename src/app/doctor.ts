// 환경 진단과 설치 정보. 인증 파일은 절대 열지 않는다(공식 상태 명령의 결과만 본다).
import { tr } from '../core/i18n.ts';

import { execFile, spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { ADAPTERS } from '../adapters/index.ts';
import type { CliKind } from '../core/types.ts';
import { locateExecutable } from '../runner/locate.ts';
import { probeCli } from './cli-caps.ts';

export interface CliCheck {
  kind: string;
  displayName: string;
  found: boolean;
  path: string | null;
  version: string | null;
  login: 'ok' | 'missing' | 'unknown';
  loginDetail: string;
  loginHelp: string;
  notes: string[];
  /** 도움말에 없는, Agent Company가 쓰는 옵션(cli-caps.ts). 확인하지 못했으면 없음 */
  missingFlags?: string[];
}

export interface DoctorReport {
  node: string;
  git: string | null;
  platform: string;
  clis: CliCheck[];
  checkedAt: string;
}

function run(file: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs = 20_000): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { env, windowsHide: true, timeout: timeoutMs, encoding: 'utf8' }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? Number((error as { code?: unknown }).code) : 1) : 0;
      resolve({ code, out: `${stdout}\n${stderr}`.trim() });
    });
  });
}

export function profileRoot(dataDir: string): string {
  return path.join(dataDir, 'profiles');
}

/** 앱 전용 CLI 프로필 폴더. 없으면 빈 폴더를 만든다(Codex는 CODEX_HOME 폴더가 없으면 로그인조차 거부한다). */
export function appProfileDir(root: string, cli: string): string {
  const dir = path.join(root, cli);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** CLI를 실행할 환경: 앱 전용 프로필을 쓰면 프로필 폴더 환경변수를 더한다. */
export function cliEnv(dataDir: string, kind: CliKind, useAppProfiles = true): { env: NodeJS.ProcessEnv; profileDir: string | null } {
  const v = ADAPTERS[kind].capabilities.profileEnvVar;
  const profileDir = useAppProfiles && v ? appProfileDir(profileRoot(dataDir), kind) : null;
  return { env: { ...process.env, ...(profileDir && v ? { [v]: profileDir } : {}) }, profileDir };
}

/**
 * 대표가 누를 때만: 앱 전용 프로필로 CLI 로그인 명령을 띄운 PowerShell 창을 연다.
 * 실측(첫 사용): 새 회사에선 Claude·Codex가 "로그인 필요"인데, 안내가 명령을 복사해 PowerShell에 붙이라는 것뿐이었다.
 * 로그인 자체(브라우저 인증)는 CLI가 하고, 앱은 결과 파일을 읽지 않는다.
 */
export async function openLoginWindow(dataDir: string, kind: string): Promise<void> {
  const a = Object.values(ADAPTERS).find((x) => x.kind === kind);
  if (!a || a.kind === 'fake' || !a.loginArgs) throw new Error(tr('로그인할 수 없는 CLI입니다.', 'This CLI has no login.'));
  if (process.platform !== 'win32') throw new Error(a.loginInstructions(null));
  const { env } = cliEnv(dataDir, a.kind);
  const located = await locateExecutable(a.executable, env);
  if (!located?.launch) throw new Error(tr(`${a.displayName}가 설치되어 있지 않습니다.`, `${a.displayName} is not installed.`));
  // PowerShell은 둥근 따옴표(‘ ’ ‚ ‛)도 작은따옴표로 읽으므로 함께 두 번 쓴다.
  const q = (s: string) => `'${s.replace(/['‘’‚‛]/g, '$&$&')}'`;
  const script = [
    `$Host.UI.RawUI.WindowTitle = 'Agent Company - ${a.displayName} login'`,
    `Write-Host 'Agent Company: ${a.displayName} login. Follow the steps below; close this window when done.'`,
    `& ${[located.launch.file, ...located.launch.argsPrefix, ...a.loginArgs].map(q).join(' ')}`,
  ].join('; ');
  // start: 새 콘솔 창을 확실히 연다(detached만으로는 창 없는 프로세스가 될 수 있다). 인코딩된 명령이라 따옴표 문제가 없다.
  const b64 = Buffer.from(script, 'utf16le').toString('base64');
  const child = spawn('cmd.exe', ['/d', '/c', `start "AgentCompany" powershell.exe -NoProfile -NoExit -EncodedCommand ${b64}`], {
    env,
    detached: true,
    windowsHide: true,
    windowsVerbatimArguments: true,
    stdio: 'ignore',
  });
  child.unref();
}

export async function doctor(dataDir: string, useAppProfiles = true): Promise<DoctorReport> {
  const git = await run('git', ['--version'], process.env);
  const clis: CliCheck[] = [];
  for (const a of Object.values(ADAPTERS)) {
    if (a.kind === 'fake') continue;
    const { env, profileDir } = cliEnv(dataDir, a.kind, useAppProfiles);
    const located = await locateExecutable(a.executable, env);
    const check: CliCheck = {
      kind: a.kind,
      displayName: a.displayName,
      found: Boolean(located?.launch),
      path: located?.path ?? null,
      version: null,
      login: 'unknown',
      loginDetail: '',
      loginHelp: a.loginInstructions(profileDir),
      notes: a.capabilities.notes,
    };
    if (located?.launch) {
      const caps = await probeCli(a, located.launch, env, '');
      check.version = caps.version;
      if (!caps.error) check.missingFlags = caps.missing;
      if (a.loginStatusArgs) {
        const s = await run(located.launch.file, [...located.launch.argsPrefix, ...a.loginStatusArgs], env);
        const text = s.out.slice(0, 400);
        const negative = /not logged in|logged out|no credentials|loggedIn"\s*:\s*false|not authenticated/i.test(text);
        check.login = s.code === 0 && !negative ? 'ok' : 'missing';
        check.loginDetail = text.replace(/[A-Za-z0-9_\-]{32,}/g, '***');
      } else {
        check.loginDetail = tr(
          '공식 로그인 상태 명령이 없어 첫 실행 때 확인합니다.',
          'No official login status command; checked on first run.',
        );
      }
    }
    clis.push(check);
  }
  return {
    node: process.version,
    git: git.code === 0 ? git.out : null,
    platform: `${process.platform} ${process.arch}`,
    clis,
    checkedAt: new Date().toISOString(),
  };
}

export async function dirSize(dir: string, depthLimit = 12): Promise<number> {
  let total = 0;
  const walk = async (d: string, depth: number) => {
    if (depth > depthLimit) return;
    const entries = await readdir(d, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p, depth + 1);
      else if (e.isFile()) total += (await stat(p).catch(() => ({ size: 0 }))).size;
    }
  };
  await walk(dir, 0);
  return total;
}

export async function installInfo(dataDir: string) {
  const projectsDir = path.join(dataDir, 'projects');
  const projects = await readdir(projectsDir).catch(() => [] as string[]);
  return {
    dataDir,
    database: path.join(dataDir, 'company.db'),
    runsDir: path.join(dataDir, 'runs'),
    projectsDir,
    profilesDir: profileRoot(dataDir),
    mirrors: projects.map((p) => path.join(projectsDir, p, 'mirror.git')),
    sizeBytes: await dirSize(dataDir),
    services: tr('없음 (서비스·예약 작업·자동 실행을 만들지 않습니다)', 'None (no services, scheduled tasks, or startup entries created)'),
    network: tr('127.0.0.1 에서만 열립니다', 'Listens on 127.0.0.1 only'),
    credentials: tr(
      '저장하지 않습니다. 앱 전용 프로필 폴더에는 각 CLI가 스스로 관리하는 로그인 파일이 생기며, Agent Company는 이를 읽지 않습니다.',
      'Not stored. Each CLI manages its own login files in the app profile folder; Agent Company does not read them.',
    ),
  };
}

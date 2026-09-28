// 환경 진단과 설치 정보. 인증 파일은 절대 열지 않는다(공식 상태 명령의 결과만 본다).

import { execFile } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { ADAPTERS } from '../adapters/index.ts';
import { locateExecutable } from '../runner/locate.ts';

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

export async function doctor(dataDir: string, useAppProfiles = true): Promise<DoctorReport> {
  const git = await run('git', ['--version'], process.env);
  const clis: CliCheck[] = [];
  for (const a of Object.values(ADAPTERS)) {
    if (a.kind === 'fake') continue;
    const profileDir = useAppProfiles && a.capabilities.profileEnvVar ? path.join(profileRoot(dataDir), a.kind) : null;
    const env = { ...process.env, ...(profileDir && a.capabilities.profileEnvVar ? { [a.capabilities.profileEnvVar]: profileDir } : {}) };
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
      const v = await run(located.launch.file, [...located.launch.argsPrefix, '--version'], env);
      check.version = v.code === 0 ? v.out.split('\n')[0]!.slice(0, 120) : null;
      if (a.loginStatusArgs) {
        const s = await run(located.launch.file, [...located.launch.argsPrefix, ...a.loginStatusArgs], env);
        const text = s.out.slice(0, 400);
        const negative = /not logged in|logged out|no credentials|loggedIn"\s*:\s*false|not authenticated/i.test(text);
        check.login = s.code === 0 && !negative ? 'ok' : 'missing';
        check.loginDetail = text.replace(/[A-Za-z0-9_\-]{32,}/g, '***');
      } else {
        check.loginDetail = '공식 로그인 상태 명령이 없어 첫 실행 때 확인합니다.';
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
    services: '없음 (서비스·예약 작업·자동 실행을 만들지 않습니다)',
    network: '127.0.0.1 에서만 열립니다',
    credentials: '저장하지 않습니다. 앱 전용 프로필 폴더에는 각 CLI가 스스로 관리하는 로그인 파일이 생기며, Agent Company는 이를 읽지 않습니다.',
  };
}

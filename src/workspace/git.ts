// git 호출. shell 없이 argv 배열로 실행하고, 창을 띄우지 않으며, 한글 경로를 따옴표 없이 받는다.

import { execFile } from 'node:child_process';

export class GitError extends Error {
  readonly args: string[];
  readonly stderr: string;
  readonly code: number | null;

  constructor(args: string[], stderr: string, code: number | null) {
    super(`git ${args.join(' ')} 실패 (코드 ${code}): ${stderr.trim().slice(0, 500)}`);
    this.args = args;
    this.stderr = stderr;
    this.code = code;
  }
}

// maintenance.auto=false: 커밋·가져오기마다 git이 스스로 정리(maintenance run --auto)를 띄우지 않게 한다.
// 실측(2026-10-02): 업무 하나에 git 83번 중 4번이 이 정리였고, 이 PC는 git 한 번 띄우는 데 0.18초가 든다.
// 정리는 오케스트레이터가 작업 폴더 청소 때(10분마다) 저장소마다 한 번 돌린다(sweepWorkspaces).
const BASE_ARGS = [
  '-c',
  'core.quotepath=false',
  '-c',
  'core.longpaths=true',
  '-c',
  'advice.detachedHead=false',
  '-c',
  'maintenance.auto=false',
];

export function git(
  args: string[],
  cwd: string,
  opts: { allowFail?: boolean; env?: NodeJS.ProcessEnv } = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  const full = [...BASE_ARGS, ...args];
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      full,
      {
        cwd,
        windowsHide: true,
        maxBuffer: 64 * 1024 * 1024,
        encoding: 'utf8',
        env: { ...process.env, ...opts.env, GIT_TERMINAL_PROMPT: '0' },
      },
      (error, stdout, stderr) => {
        const code = error
          ? typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === 'number'
            ? Number((error as { code?: unknown }).code)
            : 1
          : 0;
        if (error && !opts.allowFail) return reject(new GitError(args, stderr || String(error), code));
        resolve({ stdout, stderr, code });
      },
    );
  });
}

/** 커밋 속 파일 내용을 바이트로(그림 등). 없으면 null. */
export function gitShowBytes(cwd: string, ref: string, file: string, maxBytes = 8 * 1024 * 1024): Promise<Buffer | null> {
  return new Promise((resolve) => {
    execFile(
      'git',
      [...BASE_ARGS, 'show', `${ref}:${file}`],
      { cwd, windowsHide: true, maxBuffer: maxBytes, encoding: 'buffer', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
      (error, stdout) => resolve(error ? null : stdout),
    );
  });
}

export async function gitOut(args: string[], cwd: string): Promise<string> {
  return (await git(args, cwd)).stdout.trim();
}

/** NUL 구분 출력(-z)을 목록으로. */
export function splitZ(out: string): string[] {
  return out.split('\0').filter((s) => s.length > 0);
}

export const AGENT_IDENTITY = ['-c', 'user.name=Agent Company', '-c', 'user.email=agent-company@localhost'];

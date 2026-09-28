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

const BASE_ARGS = ['-c', 'core.quotepath=false', '-c', 'core.longpaths=true', '-c', 'advice.detachedHead=false'];

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

export async function gitOut(args: string[], cwd: string): Promise<string> {
  return (await git(args, cwd)).stdout.trim();
}

/** NUL 구분 출력(-z)을 목록으로. */
export function splitZ(out: string): string[] {
  return out.split('\0').filter((s) => s.length > 0);
}

export const AGENT_IDENTITY = ['-c', 'user.name=Agent Company', '-c', 'user.email=agent-company@localhost'];

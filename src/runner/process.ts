// 직원 CLI 프로세스 실행기.
// - 출력은 파이프가 아니라 파일로 받는다: 데몬이 죽어도 출력이 남고, 재시작 후 이어 읽는다.
// - Windows에서는 detached를 쓰지 않는다: 콘솔 없는 프로세스의 하위 프로세스(git·셸)가 새 콘솔 창을 띄우기 때문.
//   Windows는 부모 종료 시 자식을 죽이지 않으므로 detached 없이도 실행은 계속된다.
// - shell은 절대 쓰지 않는다. argv 배열만.

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface ProcessSpec {
  file: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdinText: string | null;
  runDir: string;
  timeoutMs: number;
}

export interface ProcessOutcome {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  killed: boolean;
  durationMs: number;
}

export interface RunningProcess {
  pid: number;
  startedAtMs: number;
  stdoutPath: string;
  stderrPath: string;
  done: Promise<ProcessOutcome>;
  kill(): Promise<void>;
}

async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await rename(tmp, file);
}

export function runFilePaths(runDir: string) {
  return {
    meta: path.join(runDir, 'run.json'),
    stdout: path.join(runDir, 'stdout.log'),
    stderr: path.join(runDir, 'stderr.log'),
  };
}

export async function startProcess(spec: ProcessSpec): Promise<RunningProcess> {
  if (!(spec.timeoutMs > 0)) throw new RangeError('timeoutMs는 양수여야 합니다.');
  await mkdir(spec.runDir, { recursive: true });
  const files = runFilePaths(spec.runDir);
  const startedAtMs = Date.now();
  const base = { file: spec.file, args: spec.args, cwd: spec.cwd, startedAt: new Date(startedAtMs).toISOString() };
  const record = (data: object) => writeJsonAtomic(files.meta, { ...base, ...data });
  await record({ state: 'starting' });

  const outFd = openSync(files.stdout, 'a');
  const errFd = openSync(files.stderr, 'a');
  let child: ChildProcess;
  try {
    child = spawn(spec.file, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      detached: process.platform !== 'win32',
      windowsHide: true,
      shell: false,
      stdio: ['pipe', outFd, errFd],
    });
  } finally {
    closeSync(outFd);
    closeSync(errFd);
  }

  const closed = new Promise<{ exitCode: number | null; signal: string | null }>((resolve) =>
    child.once('close', (exitCode, signal) => resolve({ exitCode, signal })),
  );
  child.stdin?.on('error', () => {
    /* 조기 종료로 인한 EPIPE는 종료 결과로 판단한다 */
  });
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
  } catch (error) {
    await record({ state: 'exited', exitCode: null, error: String(error), durationMs: Date.now() - startedAtMs });
    throw error;
  }

  const pid = child.pid!;
  let timedOut = false;
  let killed = false;
  let finished = false;
  let termination: Promise<void> | undefined;
  const kill = (): Promise<void> => {
    if (finished) return Promise.resolve();
    killed = true;
    termination ??= killTree(pid);
    return termination;
  };

  await record({ state: 'running', pid });
  const timer = setTimeout(() => {
    timedOut = true;
    void kill().catch(() => {});
  }, spec.timeoutMs);

  const done = (async (): Promise<ProcessOutcome> => {
    const r = await closed;
    clearTimeout(timer);
    await termination?.catch(() => {});
    finished = true;
    const outcome: ProcessOutcome = { ...r, timedOut, killed, durationMs: Date.now() - startedAtMs };
    await record({ state: 'exited', pid, ...outcome });
    return outcome;
  })();

  if (spec.stdinText !== null) child.stdin?.end(spec.stdinText, 'utf8');
  else child.stdin?.end();

  return { pid, startedAtMs, stdoutPath: files.stdout, stderrPath: files.stderr, done, kill };
}

/** 프로세스 트리 종료. */
export async function killTree(pid: number): Promise<void> {
  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      execFile('taskkill', ['/T', '/F', '/PID', String(pid)], { windowsHide: true }, () => resolve());
    });
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* 이미 종료 */
    }
  }
}

export function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** 프로세스 시작 시각(ms). PID 재사용 판별용. 알 수 없으면 null. */
export function processStartTimeMs(pid: number): Promise<number | null> {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${Number(pid)} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`],
        { windowsHide: true, timeout: 10_000 },
        (err, stdout) => {
          const t = Date.parse(String(stdout).trim());
          resolve(err || Number.isNaN(t) ? null : t);
        },
      );
    } else {
      execFile('ps', ['-o', 'lstart=', '-p', String(pid)], { timeout: 10_000 }, (err, stdout) => {
        const t = Date.parse(String(stdout).trim());
        resolve(err || Number.isNaN(t) ? null : t);
      });
    }
  });
}

/** 재시작 후: 기록된 pid가 같은 프로세스로 아직 살아 있는지. 시작 시각이 기록과 5초 이상 다르면 다른 프로세스(PID 재사용). */
export async function isSameProcessAlive(pid: number, recordedStartMs: number): Promise<boolean> {
  if (!isAlive(pid)) return false;
  const actual = await processStartTimeMs(pid);
  if (actual === null) return true;
  return Math.abs(actual - recordedStartMs) < 5_000;
}

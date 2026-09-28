// 직원 CLI 프로세스 실행기.
// - 출력은 파이프가 아니라 파일로 받는다: 데몬이 죽어도 출력이 남고, 재시작 후 이어 읽는다.
// - 실제 CLI는 실행 셔틀(shim.ts)을 거쳐 띄운다. 이유는 shim.ts 상단 주석 참고(Windows Job Object와 콘솔 창 문제).
// - shell은 절대 쓰지 않는다. argv 배열만.

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
  /** 셔틀 프로세스 pid. 트리 종료는 이 pid 기준. */
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
    spec: path.join(runDir, 'shim-spec.json'),
    stdin: path.join(runDir, 'stdin.txt'),
    stdout: path.join(runDir, 'stdout.log'),
    stderr: path.join(runDir, 'stderr.log'),
    pid: path.join(runDir, 'pid.json'),
    exit: path.join(runDir, 'exit.json'),
  };
}

function shimScript(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const ts = path.join(here, 'shim.ts');
  return existsSync(ts) ? ts : path.join(here, 'shim.js');
}

/** exit.json(셔틀이 남긴 종료 기록)을 읽는다. 아직 없으면 null. */
export async function readExitRecord(runDir: string): Promise<(Omit<ProcessOutcome, 'killed'> & { error?: string }) | null> {
  try {
    return JSON.parse(await readFile(runFilePaths(runDir).exit, 'utf8'));
  } catch {
    return null;
  }
}

/** 재시작 후에도 쓸 수 있는 종료 대기: exit.json이 생기거나 셔틀이 사라질 때까지. */
export async function waitForExit(runDir: string, shimPid: number | null, pollMs = 250): Promise<ProcessOutcome> {
  const started = Date.now();
  for (;;) {
    const rec = await readExitRecord(runDir);
    if (rec) return { exitCode: rec.exitCode, signal: rec.signal, timedOut: rec.timedOut, killed: false, durationMs: rec.durationMs };
    if (shimPid !== null && !isAlive(shimPid)) {
      // 셔틀이 기록 없이 사라짐(강제 종료 등). 잠깐 더 기다렸다가 판정.
      await new Promise((r) => setTimeout(r, pollMs));
      const late = await readExitRecord(runDir);
      if (late)
        return { exitCode: late.exitCode, signal: late.signal, timedOut: late.timedOut, killed: false, durationMs: late.durationMs };
      return { exitCode: null, signal: null, timedOut: false, killed: true, durationMs: Date.now() - started };
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

export async function startProcess(spec: ProcessSpec): Promise<RunningProcess> {
  if (!(spec.timeoutMs > 0)) throw new RangeError('timeoutMs는 양수여야 합니다.');
  await mkdir(spec.runDir, { recursive: true });
  const files = runFilePaths(spec.runDir);
  const startedAtMs = Date.now();
  if (spec.stdinText !== null) await writeFile(files.stdin, spec.stdinText, 'utf8');
  await writeJsonAtomic(files.spec, {
    file: spec.file,
    args: spec.args,
    cwd: spec.cwd,
    stdinPath: spec.stdinText !== null ? files.stdin : null,
    stdoutPath: files.stdout,
    stderrPath: files.stderr,
    pidPath: files.pid,
    exitPath: files.exit,
    timeoutMs: spec.timeoutMs,
  });
  await writeJsonAtomic(files.meta, {
    file: spec.file,
    args: spec.args,
    cwd: spec.cwd,
    startedAt: new Date(startedAtMs).toISOString(),
    state: 'starting',
  });

  // 셔틀은 detached: 데몬의 Job Object 밖에서 살아남는다. 셔틀 자신은 창을 만들지 않는다.
  const shim: ChildProcess = spawn(process.execPath, ['--no-warnings', shimScript(), files.spec], {
    cwd: spec.cwd,
    env: spec.env,
    detached: true,
    windowsHide: true,
    shell: false,
    stdio: 'ignore',
  });
  await new Promise<void>((resolve, reject) => {
    shim.once('spawn', resolve);
    shim.once('error', reject);
  });
  shim.unref();
  const pid = shim.pid!;
  await writeJsonAtomic(files.meta, {
    file: spec.file,
    args: spec.args,
    cwd: spec.cwd,
    startedAt: new Date(startedAtMs).toISOString(),
    state: 'running',
    shimPid: pid,
  });

  let killed = false;
  const kill = async () => {
    killed = true;
    if (process.platform !== 'win32') {
      // 먼저 셔틀에게 정중히 요청한다: 셔틀이 CLI 그룹을 끝내고 나간다(CLI pid가 아직 기록되지 않은 경쟁도 셔틀이 처리).
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        /* 이미 종료 */
      }
      await new Promise((r) => setTimeout(r, 500));
      // CLI는 셔틀과 다른 프로세스 그룹이다: CLI 그룹부터 종료한다.
      const rec = await readFile(files.pid, 'utf8')
        .then((x) => JSON.parse(x) as { cliPid?: number })
        .catch(() => null);
      if (rec?.cliPid) {
        try {
          process.kill(-rec.cliPid, 'SIGKILL');
        } catch {
          /* 이미 종료 */
        }
      }
    }
    await killTree(pid);
  };
  const done = waitForExit(spec.runDir, pid).then(async (o) => {
    const outcome = { ...o, killed: o.killed || killed };
    await writeJsonAtomic(files.meta, {
      file: spec.file,
      args: spec.args,
      cwd: spec.cwd,
      startedAt: new Date(startedAtMs).toISOString(),
      state: 'exited',
      shimPid: pid,
      ...outcome,
    });
    return outcome;
  });
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
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `(Get-Process -Id ${Number(pid)} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`,
        ],
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

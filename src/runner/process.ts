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
      // 셔틀만 죽고 CLI는 살아 있을 수 있다(Unix: 별도 프로세스 그룹). 끝났다고 보고하기 전에 CLI 그룹을 정리한다.
      await terminateRun(runDir, null);
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
    await terminateRun(spec.runDir, pid);
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

/**
 * 실행 종료(재시작 후 남은 실행 정리에도 사용).
 * - 아직 셔틀이 CLI를 띄우기 전이면 포기 표시로 막는다.
 * - Unix: 셔틀에 SIGTERM → 셔틀이 CLI 그룹을 끝낸다. 이어서 pid.json의 CLI 그룹과 셔틀을 강제 종료한다.
 * - Windows: 셔틀 트리 전체를 종료한다(CLI는 셔틀의 자식).
 */
export async function terminateRun(runDir: string, shimPid: number | null): Promise<void> {
  const files = runFilePaths(runDir);
  await writeFile(path.join(runDir, 'abandoned'), new Date().toISOString()).catch(() => {});
  if (shimPid !== null && process.platform !== 'win32') {
    try {
      process.kill(shimPid, 'SIGTERM');
    } catch {
      /* 이미 종료 */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  // 셔틀이 이미 죽었어도 CLI는 남아 있을 수 있다(Unix에서는 별도 프로세스 그룹): 셔틀 생존과 무관하게 정리한다.
  const rec = await readFile(files.pid, 'utf8')
    .then((x) => JSON.parse(x) as { cliPid?: number | null; startedAtMs?: number })
    .catch(() => null);
  if (rec?.cliPid) {
    if (process.platform === 'win32') {
      // Windows: 셔틀(Node)이 죽으면 그 자식은 libuv의 kill-on-close Job Object로 OS가 함께 종료한다.
      // 셔틀이 살아 있거나 CLI가 아직 같은 프로세스로 살아 있을 때만 트리를 종료한다(PID 재사용 방지).
      if (await isSameProcessAlive(rec.cliPid, rec.startedAtMs ?? 0)) await killTree(rec.cliPid);
    } else {
      // Unix: 그룹 리더(CLI)가 먼저 죽어도 그룹 구성원은 남을 수 있다. 리더 생존과 무관하게 그룹 전체에 보낸다.
      try {
        process.kill(-rec.cliPid, 'SIGKILL');
      } catch {
        /* 그룹이 이미 없음 */
      }
    }
  }
  if (shimPid !== null) await killTree(shimPid);
}

/**
 * 재시작 후 남은 실행 정리: 포기 표시를 "먼저" 남기고 잠시 기다린 뒤 셔틀 기록을 찾는다.
 * 셔틀은 pid를 기록한 직후 포기 표시를 확인하므로, 표시 이후 시작하는 셔틀은 스스로 멈추고
 * 표시 이전에 시작한 셔틀은 이 시점에 pid 기록이 있어 종료 대상이 된다.
 */
export async function abandonAndTerminate(runDir: string): Promise<void> {
  await mkdir(runDir, { recursive: true }).catch(() => {});
  await writeFile(path.join(runDir, 'abandoned'), new Date().toISOString()).catch(() => {});
  await new Promise((r) => setTimeout(r, 1500));
  const files = runFilePaths(runDir);
  const pidRec = await readFile(files.pid, 'utf8')
    .then((x) => JSON.parse(x) as { shimPid?: number; startedAtMs?: number })
    .catch(() => null);
  const shimAlive = pidRec?.shimPid ? await isSameProcessAlive(pidRec.shimPid, pidRec.startedAtMs ?? 0) : false;
  await terminateRun(runDir, shimAlive && pidRec?.shimPid ? pidRec.shimPid : null);
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

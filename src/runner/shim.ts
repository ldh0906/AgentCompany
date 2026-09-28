// 실행 셔틀. 데몬이 detached로 띄우고, 셔틀이 실제 CLI를 windowsHide로 띄운다.
//
// 왜 두 단계인가 (Windows 실측):
// - Node(libuv)는 detached가 아닌 자식을 "부모가 죽으면 같이 죽는" Job Object에 넣는다 → 데몬이 죽으면 직원 CLI도 죽는다.
// - detached 자식은 콘솔이 없어(DETACHED_PROCESS) 그 하위 프로세스(git·셸)마다 새 콘솔 창이 뜬다.
// 셔틀은 detached라 데몬과 독립적으로 살아남고, CLI는 셔틀의 자식으로 CREATE_NO_WINDOW(숨은 콘솔)를 받아 창이 뜨지 않는다.
//
// 환경변수는 파일에 쓰지 않는다(비밀값이 있을 수 있음). 셔틀의 환경이 그대로 CLI로 넘어간다.

import { spawn, execFile } from 'node:child_process';
import { closeSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

interface ShimSpec {
  file: string;
  args: string[];
  cwd: string;
  stdinPath: string | null;
  stdoutPath: string;
  stderrPath: string;
  pidPath: string;
  exitPath: string;
  timeoutMs: number;
}

function writeAtomic(path: string, data: unknown): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data), 'utf8');
  renameSync(tmp, path);
}

const spec = JSON.parse(readFileSync(process.argv[2]!, 'utf8')) as ShimSpec;
const started = Date.now();
const outFd = openSync(spec.stdoutPath, 'a');
const errFd = openSync(spec.stderrPath, 'a');
const child = spawn(spec.file, spec.args, {
  cwd: spec.cwd,
  env: process.env,
  windowsHide: true,
  shell: false,
  // Unix: 별도 프로세스 그룹 → 시간 초과 시 하위 프로세스(셸·빌드)까지 함께 종료. Windows는 taskkill /T가 트리를 종료한다.
  detached: process.platform !== 'win32',
  stdio: [spec.stdinPath ? 'pipe' : 'ignore', outFd, errFd],
});
closeSync(outFd);
closeSync(errFd);

let timedOut = false;
child.once('error', (error) => {
  writeAtomic(spec.exitPath, { exitCode: null, signal: null, timedOut: false, error: String(error), durationMs: Date.now() - started });
  process.exit(1);
});
child.once('spawn', () => {
  writeAtomic(spec.pidPath, { shimPid: process.pid, cliPid: child.pid, startedAtMs: started });
  if (spec.stdinPath && child.stdin) {
    child.stdin.on('error', () => {});
    child.stdin.end(readFileSync(spec.stdinPath));
  }
});

const timer = setTimeout(() => {
  timedOut = true;
  if (!child.pid) return;
  if (process.platform === 'win32') execFile('taskkill', ['/T', '/F', '/PID', String(child.pid)], { windowsHide: true }, () => {});
  else {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  }
}, spec.timeoutMs);

child.once('close', (exitCode, signal) => {
  clearTimeout(timer);
  writeAtomic(spec.exitPath, { exitCode, signal, timedOut, durationMs: Date.now() - started });
  process.exit(0);
});

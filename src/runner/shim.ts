// 실행 셔틀. 데몬이 detached로 띄우고, 셔틀이 실제 CLI를 windowsHide로 띄운다.
//
// 왜 두 단계인가 (Windows 실측):
// - Node(libuv)는 detached가 아닌 자식을 "부모가 죽으면 같이 죽는" Job Object에 넣는다 → 데몬이 죽으면 직원 CLI도 죽는다.
// - detached 자식은 콘솔이 없어(DETACHED_PROCESS) 그 하위 프로세스(git·셸)마다 새 콘솔 창이 뜬다.
// 셔틀은 detached라 데몬과 독립적으로 살아남고, CLI는 셔틀의 자식으로 CREATE_NO_WINDOW(숨은 콘솔)를 받아 창이 뜨지 않는다.
//
// 환경변수는 파일에 쓰지 않는다(비밀값이 있을 수 있음). 셔틀의 환경이 그대로 CLI로 넘어간다.

import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

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
// 프로세스 그룹 설계:
// - Unix: 셔틀은 데몬이 detached(setsid)로 띄워 자기 그룹의 리더다(그룹 번호 = 셔틀 pid). CLI와 그 자손은 같은 그룹에 둔다.
//   그룹 번호가 시작 순간부터 알려져 있으므로 "CLI pid 기록 전" 공백이 없다. 끝낼 때는 종료 기록을 쓴 뒤 그룹 전체를 정리한다.
// - Windows: 셔틀(Node)의 자식은 libuv의 kill-on-close Job Object에 들어간다. 셔틀이 끝나면 OS가 CLI와 그 자손을 모두 종료한다.
const IS_WIN = process.platform === 'win32';

/** 종료 기록을 남기고, 남은 자손까지 정리하며 끝낸다. */
function finish(record: Record<string, unknown>): never {
  writeAtomic(spec.exitPath, { ...record, durationMs: Date.now() - started });
  if (!IS_WIN) {
    try {
      process.kill(-process.pid, 'SIGKILL'); // 자기 그룹 전체(셔틀 자신 포함): CLI가 남긴 빌드·서버 자식까지
    } catch {
      /* 그룹 없음 */
    }
  }
  process.exit(0); // Windows: Job Object가 남은 자손을 종료
}

// 시작하자마자 자기 pid(= Unix 그룹 번호)를 남긴다(데몬이 기록 전에 죽어도 복구가 찾을 수 있게).
writeAtomic(spec.pidPath, { shimPid: process.pid, pgid: IS_WIN ? null : process.pid, cliPid: null, startedAtMs: started });
// 복구가 이 실행을 포기했으면 CLI를 띄우지 않는다(중복 실행 방지).
if (existsSync(path.join(path.dirname(spec.pidPath), 'abandoned'))) {
  writeAtomic(spec.exitPath, { exitCode: null, signal: null, timedOut: false, abandoned: true, durationMs: 0 });
  process.exit(0);
}
// 종료 요청 처리기는 CLI를 띄우기 전에 설치한다.
process.on('SIGTERM', () => finish({ exitCode: null, signal: 'SIGTERM', timedOut: false, killed: true }));

const outFd = openSync(spec.stdoutPath, 'a');
const errFd = openSync(spec.stderrPath, 'a');
const child: ChildProcess = spawn(spec.file, spec.args, {
  cwd: spec.cwd,
  env: process.env,
  windowsHide: true,
  shell: false,
  detached: false, // 셔틀과 같은 그룹(Unix) / 같은 Job(Windows)
  stdio: [spec.stdinPath ? 'pipe' : 'ignore', outFd, errFd],
});
closeSync(outFd);
closeSync(errFd);
if (child.pid)
  writeAtomic(spec.pidPath, { shimPid: process.pid, pgid: IS_WIN ? null : process.pid, cliPid: child.pid, startedAtMs: started });

let timedOut = false;
child.once('error', (error) => finish({ exitCode: null, signal: null, timedOut: false, error: String(error) }));
child.once('spawn', () => {
  if (spec.stdinPath && child.stdin) {
    child.stdin.on('error', () => {});
    child.stdin.end(readFileSync(spec.stdinPath));
  }
});

const timer = setTimeout(() => {
  timedOut = true;
  if (IS_WIN) {
    if (child.pid) execFile('taskkill', ['/T', '/F', '/PID', String(child.pid)], { windowsHide: true }, () => {});
  } else {
    finish({ exitCode: null, signal: 'SIGKILL', timedOut: true });
  }
}, spec.timeoutMs);

// CLI가 끝나면(자손을 남겼더라도) 종료 기록 후 그룹·Job 전체를 정리한다.
child.once('close', (exitCode: number | null, signal: NodeJS.Signals | null) => {
  clearTimeout(timer);
  finish({ exitCode, signal, timedOut });
});

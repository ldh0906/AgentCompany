// 확인용 실행: 화면이 없는 프로그램(API·CLI·파이썬)을 대표가 확인할 수 있게, 담당 직원이 남긴 실행 명령을
// 제출본의 깨끗한 사본에서 돌리고 출력을 남긴다. QA 직원과 대표가 그 출력을 읽고 판단한다.
// 대표 요청(2026-10-01): 게임·웹만이 아니라 백엔드 API·CLI·파이썬 도구에도 쓰고 싶다.
//
// 보안: 명령은 직원이 정한다. 그래서 모양을 좁힌다: python/py/node + 프로젝트 안의 파일(또는 python -m 모듈).
// 이는 이미 자동으로 도는 검사 명령(npm test, python -m unittest)이 제출된 코드를 실행하는 것과 같은 수준이다.
// 셸·인라인 코드(-c, -e)·프로젝트 밖 파일은 받지 않는다.
import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { tr } from '../core/i18n.ts';
import { locateExecutable } from '../runner/locate.ts';
import { startProcess } from '../runner/process.ts';

export interface DemoCommand {
  requirementId: string;
  argv: string[];
  label: string;
}

export interface DemoResult extends DemoCommand {
  exitCode: number | null;
  timedOut: boolean;
  /** 표준 출력(끝부분) */
  output: string;
  /** 오류 출력(끝부분) */
  errors: string;
  /** 돌리지 않은 이유(허용되지 않는 명령 등) */
  skipped?: string;
}

const INTERPRETERS = new Set(['python', 'py', 'node']);
const MAX_DEMOS = 5;

/** 보고서의 demoCommands를 읽는다(형식이 틀린 항목은 버린다). */
export function demoCommandsOf(v: unknown, requirementIds: string[]): DemoCommand[] {
  if (!Array.isArray(v)) return [];
  const out: DemoCommand[] = [];
  for (const x of v as Record<string, unknown>[]) {
    const argv = Array.isArray(x?.argv) ? (x.argv as unknown[]).filter((a): a is string => typeof a === 'string' && a.length <= 300) : [];
    if (!argv.length || argv.length > 20) continue;
    const id = typeof x.requirementId === 'string' && requirementIds.includes(x.requirementId) ? x.requirementId : '*';
    out.push({ requirementId: id, argv, label: typeof x.label === 'string' ? x.label.slice(0, 300) : '' });
  }
  return out.slice(0, MAX_DEMOS);
}

/** 돌려도 되는 모양인지. 안 되면 이유(대표·QA에게 보여 준다). */
export function demoRefusal(argv: string[], dir: string): string | null {
  const [cmd, first, second] = argv;
  if (!cmd || !INTERPRETERS.has(cmd.toLowerCase()))
    return tr(`허용되지 않는 실행 파일: ${cmd ?? ''} (python·node만)`, `Not allowed: ${cmd ?? ''} (python or node only)`);
  if (cmd !== 'node' && first === '-m')
    return second && /^[A-Za-z_][\w.]*$/.test(second) ? null : tr('모듈 이름이 올바르지 않습니다.', 'Invalid module name.');
  if (!first || first.startsWith('-'))
    return tr(
      '첫 인자는 프로젝트 안의 파일이어야 합니다(-c·-e 같은 인라인 코드는 안 됨).',
      'The first argument must be a file in the project.',
    );
  const file = path.resolve(dir, first);
  const root = path.resolve(dir);
  if (!file.startsWith(root + path.sep) || !existsSync(file) || !statSync(file).isFile())
    return tr(`프로젝트 안에 없는 파일: ${first}`, `Not a file in the project: ${first}`);
  return null;
}

/** 결과 한 줄: "끝남(0)", "오류로 끝남(1)", "시간 초과", "돌리지 않음: …" */
export function demoResultLine(d: DemoResult): string {
  if (d.skipped) return tr(`돌리지 않음: ${d.skipped}`, `Not run: ${d.skipped}`);
  if (d.timedOut) return tr('시간 초과(60초)로 멈춤', 'Stopped: timed out (60 s)');
  return d.exitCode === 0
    ? tr('정상 종료(0)', 'Exited normally (0)')
    : tr(`오류로 끝남(${d.exitCode ?? '-'})`, `Failed (exit ${d.exitCode ?? '-'})`);
}

const tail = async (f: string, n: number) => {
  const s = await readFile(f, 'utf8').catch(() => '');
  return s.length > n ? `…\n${s.slice(-n)}` : s;
};

/** 차례로 돌린다(각 60초). 실행 기록은 runRoot 아래에 남는다. */
export async function runDemos(cmds: DemoCommand[], dir: string, runRoot: string, timeoutMs = 60_000): Promise<DemoResult[]> {
  const out: DemoResult[] = [];
  for (const [i, c] of cmds.entries()) {
    const base = { ...c, exitCode: null, timedOut: false, output: '', errors: '' };
    const refusal = demoRefusal(c.argv, dir);
    if (refusal) {
      out.push({ ...base, skipped: refusal });
      continue;
    }
    const exe = c.argv[0]!;
    const located = await locateExecutable(exe);
    if (!located?.launch) {
      out.push({ ...base, skipped: tr(`${exe}을(를) 찾지 못했습니다.`, `${exe} not found.`) });
      continue;
    }
    const proc = await startProcess({
      file: located.launch.file,
      args: [...located.launch.argsPrefix, ...c.argv.slice(1)],
      cwd: dir,
      // 윈도우 콘솔 기본 인코딩(cp949)에서 파이썬 한글 출력이 깨지거나 오류가 나지 않게 UTF-8로.
      env: { ...process.env, CI: '1', PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', FORCE_COLOR: '0', NO_COLOR: '1' },
      stdinText: '',
      runDir: path.join(runRoot, String(i)),
      timeoutMs,
    });
    const o = await proc.done;
    out.push({
      ...base,
      exitCode: o.exitCode,
      timedOut: o.timedOut,
      output: await tail(proc.stdoutPath, 6000),
      errors: await tail(proc.stderrPath, 2000),
    });
  }
  return out;
}

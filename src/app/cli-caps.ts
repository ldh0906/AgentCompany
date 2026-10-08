// 설치된 CLI가 Agent Company가 넘기는 옵션을 아직 지원하는지: 실행 파일의 도움말로 확인한다.
// OpenRig 비교(2026-10-08, claude-managed-launch): CLI가 업데이트되며 옵션이 없어지거나 바뀌면 모든 실행이 같은 이유로
// 실패하고, 대표에게는 "실행 실패"만 보였다. 실행 파일이 바뀔 때(경로·수정 시각·크기) 또는 6시간마다 다시 확인한다.
import { execFile } from 'node:child_process';
import type { CliAdapter } from '../adapters/types.ts';

export interface CliCaps {
  /** 이 결과를 얻은 실행 파일(경로|수정 시각|크기). 바뀌면 다시 확인한다. */
  key: string;
  version: string | null;
  /** 도움말에 없는 옵션·하위 명령 */
  missing: string[];
  checkedAt: string;
  /** 도움말을 읽지 못했으면 그 이유(이때는 막지 않는다: 근거가 없다) */
  error?: string;
}

export const CAPS_TTL_MS = 6 * 3600_000;

function run(file: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; out: string; killed: boolean }> {
  return new Promise((resolve) => {
    execFile(file, args, { env, windowsHide: true, timeout: 20_000, encoding: 'utf8', maxBuffer: 4 << 20 }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? Number((error as { code?: unknown }).code) : 1) : 0;
      resolve({ code, out: `${stdout}\n${stderr}`, killed: Boolean((error as { killed?: boolean } | null)?.killed) });
    });
  });
}

/** 도움말에 그 낱말이 따로 있는지(`-p`가 `--print` 안에서 잡히지 않게 앞뒤 경계를 본다). */
export function helpHas(help: string, token: string): boolean {
  const esc = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[\\s,\\[(|])${esc}(?=[\\s,=\\])|<]|$)`, 'm').test(help);
}

/**
 * 실행 파일의 버전과 도움말에 없는 옵션. 도움말이라는 근거가 없으면 error만 남기고 막지 않는다:
 * 시간 초과로 끊겼거나, 확인할 낱말도 도움말 표시(usage·options·commands)도 없을 때(업데이트 안내만 찍고 끝난 경우 등, QA 2026-10-08).
 */
export async function probeCli(
  adapter: Pick<CliAdapter, 'helpChecks'>,
  launch: { file: string; argsPrefix: string[] },
  env: NodeJS.ProcessEnv,
  key: string,
): Promise<CliCaps> {
  const v = await run(launch.file, [...launch.argsPrefix, '--version'], env);
  const caps: CliCaps = {
    key,
    version: v.code === 0 ? (v.out.trim().split('\n')[0] ?? '').slice(0, 120) || null : null,
    missing: [],
    checkedAt: new Date().toISOString(),
  };
  for (const check of adapter.helpChecks ?? []) {
    const h = await run(launch.file, [...launch.argsPrefix, ...check.args], env);
    const missing = check.tokens.filter((t) => !helpHas(h.out, t));
    const looksLikeHelp = missing.length < check.tokens.length || /\b(usage|options|commands)\b/i.test(h.out);
    if (h.killed || !looksLikeHelp) {
      caps.error = `${check.args.join(' ')}: ${h.killed ? 'timed out' : `exit ${h.code}`}, no help text`;
      continue;
    }
    caps.missing.push(...missing);
  }
  return caps;
}

/**
 * 이번 실행이 실제로 쓰는 것 중 빠진 것. 옵션(`-`로 시작)은 이번 인자에 있을 때만(예: effort를 안 쓰면 --effort는 상관없다),
 * 하위 명령(Codex app-server 등)은 늘 필요하다.
 */
export function lacksFor(caps: Pick<CliCaps, 'missing'>, args: string[]): string[] {
  return caps.missing.filter((t) => !t.startsWith('-') || args.some((a) => a === t || a.startsWith(`${t}=`)));
}

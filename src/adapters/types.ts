import type { AccessLevel, CliKind, FailureClass, TokenUsage } from '../core/types.ts';
import type { CompanyToolsSpec } from '../approvals/company-tools.ts';

export interface InvocationRequest {
  prompt: string;
  cwd: string;
  model: string | null;
  /** 추론 강도(effort). null이면 CLI 기본값. */
  effort?: string | null;
  accessLevel: AccessLevel;
  allowedCommands: string[][];
  /** 앱 전용 프로필 폴더 등 추가 환경변수. */
  profileEnv: Record<string, string>;
  resumeSessionId?: string;
  /** 실행 중 권한 요청을 GUI로 중계할 때 쓰는 파일 큐 폴더(지원하는 CLI만). */
  approvalDir?: string;
  /** 웹 검색·페이지 읽기 허용(조사 업무). 없으면 막는다. */
  web?: boolean;
  /** 회사 도구 MCP 서버를 붙인다(지원하는 CLI만, company-tools.ts). */
  companyTools?: CompanyToolsSpec;
  runDir: string;
}

export interface Invocation {
  file: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  stdinText: string | null;
  /** 실행 전에 써야 하는 보조 파일(예: MCP 설정). */
  files: { path: string; content: string }[];
}

export interface ParsedRun {
  sessionId: string | null;
  finalText: string | null;
  errorText: string | null;
  usage?: TokenUsage | null;
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** 사용량 합산 도우미. */
export function addUsage(a: TokenUsage | null, b: TokenUsage): TokenUsage {
  if (!a) return b;
  return {
    input: a.input + b.input,
    cacheRead: a.cacheRead + b.cacheRead,
    output: a.output + b.output,
    total: a.total + b.total,
    costUsd: a.costUsd === null && b.costUsd === null ? null : (a.costUsd ?? 0) + (b.costUsd ?? 0),
  };
}

/** 실측 형식별 사용량 객체 → 공통 형식. */
export function usageFrom(kind: 'claude' | 'codex' | 'agy', u: Record<string, unknown>, costUsd: unknown = null): TokenUsage {
  if (kind === 'claude') {
    const input = num(u.input_tokens) + num(u.cache_creation_input_tokens) + num(u.cache_read_input_tokens);
    const output = num(u.output_tokens);
    return {
      input,
      cacheRead: num(u.cache_read_input_tokens),
      output,
      total: input + output,
      costUsd: typeof costUsd === 'number' ? costUsd : null,
    };
  }
  if (kind === 'codex') {
    const input = num(u.input_tokens);
    const output = num(u.output_tokens);
    return { input, cacheRead: num(u.cached_input_tokens), output, total: input + output, costUsd: null };
  }
  const input = num(u.input_tokens);
  const output = num(u.output_tokens);
  return { input, cacheRead: num(u.cache_read_tokens), output, total: num(u.total_tokens) || input + output, costUsd: null };
}

export interface AdapterCapabilities {
  accessLevels: AccessLevel[];
  /** 실행 중 권한 요청을 GUI로 중계할 수 있는지. */
  permissionRelay: boolean;
  /** 실행 중 회사 도구(MCP)를 쓸 수 있는지. */
  companyTools: boolean;
  resume: boolean;
  /** 앱 전용 프로필 폴더 환경변수 이름(없으면 null). */
  profileEnvVar: string | null;
  /** 실측으로 확인된 사실과 추정을 구분한 메모. */
  notes: string[];
}

export interface CliAdapter {
  kind: CliKind;
  displayName: string;
  executable: string;
  capabilities: AdapterCapabilities;
  buildInvocation(req: InvocationRequest): Invocation;
  parse(events: unknown[]): ParsedRun;
  classifyFailure(input: { exitCode: number | null; timedOut: boolean; stderr: string; finalText: string | null }): FailureClass;
  /** 공식 로그인 상태 확인 명령(없으면 null). 인증 파일을 직접 읽지 않는다. */
  loginStatusArgs: string[] | null;
  /** 로그인 창에서 실행할 인자(null이면 로그인이 필요 없음). */
  loginArgs: string[] | null;
  /** 대표가 직접 실행할 로그인 안내. */
  loginInstructions(profileDir: string | null): string;
  /**
   * 설치된 실행 파일이 우리가 넘기는 옵션을 지원하는지 확인할 도움말 명령과 거기 있어야 할 낱말(cli-caps.ts).
   * 숨김 옵션처럼 도움말에 없을 수 있는 것은 넣지 않는다(근거 없이 막지 않게).
   */
  helpChecks?: { args: string[]; tokens: string[] }[];
}

export function obj(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

// 실측(Claude Code 2.1.202): "does not support this model; version 2.1.280 or newer is required",
// "There's an issue with the selected model (…). It may not exist or you may not have access to it."
const MODEL_PATTERNS = [
  /issue with the selected model/i,
  /may not exist or you may not have access/i,
  /does not support this model/i,
  /or newer is required/i,
  /unknown model/i,
  /model[^\n]{0,40}(not found|not supported|unsupported|does not exist)/i,
];
const USAGE_PATTERNS = [/usage limit/i, /rate limit/i, /quota/i, /limit reached/i, /429/, /too many requests/i, /사용량/];
// 실측(2026-09-30, Claude Code): "Failed to refresh OAuth token: another Claude Code process is refreshing it ...
// This is usually transient; retry in a minute". 로그인 문제가 아니라 잠시 뒤 다시 하면 되는 오류.
export const TRANSIENT_PATTERNS = [
  /failed to refresh oauth token/i,
  /usually transient/i,
  /retry in a minute/i,
  /overloaded/i,
  /\b(502|503|504|529)\b/,
  /internal server error/i,
  /ECONNRESET|ETIMEDOUT|socket hang up|network error/i,
];

export function isTransient(text: string | null | undefined): boolean {
  return Boolean(text && TRANSIENT_PATTERNS.some((p) => p.test(text)));
}
const AUTH_PATTERNS = [
  /not logged in/i,
  /authentication required/i,
  /please log ?in/i,
  /unauthorized/i,
  /invalid api key/i,
  /\/login/i,
  /401/,
];

/** 공통 실패 분류. 모르는 경우 unknown으로 두고 추측으로 재시도하지 않는다. */
export function classifyCommon(input: {
  exitCode: number | null;
  timedOut: boolean;
  stderr: string;
  finalText: string | null;
}): FailureClass {
  if (input.timedOut) return 'timeout';
  const text = `${input.stderr}\n${input.finalText ?? ''}`;
  if (isTransient(text)) return 'transient';
  if (AUTH_PATTERNS.some((p) => p.test(text))) return 'auth_required';
  if (MODEL_PATTERNS.some((p) => p.test(text))) return 'model_unsupported';
  if (USAGE_PATTERNS.some((p) => p.test(text))) return 'usage_limit';
  if (input.exitCode !== 0) return 'crash';
  return 'unknown';
}

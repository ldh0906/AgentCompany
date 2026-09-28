import type { AccessLevel, CliKind, FailureClass } from '../core/types.ts';

export interface InvocationRequest {
  prompt: string;
  cwd: string;
  model: string | null;
  accessLevel: AccessLevel;
  allowedCommands: string[][];
  /** 앱 전용 프로필 폴더 등 추가 환경변수. */
  profileEnv: Record<string, string>;
  resumeSessionId?: string;
  /** 실행 중 권한 요청을 GUI로 중계할 때 쓰는 파일 큐 폴더(지원하는 CLI만). */
  approvalDir?: string;
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
}

export interface AdapterCapabilities {
  accessLevels: AccessLevel[];
  /** 실행 중 권한 요청을 GUI로 중계할 수 있는지. */
  permissionRelay: boolean;
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
  /** 대표가 직접 실행할 로그인 안내. */
  loginInstructions(profileDir: string | null): string;
}

export function obj(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

const USAGE_PATTERNS = [/usage limit/i, /rate limit/i, /quota/i, /limit reached/i, /429/, /too many requests/i, /사용량/];
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
  if (AUTH_PATTERNS.some((p) => p.test(text))) return 'auth_required';
  if (USAGE_PATTERNS.some((p) => p.test(text))) return 'usage_limit';
  if (input.exitCode !== 0) return 'crash';
  return 'unknown';
}

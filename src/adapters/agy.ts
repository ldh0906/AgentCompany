// Antigravity CLI(agy) 어댑터.
// 실측(2026-09-28, 1.2.12): -p/--print는 값을 받는 옵션이라 stdin 프롬프트를 무시하고 exit 2.
// → 프롬프트를 --print=<값>으로 넘긴다. Windows 명령줄 한계(약 32K자) 때문에 프롬프트 길이를 제한한다.
// 권한 옵션은 --sandbox, --dangerously-skip-permissions 뿐. 실행 중 권한 중계 수단은 없다.
// 실측(2026-09-29): 출력은 {"event":…} 형식, 최종 응답은 {"event":"result","result":{"status","response"}}.
// 앱 전용 프로필 폴더 환경변수는 확인하지 못했다.
import { tr } from '../core/i18n.ts';

import {
  addUsage,
  classifyCommon,
  obj,
  usageFrom,
  type CliAdapter,
  type Invocation,
  type InvocationRequest,
  type ParsedRun,
} from './types.ts';
import type { TokenUsage } from '../core/types.ts';

export const AGY_MAX_PROMPT_CHARS = 28_000;

export const agyAdapter: CliAdapter = {
  kind: 'agy',
  displayName: 'Antigravity',
  executable: 'agy',
  capabilities: {
    accessLevels: ['read-only', 'full-auto'],
    permissionRelay: false,
    resume: true,
    profileEnvVar: null,
    get notes() {
      return [
        tr(
          '실측: -p는 값을 받는 옵션(stdin 무시) → --print=<프롬프트> 사용',
          'Verified: -p requires a value (ignores stdin); uses --print=<prompt>',
        ),
        tr('프롬프트 길이 제한 약 28,000자(Windows 명령줄 한계)', 'Prompt limit: about 28,000 characters (Windows command-line limit)'),
        tr(
          '실측: 읽기 전용(--sandbox)은 파일 읽기만 되고, 권한이 필요한 도구는 헤드리스에서 자동 거부',
          'Verified: read-only (--sandbox) can read files; tools that need permission are auto-denied headless',
        ),
        tr('앱 전용 프로필 분리 수단 미확인', 'App profile isolation is unverified'),
      ];
    },
  },

  buildInvocation(req: InvocationRequest): Invocation {
    if (req.prompt.length > AGY_MAX_PROMPT_CHARS) {
      throw new Error(
        tr(
          `agy는 프롬프트를 명령줄로 받아 ${AGY_MAX_PROMPT_CHARS}자를 넘길 수 없습니다(현재 ${req.prompt.length}자).`,
          `agy takes prompts on the command line: limit ${AGY_MAX_PROMPT_CHARS} characters (current: ${req.prompt.length}).`,
        ),
      );
    }
    const args = ['--output-format', 'stream-json'];
    const readOnly = req.accessLevel === 'read-only';
    if (readOnly) args.push('--sandbox');
    else args.push('--dangerously-skip-permissions');
    // agy는 effort가 모델 ID 끝에 붙는다(gemini-3.8-flash-high 등).
    if (req.model) args.push('--model', req.effort ? `${req.model}-${req.effort}` : req.model);
    if (req.resumeSessionId) args.push('--conversation', req.resumeSessionId);
    // 실측(첫 사용, 2026-10-01): 읽기 전용 초안에서 폴더를 보려고 run_command(Get-ChildItem)를 불렀다가
    // 헤드리스 자동 거부로 빈 응답을 내고 끝났다. 폴더 목록 도구도 보이지 않아(실측) 파일 읽기만 쓰라고 먼저 알린다.
    // 파일 목록은 초안 프롬프트가 넣어 준다.
    const note = readOnly
      ? '\n\nTool note for this run: shell commands (run_command) are blocked and will end the run with no answer. ' +
        'Read files with view_file (absolute paths under your current directory); use any project file list given above. ' +
        'If the project has no files yet, plan from the request alone.'
      : '';
    args.push(`--print=${req.prompt}${note}`);
    return { file: 'agy', args, env: { ...process.env, ...req.profileEnv }, stdinText: null, files: [] };
  },

  parse(events: unknown[]): ParsedRun {
    let sessionId: string | null = null;
    let finalText: string | null = null;
    let errorText: string | null = null;
    let usage: TokenUsage | null = null;
    for (const raw of events) {
      const e = obj(raw);
      if (!e) continue;
      for (const k of ['session_id', 'conversation_id', 'conversationId']) {
        if (!sessionId && typeof e[k] === 'string') sessionId = e[k] as string;
      }
      if (e.type === 'result' && typeof e.result === 'string') finalText = e.result;
      // 실측(1.2.12): {"event":"result","result":{"conversation_id","status":"SUCCESS","response"}}
      const result = e.event === 'result' ? obj(e.result) : null;
      const u = obj(result?.usage);
      if (u) usage = addUsage(usage, usageFrom('agy', u));
      if (result) {
        if (!sessionId && typeof result.conversation_id === 'string') sessionId = result.conversation_id;
        // 헤드리스(--sandbox)에서 권한이 필요한 도구는 자동 거부되고, 빈 응답의 SUCCESS가 온다(사유는 stderr).
        if (result.status === 'SUCCESS' && typeof result.response === 'string' && result.response.trim()) finalText = result.response;
        else errorText = `agy result: ${String(result.status ?? 'unknown')}${result.status === 'SUCCESS' ? ' (empty response)' : ''}`;
      }
      if (e.event === 'error') errorText = String(obj(e.error)?.message ?? e.message ?? 'error');
      const msg = obj(e.message);
      if ((e.type === 'assistant' || msg?.role === 'assistant') && finalText === null) {
        const content = msg?.content ?? e.content;
        if (typeof content === 'string') finalText = content;
        else if (Array.isArray(content)) {
          const parts = content
            .map(obj)
            .filter((p) => p?.type === 'text' && typeof p.text === 'string')
            .map((p) => String(p!.text));
          if (parts.length) finalText = parts.join('');
        }
      }
      if (e.type === 'error') errorText = String(e.message ?? 'error');
    }
    return { sessionId, finalText, errorText, usage };
  },

  classifyFailure: classifyCommon,
  loginStatusArgs: null,
  loginArgs: [],
  loginInstructions() {
    return tr(
      '터미널에서 agy 를 한 번 실행해 로그인하세요(헤드리스 실행은 캐시된 로그인만 사용합니다).',
      'Run agy once in a terminal to log in (headless runs use cached login only).',
    );
  },
};

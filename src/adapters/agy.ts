// Antigravity CLI(agy) 어댑터.
// 실측(2026-09-28, 1.2.12): -p/--print는 값을 받는 옵션이라 stdin 프롬프트를 무시하고 exit 2.
// → 프롬프트를 --print=<값>으로 넘긴다. Windows 명령줄 한계(약 32K자) 때문에 프롬프트 길이를 제한한다.
// 권한 옵션은 --sandbox, --dangerously-skip-permissions 뿐. 실행 중 권한 중계 수단은 없다.
// 앱 전용 프로필 폴더 환경변수는 확인하지 못했다.
import { tr } from '../core/i18n.ts';

import { classifyCommon, obj, type CliAdapter, type Invocation, type InvocationRequest, type ParsedRun } from './types.ts';

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
          '읽기 전용은 --sandbox + 권한 자동 승인 없음(헤드리스에서 도구 권한이 거부되는지 실측 전)',
          'Read-only uses --sandbox without auto-approval (headless tool permission denial not yet verified)',
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
    if (req.accessLevel === 'read-only') args.push('--sandbox');
    else args.push('--dangerously-skip-permissions');
    if (req.model) args.push('--model', req.model);
    if (req.resumeSessionId) args.push('--conversation', req.resumeSessionId);
    args.push(`--print=${req.prompt}`);
    return { file: 'agy', args, env: { ...process.env, ...req.profileEnv }, stdinText: null, files: [] };
  },

  parse(events: unknown[]): ParsedRun {
    let sessionId: string | null = null;
    let finalText: string | null = null;
    let errorText: string | null = null;
    for (const raw of events) {
      const e = obj(raw);
      if (!e) continue;
      for (const k of ['session_id', 'conversation_id', 'conversationId']) {
        if (!sessionId && typeof e[k] === 'string') sessionId = e[k] as string;
      }
      if (e.type === 'result' && typeof e.result === 'string') finalText = e.result;
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
    return { sessionId, finalText, errorText };
  },

  classifyFailure: classifyCommon,
  loginStatusArgs: null,
  loginInstructions() {
    return tr(
      '터미널에서 agy 를 한 번 실행해 로그인하세요(헤드리스 실행은 캐시된 로그인만 사용합니다).',
      'Run agy once in a terminal to log in (headless runs use cached login only).',
    );
  },
};

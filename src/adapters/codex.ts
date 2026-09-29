// Codex CLI 어댑터 (exec 경로).
// 실측(2026-09-28, 0.153.4): exec --json, stdin 프롬프트('-'), thread.started.thread_id, exec resume <id>, 한글 정상.
// 실행 중 권한 중계는 app-server(JSON-RPC)가 필요하다: 0.153.4에서 명령·파일 변경 승인 중계를 실측했다(2026-09-29).
// 그래서 읽기 전용·전체 자동은 exec, 승인 중계가 필요한 등급(2·3)은 codex-relay(app-server) 경로를 쓴다.
import { tr } from '../core/i18n.ts';

import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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

function relayScript(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const ts = path.join(here, 'codex-relay.ts');
  return existsSync(ts) ? ts : path.join(here, 'codex-relay.js');
}

export const codexAdapter: CliAdapter = {
  kind: 'codex',
  displayName: 'Codex',
  executable: 'codex',
  capabilities: {
    accessLevels: ['read-only', 'write-ask', 'write-allowlist', 'full-auto'],
    permissionRelay: true,
    resume: true,
    profileEnvVar: 'CODEX_HOME',
    get notes() {
      return [
        tr(
          '실측(Windows, 0.159): exec 모드는 읽기 전용·전체 자동에서 셸 명령을 모두 거절 → 모든 등급을 app-server 중계로 실행',
          'Measured (Windows, 0.159): exec mode rejects every shell command in read-only/full-auto → all levels run through the app-server relay',
        ),
        tr(
          '읽기 전용(검수 등): 읽기·검색·테스트 명령은 자동 허용, 파일 쓰기·git 변경·설치는 자동 거부',
          'Read-only (reviews): read/search/test commands auto-allowed; file writes, git changes and installs auto-denied',
        ),
        tr(
          '전체 자동: 치명적 명령(드라이브 삭제·포맷 등)만 막고 나머지 자동 허용. 등급 2·3은 대표(또는 위임자)에게 묻는다',
          'Full auto: blocks only catastrophic commands (drive wipes, formats…). Levels 2–3 ask the CEO (or the delegate)',
        ),
        tr(
          '허용 목록 자동 승인은 셸 메타문자(; & | $ < > 등)가 없는 명령만',
          'Allowlist auto-approval only accepts commands without shell metacharacters (; & | $ < > etc.)',
        ),
      ];
    },
  },

  // 실측(Windows, 0.159): `codex exec`는 approval_policy=never(읽기 전용·전체 자동)에서 모든 셸 명령을
  // "blocked by policy"로 거절해 검수자가 파일조차 읽지 못했다. 그래서 모든 등급을 app-server 중계기로 실행한다.
  // 읽기 전용·전체 자동의 승인 요청은 중계기가 가드로 자동 판단하고, 등급 2·3만 대표(또는 위임자)에게 올린다.
  buildInvocation(req: InvocationRequest): Invocation {
    const auto = req.accessLevel === 'read-only' ? 'commands' : req.accessLevel === 'full-auto' ? 'all' : 'none';
    return {
      file: process.execPath,
      args: ['--no-warnings', relayScript()],
      env: {
        ...process.env,
        ...req.profileEnv,
        AC_CODEX_CWD: req.cwd,
        AC_CODEX_POLICY: 'untrusted',
        AC_CODEX_SANDBOX: req.accessLevel === 'read-only' ? 'read-only' : 'workspace-write',
        AC_AUTO_APPROVE: auto,
        AC_APPROVAL_DIR: auto === 'none' ? (req.approvalDir ?? '') : '',
        AC_ALLOWED_COMMANDS: JSON.stringify(req.accessLevel === 'write-allowlist' ? req.allowedCommands : []),
        ...(req.resumeSessionId ? { AC_CODEX_RESUME: req.resumeSessionId } : {}),
        ...(req.model ? { AC_CODEX_MODEL: req.model } : {}),
        ...(req.effort ? { AC_CODEX_EFFORT: req.effort } : {}),
      },
      stdinText: req.prompt,
      files: [],
    };
  },

  parse(events: unknown[]): ParsedRun {
    let sessionId: string | null = null;
    let finalText: string | null = null;
    let errorText: string | null = null;
    let usage: TokenUsage | null = null;
    for (const raw of events) {
      const e = obj(raw);
      if (!e) continue;
      if (e.type === 'thread.started' && typeof e.thread_id === 'string') sessionId = e.thread_id;
      const item = obj(e.item);
      if (e.type === 'item.completed' && item?.type === 'agent_message' && typeof item.text === 'string') finalText = item.text;
      if (e.type === 'turn.failed' || e.type === 'error') {
        const err = obj(e.error);
        errorText = String(err?.message ?? e.message ?? 'error');
      }
      const u = e.type === 'turn.completed' ? obj(e.usage) : null;
      if (u) usage = addUsage(usage, usageFrom('codex', u));
    }
    return { sessionId, finalText, errorText, usage };
  },

  classifyFailure: classifyCommon,
  loginStatusArgs: ['login', 'status'],
  loginInstructions(profileDir) {
    return profileDir
      ? tr(
          `PowerShell에서 다음을 실행해 앱 전용 프로필로 로그인하세요:\n$env:CODEX_HOME='${profileDir}'; codex login`,
          `Run in PowerShell to log in with the app profile:\n$env:CODEX_HOME='${profileDir}'; codex login`,
        )
      : tr('터미널에서 codex login 을 실행하세요.', 'Run codex login in a terminal.');
  },
};

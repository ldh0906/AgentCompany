// Codex CLI 어댑터 (exec 경로).
// 실측(2026-09-28, 0.153.4): exec --json, stdin 프롬프트('-'), thread.started.thread_id, exec resume <id>, 한글 정상.
// 실행 중 권한 중계는 app-server(JSON-RPC)가 필요하다: 0.153.4에서 명령·파일 변경 승인 중계를 실측했다(2026-09-29).
// 그래서 읽기 전용·전체 자동은 exec, 승인 중계가 필요한 등급(2·3)은 codex-relay(app-server) 경로를 쓴다.
import { tr } from '../core/i18n.ts';

import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { classifyCommon, obj, type CliAdapter, type Invocation, type InvocationRequest, type ParsedRun } from './types.ts';

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
          '실측: exec --json, stdin 프롬프트, ID 재개, 한글 정상 (0.153.4)',
          'Verified: exec --json, stdin prompts, resume by ID, Korean text (0.153.4)',
        ),
        tr(
          '전체 자동은 workspace-write 샌드박스 안에서만 동작(네트워크 차단, 작업공간 밖 쓰기 차단)',
          'Full-auto runs only in the workspace-write sandbox (no network or writes outside the workspace)',
        ),
        tr(
          '실측: 등급 2·3은 app-server로 명령·파일 변경 승인을 중계(읽기 명령도 묻는다)',
          'Levels 2–3 use app-server relay (method names checked against local schema; subscription testing pending)',
        ),
        tr(
          '허용 목록 자동 승인은 셸 메타문자(; & | $ < > 등)가 없는 명령만',
          'Allowlist auto-approval only accepts commands without shell metacharacters (; & | $ < > etc.)',
        ),
      ];
    },
  },

  buildInvocation(req: InvocationRequest): Invocation {
    if ((req.accessLevel === 'write-ask' || req.accessLevel === 'write-allowlist') && !req.resumeSessionId) {
      return {
        file: process.execPath,
        args: ['--no-warnings', relayScript()],
        env: {
          ...process.env,
          ...req.profileEnv,
          AC_CODEX_CWD: req.cwd,
          AC_CODEX_POLICY: 'untrusted',
          AC_APPROVAL_DIR: req.approvalDir ?? '',
          AC_ALLOWED_COMMANDS: JSON.stringify(req.accessLevel === 'write-allowlist' ? req.allowedCommands : []),
          ...(req.model ? { AC_CODEX_MODEL: req.model } : {}),
        },
        stdinText: req.prompt,
        files: [],
      };
    }
    const model = req.model ? ['-m', req.model] : [];
    let args: string[];
    if (req.resumeSessionId) {
      args = ['exec', 'resume', req.resumeSessionId, '--json', '--skip-git-repo-check', ...model, '-'];
    } else {
      const sandbox = req.accessLevel === 'read-only' ? ['-s', 'read-only'] : ['-s', 'workspace-write', '-c', 'approval_policy="never"'];
      args = ['exec', '--json', '--skip-git-repo-check', ...sandbox, '-C', req.cwd, ...model, '-'];
    }
    return { file: 'codex', args, env: { ...process.env, ...req.profileEnv }, stdinText: req.prompt, files: [] };
  },

  parse(events: unknown[]): ParsedRun {
    let sessionId: string | null = null;
    let finalText: string | null = null;
    let errorText: string | null = null;
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
    }
    return { sessionId, finalText, errorText };
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

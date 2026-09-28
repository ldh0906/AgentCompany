// Codex CLI 어댑터 (exec 경로).
// 실측(2026-09-28, 0.153.4): exec --json, stdin 프롬프트('-'), thread.started.thread_id, exec resume <id>, 한글 정상.
// 실행 중 권한 중계는 app-server(JSON-RPC)가 필요하다: 메서드명은 로컬 generate-ts로 확인했으나 실사용 실측 전.
// 그래서 exec 경로는 읽기 전용과 '샌드박스 안 자동'만 제공한다.

import { classifyCommon, obj, type CliAdapter, type Invocation, type InvocationRequest, type ParsedRun } from './types.ts';

export const codexAdapter: CliAdapter = {
  kind: 'codex',
  displayName: 'Codex',
  executable: 'codex',
  capabilities: {
    accessLevels: ['read-only', 'full-auto'],
    permissionRelay: false,
    resume: true,
    profileEnvVar: 'CODEX_HOME',
    notes: [
      '실측: exec --json, stdin 프롬프트, ID 재개, 한글 정상 (0.153.4)',
      '전체 자동은 workspace-write 샌드박스 안에서만 동작(네트워크 차단, 작업공간 밖 쓰기 차단)',
      '권한 중계(app-server)는 다음 버전: 메서드명 확인됨, 실측 전',
    ],
  },

  buildInvocation(req: InvocationRequest): Invocation {
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
      ? `PowerShell에서 다음을 실행해 앱 전용 프로필로 로그인하세요:\n$env:CODEX_HOME='${profileDir}'; codex login`
      : '터미널에서 codex login 을 실행하세요.';
  },
};

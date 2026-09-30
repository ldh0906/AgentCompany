// Claude Code 어댑터.
// 실측(2026-09-28, 2.1.202): -p + stream-json + --verbose, stdin 프롬프트, session_id, --resume <id>, 한글 경로·긴 한글 출력 정상.
// --permission-prompt-tool 은 --help에 없는 숨김 옵션이지만, 2.1.202에서 권한 중계를 실측했다(2026-09-29).
import { tr } from '../core/i18n.ts';

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import type { AccessLevel } from '../core/types.ts';
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

const READ_TOOLS = ['Read', 'Glob', 'Grep'];
const WRITE_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];
const NETWORK_TOOLS = ['WebFetch', 'WebSearch'];
const APPROVER_SERVER = 'ac_approver';

export function approverScriptPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const ts = path.join(here, '..', 'approvals', 'mcp-approver.ts');
  return existsSync(ts) ? ts : path.join(here, '..', 'approvals', 'mcp-approver.js');
}

function permissionArgs(level: AccessLevel, allowedCommands: string[][], relay: boolean): string[] {
  switch (level) {
    case 'read-only':
      return ['--allowedTools', READ_TOOLS.join(','), '--disallowedTools', [...WRITE_TOOLS, 'Bash', ...NETWORK_TOOLS].join(',')];
    case 'write-ask':
    case 'write-allowlist': {
      const bash = level === 'write-allowlist' ? allowedCommands.map((argv) => `Bash(${argv.join(' ')}:*)`) : [];
      const args = ['--allowedTools', [...READ_TOOLS, ...WRITE_TOOLS, ...bash].join(','), '--disallowedTools', NETWORK_TOOLS.join(',')];
      if (relay) args.push('--permission-prompt-tool', `mcp__${APPROVER_SERVER}__approve`);
      return args;
    }
    case 'full-auto':
      return ['--permission-mode', 'bypassPermissions'];
  }
}

export const claudeAdapter: CliAdapter = {
  kind: 'claude',
  displayName: 'Claude Code',
  executable: 'claude',
  capabilities: {
    accessLevels: ['read-only', 'write-ask', 'write-allowlist', 'full-auto'],
    permissionRelay: true,
    resume: true,
    profileEnvVar: 'CLAUDE_CONFIG_DIR',
    get notes() {
      return [
        tr(
          '실측: headless stream-json, ID 재개, 한글 경로·출력 정상 (2.1.202)',
          'Verified: headless stream-json, resume by ID, Korean paths and output (2.1.202)',
        ),
        tr(
          '실측: --permission-prompt-tool 권한 중계 동작, 거부해도 실행 계속 (도움말에 없는 숨김 옵션)',
          'Verified: --permission-prompt-tool relay works; a denial does not stop the run (hidden option, absent from help)',
        ),
        tr(
          '저장소의 .claude 설정(훅 등)이 실행되지 않도록 --setting-sources user 사용',
          'Uses --setting-sources user to exclude repository .claude settings (including hooks)',
        ),
      ];
    },
  },

  buildInvocation(req: InvocationRequest): Invocation {
    const relay = Boolean(req.approvalDir) && (req.accessLevel === 'write-ask' || req.accessLevel === 'write-allowlist');
    const files: Invocation['files'] = [];
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--setting-sources', 'user', '--strict-mcp-config'];
    if (relay) {
      const configPath = path.join(req.runDir, 'mcp-config.json');
      files.push({
        path: configPath,
        content: JSON.stringify({
          mcpServers: {
            [APPROVER_SERVER]: {
              command: process.execPath,
              args: [approverScriptPath()],
              env: { AC_APPROVAL_DIR: req.approvalDir!, AC_APPROVAL_SOURCE: 'claude' },
            },
          },
        }),
      });
      args.push('--mcp-config', configPath);
    }
    args.push(...permissionArgs(req.accessLevel, req.allowedCommands, relay));
    if (req.model) args.push('--model', req.model);
    if (req.effort) args.push('--effort', req.effort); // 실측(2.1.202): low|medium|high|xhigh|max
    if (req.resumeSessionId) args.push('--resume', req.resumeSessionId);
    return { file: 'claude', args, env: { ...process.env, ...req.profileEnv }, stdinText: req.prompt, files };
  },

  parse(events: unknown[]): ParsedRun {
    let sessionId: string | null = null;
    let finalText: string | null = null;
    let errorText: string | null = null;
    let usage: TokenUsage | null = null;
    for (const raw of events) {
      const e = obj(raw);
      if (!e) continue;
      if (!sessionId && typeof e.session_id === 'string') sessionId = e.session_id;
      if (e.type === 'result') {
        if (typeof e.result === 'string') finalText = e.result;
        if (e.is_error === true) errorText = typeof e.result === 'string' ? e.result : String(e.subtype ?? 'error');
        const u = obj(e.usage);
        if (u) usage = addUsage(usage, usageFrom('claude', u, e.total_cost_usd));
      }
    }
    return { sessionId, finalText, errorText, usage };
  },

  classifyFailure: classifyCommon,
  loginStatusArgs: ['auth', 'status', '--json'],
  loginArgs: ['auth', 'login'],
  loginInstructions(profileDir) {
    return profileDir
      ? tr(
          `PowerShell에서 다음을 실행해 앱 전용 프로필로 로그인하세요:\n$env:CLAUDE_CONFIG_DIR='${profileDir}'; claude auth login`,
          `Run in PowerShell to log in with the app profile:\n$env:CLAUDE_CONFIG_DIR='${profileDir}'; claude auth login`,
        )
      : tr('터미널에서 claude auth login 을 실행하세요.', 'Run claude auth login in a terminal.');
  },
};

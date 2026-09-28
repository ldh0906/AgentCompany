import { tr } from '../core/i18n.ts';
// 가짜 직원 어댑터. model 값이 성격이 된다: diligent | lazy | rogue | slow

import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { claudeAdapter } from './claude.ts';
import { classifyCommon, type CliAdapter, type Invocation, type InvocationRequest } from './types.ts';

export const FAKE_BEHAVIORS = ['diligent', 'lazy', 'rogue', 'slow'] as const;

function fakeAgentScript(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const ts = path.join(here, 'fake-agent.ts');
  return existsSync(ts) ? ts : path.join(here, 'fake-agent.js');
}

export const fakeAdapter: CliAdapter = {
  kind: 'fake',
  get displayName() { return tr('데모 직원(가짜)', 'Demo employee (fake)'); },
  executable: process.execPath,
  capabilities: {
    accessLevels: ['read-only', 'write-ask', 'write-allowlist', 'full-auto'],
    permissionRelay: false,
    resume: true,
    profileEnvVar: null,
    get notes() { return [tr('구독 없이 흐름을 시연하는 가짜 직원입니다. 모델 값으로 성격을 고릅니다: diligent, lazy, rogue, slow', 'Fake employee for demos without a subscription. Choose behavior via model: diligent, lazy, rogue, slow')]; },
  },
  buildInvocation(req: InvocationRequest): Invocation {
    return {
      file: process.execPath,
      args: ['--no-warnings', fakeAgentScript()],
      env: { ...process.env, FAKE_BEHAVIOR: req.model ?? 'diligent', FAKE_RESUME_ID: req.resumeSessionId ?? '' },
      stdinText: req.prompt,
      files: [],
    };
  },
  parse: claudeAdapter.parse,
  classifyFailure: classifyCommon,
  loginStatusArgs: null,
  loginInstructions: () => tr('로그인이 필요 없습니다.', 'No login required.'),
};

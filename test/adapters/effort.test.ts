// 정확한 모델명과 effort 전달. 옵션은 실측(2026-09-29): claude --effort low|medium|high|xhigh|max,
// codex -c model_reasoning_effort=…, app-server turn/start.effort, agy는 모델 ID 끝에 -high/-medium/-low.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claudeAdapter } from '../../src/adapters/claude.ts';
import { codexAdapter } from '../../src/adapters/codex.ts';
import { agyAdapter } from '../../src/adapters/agy.ts';
import { parseAgyModels, parseCodexModels } from '../../src/app/models.ts';
import type { InvocationRequest } from '../../src/adapters/types.ts';

const base: InvocationRequest = {
  prompt: 'p',
  cwd: '.',
  model: null,
  accessLevel: 'read-only',
  allowedCommands: [],
  profileEnv: {},
  runDir: '.',
};
const seq = (args: string[], ...want: string[]) => args.some((_, i) => want.every((w, j) => args[i + j] === w));

test('Claude: 정확한 모델명과 --effort', () => {
  const inv = claudeAdapter.buildInvocation({ ...base, model: 'claude-opus-4-8', effort: 'xhigh' });
  assert.ok(seq(inv.args, '--model', 'claude-opus-4-8'));
  assert.ok(seq(inv.args, '--effort', 'xhigh'));
  assert.ok(!claudeAdapter.buildInvocation({ ...base, model: 'claude-sonnet-5' }).args.includes('--effort'), 'effort가 없으면 CLI 기본값');
});

test('Codex: 모든 등급이 중계기로 실행되고, 읽기 전용·전체 자동은 자동 판단, 이어서 하기는 thread 재개', () => {
  const ro = codexAdapter.buildInvocation({ ...base, approvalDir: 'q', model: 'gpt-6-astra', effort: 'high' });
  assert.equal(ro.file, process.execPath);
  assert.equal(ro.env.AC_CODEX_SANDBOX, 'read-only');
  assert.equal(ro.env.AC_AUTO_APPROVE, 'commands');
  assert.equal(ro.env.AC_APPROVAL_DIR, '', '읽기 전용 실행은 대표에게 묻지 않는다');
  assert.equal(ro.env.AC_CODEX_EFFORT, 'high');
  const full = codexAdapter.buildInvocation({ ...base, accessLevel: 'full-auto', resumeSessionId: 'th-1' });
  assert.equal(full.env.AC_AUTO_APPROVE, 'all');
  assert.equal(full.env.AC_CODEX_SANDBOX, 'workspace-write');
  assert.equal(full.env.AC_CODEX_RESUME, 'th-1');
  const ask = codexAdapter.buildInvocation({ ...base, accessLevel: 'write-ask', approvalDir: 'q' });
  assert.equal(ask.env.AC_AUTO_APPROVE, 'none');
  assert.equal(ask.env.AC_APPROVAL_DIR, 'q');
});

test('Codex 중계(등급 2): 모델과 effort를 환경변수로 중계기에 전달', () => {
  const inv = codexAdapter.buildInvocation({ ...base, accessLevel: 'write-ask', model: 'gpt-6-astra', effort: 'medium' });
  assert.equal(inv.env.AC_CODEX_MODEL, 'gpt-6-astra');
  assert.equal(inv.env.AC_CODEX_EFFORT, 'medium');
});

test('agy: 모델 계열 + effort → 실제 모델 ID', () => {
  const inv = agyAdapter.buildInvocation({ ...base, model: 'gemini-3.8-flash', effort: 'high' });
  assert.ok(seq(inv.args, '--model', 'gemini-3.8-flash-high'));
  const plain = agyAdapter.buildInvocation({ ...base, model: 'gpt-oss-120b-medium' });
  assert.ok(seq(plain.args, '--model', 'gpt-oss-120b-medium'));
});

test('모델 목록: Codex는 모델별 effort 목록과 기본값을 함께', () => {
  const out = JSON.stringify({
    models: [
      {
        slug: 'gpt-6-astra',
        display_name: 'GPT-6-Astra',
        visibility: 'list',
        default_reasoning_level: 'medium',
        supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }],
      },
    ],
  });
  assert.deepEqual(parseCodexModels(out)[0], {
    id: 'gpt-6-astra',
    label: 'GPT-6-Astra',
    efforts: ['low', 'medium', 'high'],
    defaultEffort: 'medium',
  });
});

test('모델 목록: agy는 -high/-medium/-low 변형을 한 계열로 묶는다', () => {
  const out = [
    'Fetching available models...',
    'gemini-3.8-flash-high\tGemini 3.8 Flash (High)',
    'gemini-3.8-flash-low\tGemini 3.8 Flash (Low)',
    'gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)',
    'claude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)',
  ].join('\n');
  assert.deepEqual(parseAgyModels(out), [
    {
      id: 'gemini-3.8-flash',
      label: 'Gemini 3.8 Flash',
      efforts: ['low', 'medium', 'high'],
      defaultEffort: 'medium',
      effortRequired: true,
    },
    { id: 'claude-opus-4-6-thinking', label: 'Claude Opus 4.6 (Thinking)' },
  ]);
});

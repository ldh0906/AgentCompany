// 설치된 CLI가 지원하지 않는 모델: 목록에서 잠그고, 실행하면 재시도하지 않고 대표에게.
// 실측(2026-09-29): Claude Code 2.1.202에 --model claude-opus-5-5 →
// "API Error: 400 Claude Code 2.1.202 does not support this model; version 2.1.280 or newer is required."
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyCommon } from '../../src/adapters/types.ts';
import { annotateClaudeModels, claudeDefaultModel, CLAUDE_MODELS } from '../../src/app/models.ts';

const MSG =
  "API Error: 400 Claude Code 2.1.202 does not support this model; version 2.1.280 or newer is required. Run 'claude update', or update the Claude desktop app, then try again.";

test('지원하지 않는 모델 오류는 model_unsupported(재시도 대상 아님)', () => {
  assert.equal(classifyCommon({ exitCode: 1, timedOut: false, stderr: '', finalText: MSG }), 'model_unsupported');
  const missing = "There's an issue with the selected model (claude-3-7-sonnet-latest). It may not exist or you may not have access to it.";
  assert.equal(classifyCommon({ exitCode: 1, timedOut: false, stderr: '', finalText: missing }), 'model_unsupported');
});

test('Claude 모델 목록: Opus 5.5는 2.1.280 미만에서 잠김, 이상에서 열림', () => {
  assert.ok(CLAUDE_MODELS.some((m) => m.id === 'claude-opus-5-5'));
  const old = annotateClaudeModels('2.1.202 (Claude Code)');
  const o55 = old.find((m) => m.id === 'claude-opus-5-5')!;
  assert.match(o55.unavailable ?? '', /2\.1\.280/);
  assert.equal(old.find((m) => m.id === 'claude-opus-4-8')!.unavailable, undefined);
  const fresh = annotateClaudeModels('2.1.281 (Claude Code)');
  assert.equal(fresh.find((m) => m.id === 'claude-opus-5-5')!.unavailable, undefined);
  assert.equal(annotateClaudeModels(null).find((m) => m.id === 'claude-opus-5-5')!.unavailable, undefined, '버전을 모르면 막지 않는다');
});

test('Claude CLI 기본 모델: 2.1.280 이상은 Opus 5.5, 그 전은 Opus 4.8(1M)', () => {
  assert.equal(claudeDefaultModel('2.1.284 (Claude Code)'), 'claude-opus-5-5');
  assert.equal(claudeDefaultModel('2.1.202 (Claude Code)'), 'claude-opus-4-8[1m]');
  assert.equal(claudeDefaultModel(null), undefined);
  assert.ok(CLAUDE_MODELS.some((m) => m.id === 'claude-sonnet-5-5'));
});

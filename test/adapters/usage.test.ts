// 토큰 사용량 해석. 형식은 실측(2026-09-29): Claude 2.1.202, Codex 0.153.4, agy 1.2.12.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claudeAdapter } from '../../src/adapters/claude.ts';
import { codexAdapter } from '../../src/adapters/codex.ts';
import { agyAdapter } from '../../src/adapters/agy.ts';

test('Claude: result.usage(캐시 생성·읽기 포함) + total_cost_usd', () => {
  const r = claudeAdapter.parse([
    { type: 'system', subtype: 'init', session_id: 's1' },
    {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'OK',
      session_id: 's1',
      total_cost_usd: 0.065423,
      usage: { input_tokens: 10, cache_creation_input_tokens: 32604, cache_read_input_tokens: 5, output_tokens: 41 },
    },
  ]);
  assert.deepEqual(r.usage, { input: 32619, cacheRead: 5, output: 41, total: 32660, costUsd: 0.065423 });
});

test('Codex exec: turn.completed.usage (여러 턴이면 합산)', () => {
  const turn = {
    type: 'turn.completed',
    usage: { input_tokens: 15003, cached_input_tokens: 7168, cache_write_input_tokens: 0, output_tokens: 5, reasoning_output_tokens: 0 },
  };
  const r = codexAdapter.parse([{ type: 'thread.started', thread_id: 't' }, turn, turn]);
  assert.deepEqual(r.usage, { input: 30006, cacheRead: 14336, output: 10, total: 30016, costUsd: null });
});

test('agy: result.usage', () => {
  const r = agyAdapter.parse([
    {
      event: 'result',
      result: {
        conversation_id: 'c',
        status: 'SUCCESS',
        response: 'ok',
        usage: { input_tokens: 172110, output_tokens: 5571, thinking_tokens: 3101, cache_read_tokens: 72922, total_tokens: 177681 },
      },
    },
  ]);
  assert.deepEqual(r.usage, { input: 172110, cacheRead: 72922, output: 5571, total: 177681, costUsd: null });
});

test('사용량이 없으면 null', () => {
  assert.equal(claudeAdapter.parse([{ type: 'result', result: 'x' }]).usage, null);
  assert.equal(codexAdapter.parse([]).usage, null);
  assert.equal(agyAdapter.parse([]).usage, null);
});

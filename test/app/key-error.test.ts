// 실패한 검사 출력의 핵심 오류 줄(실측 2026-10-03, 4777의 playwright 실패 출력).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keyErrorLines } from '../../src/app/verify-setup.ts';

test('핵심 오류 줄: 스택 줄은 빼고 원인을 말하는 줄만', () => {
  const out = [
    'node:internal/modules/cjs/loader:1423',
    '  throw err;',
    '  ^',
    '',
    "Error: Cannot find module 'playwright'",
    'Require stack:',
    '- C:\\Users\\user\\AgentCompany\\projects\\P-1\\verify\\T-4\\research\\game-ui-skill\\inspect-ui.cjs',
    '    at Module._resolveFilename (node:internal/modules/cjs/loader:1420:15)',
    "  code: 'MODULE_NOT_FOUND',",
    'Node.js v25.1.0',
  ].join('\n');
  assert.deepEqual(keyErrorLines(out), ["Error: Cannot find module 'playwright'"]);
  assert.deepEqual(keyErrorLines('all good\n'), []);
  assert.deepEqual(keyErrorLines('not ok 3 - 저장 후 다시 열기\n# fail 1\n'), ['not ok 3 - 저장 후 다시 열기', '# fail 1']);
});

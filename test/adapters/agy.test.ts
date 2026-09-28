// agy 1.2.12 실측 출력(2026-09-29, --output-format stream-json) 형태로 파서를 검증한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agyAdapter } from '../../src/adapters/agy.ts';

const CONV = '4d088175-cd0e-4a3f-8399-fd6f4d0f1572';

test('agy: 실측 stream-json에서 세션 ID와 최종 응답을 읽음', () => {
  const events = [
    { event: 'init', conversation_id: CONV, init: { cwd: 'C:\\wt\\T-1', permission_mode: 'always-proceed' } },
    {
      event: 'step_update',
      step_update: { conversation_id: CONV, step_index: 29, state: 'ACTIVE', step_type: 'agent_response', text_delta: '[]}\n```' },
    },
    {
      event: 'result',
      result: {
        conversation_id: CONV,
        status: 'SUCCESS',
        response: 'Done.\n\n```json\n{"nonce":"n1","status":"done"}\n```\n',
        num_turns: 1,
      },
    },
  ];
  const r = agyAdapter.parse(events);
  assert.equal(r.sessionId, CONV);
  assert.match(r.finalText ?? '', /"nonce":"n1"/);
  assert.equal(r.errorText, null);
});

test('agy: 성공이 아닌 결과는 오류로 보고', () => {
  const r = agyAdapter.parse([{ event: 'result', result: { conversation_id: CONV, status: 'ERROR', response: '' } }]);
  assert.equal(r.finalText, null);
  assert.match(r.errorText ?? '', /ERROR/);
});

test('agy: 헤드리스에서 도구 권한이 자동 거부되면 빈 SUCCESS → 최종 응답 없음', () => {
  const r = agyAdapter.parse([{ event: 'result', result: { conversation_id: CONV, status: 'SUCCESS', response: '' } }]);
  assert.equal(r.finalText, null);
  assert.match(r.errorText ?? '', /empty response/);
});

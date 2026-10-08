// 실행 상태 판정: 무엇을 기다리는지·어디에 걸렸는지(OpenRig 비교 2026-10-08)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyRun, openCall, STUCK_KINDS, type RunObservation } from '../../src/app/run-state.ts';

const MIN = 60_000;
const base: RunObservation = {
  now: 100 * MIN,
  startedAt: 0,
  lastOutputAt: 99 * MIN,
  alive: true,
  waitingCeo: null,
  waitingColleague: null,
  openCall: null,
  quietLimitMs: 10 * MIN,
};

test('최근 출력이 있으면 일하는 중', () => {
  assert.deepEqual(classifyRun(base), { kind: 'working', quietMs: MIN, detail: '' });
});

test('대표 허락·동료 답을 기다리면 오래 조용해도 멈춘 것으로 보지 않는다', () => {
  const quiet = { ...base, lastOutputAt: 50 * MIN };
  const ceo = classifyRun({ ...quiet, waitingCeo: 'T-1: permission requested for command' });
  assert.equal(ceo.kind, 'waiting_ceo');
  assert.equal(classifyRun({ ...quiet, waitingColleague: 'QA 직원' }).detail, 'QA 직원');
  assert.ok(!STUCK_KINDS.includes(ceo.kind));
});

test('조용한데 끝나지 않은 명령이 있으면 그 명령을, 없으면 그냥 조용함', () => {
  const quiet = { ...base, lastOutputAt: 80 * MIN };
  assert.deepEqual(classifyRun({ ...quiet, openCall: 'npm run dev' }), {
    kind: 'running_command',
    quietMs: 20 * MIN,
    detail: 'npm run dev',
  });
  assert.equal(classifyRun(quiet).kind, 'quiet');
  // 출력이 한 번도 없으면 시작 시각부터 센다
  assert.equal(classifyRun({ ...quiet, lastOutputAt: null, startedAt: 95 * MIN }).kind, 'working');
});

test('조용한 채 실행 프로세스가 사라졌으면 다른 근거보다 먼저 "알 수 없음"', () => {
  const quiet = { ...base, lastOutputAt: 80 * MIN };
  assert.equal(classifyRun({ ...quiet, alive: false, waitingCeo: 'x' }).kind, 'unknown');
  assert.equal(classifyRun({ ...base, alive: false }).kind, 'working', '막 끝난 실행(결과 수거 직전)은 알리지 않는다');
  assert.equal(classifyRun({ ...base, alive: null }).kind, 'working', '확인할 수 없으면 근거로 쓰지 않는다');
});

test('끝나지 않은 도구 호출: Claude는 tool_use ↔ tool_result, Codex 중계기는 item.started ↔ item.completed', () => {
  const claude = [
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'a', name: 'Bash', input: { command: 'npm test' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a', content: 'ok' }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'b', name: 'Bash', input: { command: 'npm run  dev\n' } }] } },
  ];
  assert.equal(openCall(claude), 'npm run dev');
  assert.equal(openCall(claude.slice(0, 2)), null);
  const codex = [
    { type: 'item.started', item: { id: 'c1', type: 'command_execution', command: 'pytest' } },
    { type: 'item.completed', item: { id: 'c1', type: 'command_execution', command: 'pytest', exit_code: 0 } },
    { type: 'item.started', item: { id: 'c2', type: 'command_execution', command: 'python server.py' } },
    { type: 'heartbeat', what: 'thinking' },
  ];
  assert.equal(openCall(codex), 'python server.py');
  assert.equal(openCall([...codex, { type: 'turn.completed' }]), null, '턴이 끝나면 열린 호출은 없다');
});

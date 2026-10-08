// aco ps의 재시작 복구 요약: 이어받은 것·끊긴 것을 대표가 한눈에 본다
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recoveryLines, runStateNote } from '../../src/cli/view.ts';

const employees = [{ id: 'E1', name: '구현 직원' }] as never;

test('이어받을 것이 없었고 감사 로그도 정상이면 아무것도 보이지 않는다', () => {
  assert.deepEqual(recoveryLines({ employees, recovery: null }), []);
  const quiet = {
    chainOk: true,
    chainDetail: '',
    reattached: [],
    ingestedAfterRestart: [],
    orphaned: [],
    runs: [],
    integrations: [],
    toolCalls: 0,
  };
  assert.deepEqual(recoveryLines({ employees, recovery: quiet }), []);
});

test('요약 한 줄 + 이어받지 못한 실행과 끊긴 반영은 근거와 함께', () => {
  const lines = recoveryLines({
    employees,
    recovery: {
      chainOk: true,
      chainDetail: '',
      reattached: ['R1'],
      ingestedAfterRestart: ['R2'],
      orphaned: [],
      runs: [
        { runId: 'R1', ticketId: 'T-1', employeeId: 'E1', kind: 'work', action: 'reattached', reason: '살아 있음', status: 'running' },
        {
          runId: 'R2',
          ticketId: 'T-2',
          employeeId: 'E1',
          kind: 'review',
          action: 'collected',
          reason: '종료 기록 있음',
          status: 'succeeded',
        },
      ],
      integrations: [{ requestId: 'Q-1', approvalId: 'A-1', action: 'resume', since: '' }],
      toolCalls: 1,
    },
  });
  assert.match(lines[0]!, /이어받음 1 · 결과 수거 1 · 끊긴 반영 1 · 끊긴 도구 요청 1/);
  assert.equal(lines.length, 3, '이어받은 실행은 요약에만');
  assert.match(lines[1]!, /T-2 구현 직원\(검수\) → succeeded: 종료 기록 있음/);
  assert.match(lines[2]!, /Q-1 반영 이어서 진행/);
});

test('실행 상태 메모: 일하는 중이면 비우고, 기다리거나 걸린 것은 무엇인지', () => {
  assert.equal(runStateNote({ kind: 'working', quietMs: 0, detail: '' }), '');
  assert.equal(runStateNote({ kind: 'waiting_colleague', quietMs: 0, detail: 'QA 직원' }), '⏳ QA 직원의 답 기다림');
  assert.equal(
    runStateNote({ kind: 'running_command', quietMs: 12 * 60_000, detail: 'npm run dev' }),
    '⚠ 명령이 12분째 안 끝남: npm run dev',
  );
});

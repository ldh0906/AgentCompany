// 작업 중간 보고 요약(대표 요청 2026-10-03).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { progressLine } from '../../src/app/progress.ts';
import type { ActivityItem } from '../../src/app/activity.ts';

test('중간 보고: 직원이 남긴 마지막 말 + 고친 파일 + 명령 수, 한 일이 없으면 null', () => {
  const items: ActivityItem[] = [
    { kind: 'say', text: '먼저 저장 구조를 읽겠습니다.' },
    { kind: 'tool', text: 'Read: C:\\w\\src\\save.ts' },
    { kind: 'tool', text: 'Edit: C:\\w\\src\\save.ts' },
    { kind: 'file', text: 'update C:\\w\\src\\ui\\list.ts, add tests/save.test.ts' },
    { kind: 'tool', text: 'Bash: node --test' },
    { kind: 'command', text: 'npm test' },
    { kind: 'say', text: '이제 오답 노트 화면을 연결하고 있습니다.' },
  ];
  const line = progressLine(items, 12)!;
  assert.match(line, /12분째/);
  assert.match(line, /이제 오답 노트 화면을 연결하고 있습니다/);
  assert.match(line, /고친 파일 3개: src\/save\.ts, ui\/list\.ts, tests\/save\.test\.ts/);
  assert.match(line, /명령 2번/);
  assert.equal(progressLine([], 5), null);
  assert.equal(progressLine([{ kind: 'think', text: '...' }], 5), null, '생각만 했으면 올리지 않는다');
});

// 비서실장 초안의 난이도: 제안값을 읽되, 모르는 값은 "보통"으로.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDrafts } from '../../src/agents/report.ts';

const text = (tickets: unknown[]) =>
  'drafts\n```json\n' + JSON.stringify({ nonce: 'n', kind: 'drafts', summary: 's', tickets, questions: [] }) + '\n```';
const draft = (difficulty?: unknown) => ({
  type: 'impl',
  title: 't',
  purpose: 'p',
  requirements: [{ text: 'r', evidenceType: 'unit_test' }],
  doneCriteria: 'd',
  writeScope: ['src/**'],
  dependsOn: [],
  ...(difficulty === undefined ? {} : { difficulty }),
});

test('초안 난이도: easy/normal/hard를 읽고, 없거나 모르는 값은 normal', () => {
  const r = parseDrafts(text([draft('hard'), draft('easy'), draft(), draft('extreme')]), 'n');
  assert.ok(r.ok);
  assert.deepEqual(r.ok && r.report.tickets.map((x) => x.difficulty), ['hard', 'easy', 'normal', 'normal']);
});

test('공유 계약: 첫 초안의 contract만 받는다(뒤 초안·조사 업무의 contract는 무시)', () => {
  const r = parseDrafts(
    text([
      { ...draft(), contract: true },
      { ...draft(), contract: true },
    ]),
    'n',
  );
  assert.ok(r.ok);
  assert.deepEqual(r.ok && r.report.tickets.map((x) => Boolean(x.contract)), [true, false]);
  const research = parseDrafts(text([{ ...draft(), type: 'research', contract: true }]), 'n');
  assert.equal(research.ok && research.report.tickets[0]!.contract, undefined);
});

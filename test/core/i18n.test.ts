import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getLanguage, setLanguage, tr } from '../../src/core/i18n.ts';
import { applyTicketCommand } from '../../src/core/ticket-machine.ts';
import { DEFAULT_BUDGET, type Ticket } from '../../src/core/types.ts';
import { ADAPTERS } from '../../src/adapters/index.ts';

test('assignment rejection follows language changes and restores Korean', () => {
  const now = '2026-09-28T00:00:00.000Z';
  const ticket: Ticket = {
    id: 'T-1',
    projectId: 'P-1',
    type: 'impl',
    title: 'Test',
    purpose: 'Test',
    requesterId: 'ceo',
    assigneeId: null,
    reviewerId: null,
    priority: 2,
    status: 'backlog',
    hold: null,
    writeScope: ['src/**'],
    readScope: ['**'],
    requirements: [{ id: 'R1', text: 'Test', evidenceType: 'unit_test' }],
    doneCriteria: 'Tests pass',
    round: 1,
    runCount: 0,
    budget: DEFAULT_BUDGET,
    dependsOn: [],
    createdAt: now,
    updatedAt: now,
  };
  try {
    for (const [language, expected] of [
      ['en', 'Assignee and reviewer must be different employees.'],
      ['ko', '담당자와 검수자는 같은 직원일 수 없습니다.'],
    ] as const) {
      setLanguage(language);
      assert.equal(getLanguage(), language);
      const result = applyTicketCommand(
        ticket,
        {
          type: 'assign',
          assigneeId: 'e-1',
          reviewerId: 'e-1',
          activeEmployeeIds: ['e-1'],
        },
        { kind: 'orchestrator' },
        now,
      );
      assert.equal(result.ok, false);
      if (result.ok) assert.fail('Assignment should be rejected');
      assert.equal(result.error, expected);
    }
  } finally {
    setLanguage('ko');
  }
});

test('adapter descriptions use the language selected after module import', () => {
  try {
    setLanguage('en');
    assert.equal(tr('한국어', 'English'), 'English');
    assert.equal(ADAPTERS.fake.displayName, 'Demo employee (fake)');
    for (const adapter of Object.values(ADAPTERS)) {
      assert.doesNotMatch(adapter.capabilities.notes.join('\n'), /[가-힣]/);
      assert.doesNotMatch(adapter.loginInstructions(null), /[가-힣]/);
      assert.doesNotMatch(adapter.loginInstructions('app-profile'), /[가-힣]/);
    }
    setLanguage('ko');
    assert.equal(ADAPTERS.fake.displayName, '데모 직원(가짜)');
    for (const adapter of Object.values(ADAPTERS)) {
      assert.match(adapter.capabilities.notes.join('\n'), /[가-힣]/);
      assert.match(adapter.loginInstructions(null), /[가-힣]/);
    }
  } finally {
    setLanguage('ko');
  }
});

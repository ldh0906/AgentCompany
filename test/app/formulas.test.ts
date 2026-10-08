// 작업 흐름(formula): 비서실장 초안이 단계를 지키는지 검사하고, 단계의 필수 요구사항·순서를 입힌다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyFormula, builtInFormulas, checkFormulaDrafts, formulaByName, parseFormula } from '../../src/app/formulas.ts';
import type { TicketDraft } from '../../src/agents/report.ts';

const draft = (over: Partial<TicketDraft> = {}): TicketDraft => ({
  type: 'impl',
  title: 't',
  purpose: 'p',
  requirements: [{ text: '내 요구사항', evidenceType: 'inspection' }],
  doneCriteria: 'd',
  writeScope: ['src/**'],
  dependsOn: [],
  difficulty: 'normal',
  ...over,
});

test('내장 흐름: 기능 추가·버그 수정·리팩터링', () => {
  assert.deepEqual(
    builtInFormulas().map((f) => f.name),
    ['bugfix', 'feature', 'refactor'],
  );
  assert.deepEqual(
    formulaByName('refactor')!.steps.map((s) => s.key),
    ['pin', 'reshape'],
  );
});

test('단계 검사: 모두 있고 순서대로면 통과, 빠짐·순서·모르는 단계·단계 없음은 거부(맨 앞 계약 업무만 예외)', () => {
  const f = formulaByName('refactor')!;
  assert.equal(checkFormulaDrafts(f, [{ step: 'pin' }, { step: 'reshape' }]), null);
  assert.equal(checkFormulaDrafts(f, [{ step: 'pin' }, { step: 'pin' }, { step: 'reshape' }]), null, '한 단계에 여러 업무');
  assert.equal(checkFormulaDrafts(f, [{ contract: true }, { step: 'pin' }, { step: 'reshape' }]), null, '맨 앞 공유 계약');
  assert.match(checkFormulaDrafts(f, [{ step: 'pin' }])!, /빠진 단계: 구조 개선/);
  assert.match(checkFormulaDrafts(f, [{ step: 'reshape' }, { step: 'pin' }])!, /앞에 있습니다/);
  assert.match(checkFormulaDrafts(f, [{ step: 'pin' }, { step: 'deploy' }])!, /이 흐름에 없습니다/);
  assert.match(checkFormulaDrafts(f, [{ step: 'pin' }, {}])!, /단계\(step\)가 없습니다/);
});

test('흐름 입히기: 필수 요구사항을 앞에 넣고(중복 없이), 앞 단계 업무 모두에 의존하며, 못 만드는 증거는 검수 판단으로', () => {
  const f = formulaByName('refactor')!;
  const out = applyFormula(
    f,
    [draft({ step: 'pin' }), draft({ step: 'pin', title: 'b' }), draft({ step: 'reshape' })],
    new Set(['unit_test']),
  );
  assert.deepEqual(out[2]!.dependsOn, [0, 1]);
  assert.deepEqual(out[0]!.dependsOn, []);
  assert.equal(out[2]!.requirements.length, 3);
  assert.equal(out[2]!.requirements[0]!.evidenceType, 'unit_test');
  assert.equal(out[2]!.requirements.at(-1)!.text, '내 요구사항');
  // 이미 같은 요구사항이 있으면 다시 넣지 않는다
  const again = applyFormula(f, out, new Set(['unit_test']));
  assert.equal(again[2]!.requirements.length, 3);
  // 단위 테스트 검사 명령이 없는 프로젝트: 영영 멈추지 않게 검수자 판단으로
  const noTests = applyFormula(f, [draft({ step: 'pin' })], new Set());
  assert.equal(noTests[0]!.requirements[0]!.evidenceType, 'inspection');
});

test('흐름 파일 검사: 이름 형식·단계 key·증거 종류', () => {
  assert.throws(() => parseFormula('name: Bad Name\nsteps:\n  - key: a\n', 'x.yaml'), /name/);
  assert.throws(
    () => parseFormula('name: ok\nsteps:\n  - key: a\n    requirements:\n      - text: t\n        evidence: vibes\n', 'x.yaml'),
    /evidence/,
  );
  assert.throws(() => parseFormula('name: ok\nsteps:\n  - key: a\n  - key: a\n', 'x.yaml'), /같은 key/);
});

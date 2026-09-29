// 화면에서 쓰지 못하던 기능 연결: 허용 목록, 직원 정보 수정, 프로젝트 삭제, 작업 지시의 책임자.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWorkPrompt } from '../../src/agents/prompt.ts';
import { newImplTicket, setup } from './helpers.ts';

test('등급 3: 허용 목록을 함께 저장하고, 셸 연결 문자가 든 명령은 거부', { timeout: 30_000 }, async (t) => {
  const env = await setup(t);
  const [impl] = env.company.employees();
  const e = env.company.setAccessLevel(impl!.id, 'write-allowlist', { kind: 'ceo' }, [
    ['npm', 'test'],
    ['git', 'status'],
  ]);
  assert.equal(e.accessLevel, 'write-allowlist');
  assert.deepEqual(e.allowedCommands, [
    ['npm', 'test'],
    ['git', 'status'],
  ]);
  assert.throws(
    () => env.company.setAccessLevel(impl!.id, 'write-allowlist', { kind: 'ceo' }, [['npm', 'test;', 'rm']]),
    /허용 목록|allowlist/i,
  );
  // 목록을 주지 않으면 기존 목록 유지
  assert.deepEqual(env.company.setAccessLevel(impl!.id, 'write-allowlist', { kind: 'ceo' }).allowedCommands.length, 2);
});

test('직원 이름·담당 업무 수정', { timeout: 30_000 }, async (t) => {
  const env = await setup(t);
  const [impl] = env.company.employees();
  const e = env.company.updateEmployeeProfile(impl!.id, { name: '  새 이름 ', roles: ['implementer', 'qa'] });
  assert.equal(e.name, '새 이름');
  assert.deepEqual(e.roles, ['implementer', 'qa']);
  assert.throws(() => env.company.updateEmployeeProfile(impl!.id, { roles: [] }), /담당 업무|duty/i);
  assert.throws(() => env.company.updateEmployeeProfile(impl!.id, { name: ' ' }), /이름|name/i);
});

test('프로젝트 삭제: 진행 중인 업무가 있으면 거부, 없으면 목록에서 빠지고 새 업무를 받지 않음', { timeout: 60_000 }, async (t) => {
  const env = await setup(t);
  const tk = newImplTicket(env);
  assert.throws(() => env.company.removeProject(env.projectId), new RegExp(tk.id));
  env.orch.cancel(tk.id, 'x');
  const p = env.company.removeProject(env.projectId);
  assert.ok(p.removedAt);
  assert.throws(() => newImplTicket(env), /삭제|removed/i);
});

test('작업 지시에 책임자(맡긴 사람)를 적는다', { timeout: 30_000 }, async (t) => {
  const env = await setup(t);
  const [impl, qa] = env.company.employees();
  const tk = { ...newImplTicket(env), ownerId: qa!.id };
  const prompt = buildWorkPrompt({
    employee: impl!,
    owner: qa!,
    project: env.company.requireProject(env.projectId),
    ticket: tk,
    nonce: 'n',
    decisions: [],
    feedback: null,
    language: 'ko',
  });
  assert.match(prompt, new RegExp(`assigned to you by "${qa!.name}"`));
});

test('우선순위: 쓰기 범위가 겹치면 우선순위 높은 업무가 먼저 시작', { timeout: 60_000 }, async (t) => {
  const env = await setup(t);
  const base = {
    projectId: env.projectId,
    type: 'impl' as const,
    purpose: 'p',
    requirements: [{ text: 'r', evidenceType: 'unit_test' as const }],
    doneCriteria: 'd',
    writeScope: ['src/**'],
  };
  const low = env.company.createTicket({ ...base, title: '낮음', priority: 3 });
  const high = env.company.createTicket({ ...base, title: '높음', priority: 1 });
  for (let i = 0; i < 6; i++) await env.orch.tick();
  assert.equal(env.company.requireTicket(high.id).status, 'in_progress', '먼저 만든 낮은 우선순위보다 먼저');
  assert.notEqual(env.company.requireTicket(low.id).status, 'in_progress');
  await env.orch.idle();
});

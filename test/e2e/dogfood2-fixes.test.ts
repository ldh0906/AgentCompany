// 실사용 점검 2차(2026-09-30, 토이 프로젝트 2개)에서 찾은 문제들의 회귀 테스트.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDrafts } from '../../src/agents/report.ts';
import { buildDraftPrompt, buildReviewPrompt } from '../../src/agents/prompt.ts';
import { dependencySetup } from '../../src/app/verify-setup.ts';
import { applyTicketCommand } from '../../src/core/ticket-machine.ts';
import { EVIDENCE_STRENGTH } from '../../src/core/types.ts';
import { driveUntil, newImplTicket, setup } from './helpers.ts';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('비서실장 초안: 질문마다 제안 답, 프로젝트에 없는 검증 명령 제안(셸 연결 문자는 거부)', () => {
  const json = {
    nonce: 'n',
    kind: 'drafts',
    summary: 's',
    tickets: [{ type: 'impl', title: 't', requirements: [{ text: 'r', evidenceType: 'static_check' }], writeScope: ['src/**'] }],
    questions: ['옛 형식 질문', { question: '격자 크기?', proposal: '20×20' }],
    verifySuggestions: [
      { label: 'typecheck', command: 'npx tsc --noEmit', evidenceType: 'static_check' },
      { label: 'evil', command: 'npm test && rm -rf /', evidenceType: 'unit_test' },
    ],
  };
  const r = parseDrafts('```json\n' + JSON.stringify(json) + '\n```', 'n');
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.deepEqual(r.report.questions, ['옛 형식 질문', '격자 크기?']);
  assert.deepEqual(r.report.proposals, [null, '20×20']);
  assert.deepEqual(r.report.verifySuggestions, [{ label: 'typecheck', argv: ['npx', 'tsc', '--noEmit'], evidenceType: 'static_check' }]);
});

test('비서실장 질문에 답하면 현재 결정으로 기록되고, 제안대로도 받아들일 수 있다', { timeout: 30_000 }, async (t) => {
  const env = await setup(t);
  const [emp] = env.company.employees();
  env.orch.records.saveRequest({
    id: 'Q-1',
    projectId: env.projectId,
    text: '스네이크',
    status: 'drafted',
    employeeId: emp!.id,
    runId: null,
    summary: '',
    drafts: [],
    questions: ['격자 크기?', '시작 속도?', '가득 차면?'],
    proposals: ['20×20', '150ms', null],
    answers: [null, null, null],
    error: null,
    ticketIds: [],
    createdAt: new Date().toISOString(),
  });
  env.orch.answerQuestions('Q-1', [{ index: 1, answer: '120ms' }]);
  env.orch.answerQuestions('Q-1', [{ index: 0, answer: null }]);
  assert.throws(() => env.orch.answerQuestions('Q-1', [{ index: 2, answer: null }]), /제안|proposal/);
  const req = env.orch.records.request('Q-1')!;
  assert.deepEqual(req.answers, ['20×20', '120ms', null]);
  const decisions = env.orch.records.decisions(env.projectId, 'current').map((d) => d.text);
  assert.ok(decisions.some((d) => d.includes('시작 속도? → 120ms')));
  assert.ok(decisions.some((d) => d.includes('격자 크기? → 20×20')));
});

test('다시 검증: 직원에게 한 회차 더 시키지 않고 마지막 제출물을 검증·검수부터 다시 한다', { timeout: 180_000 }, async (t) => {
  const env = await setup(t, { reviewer: 'harsh' });
  const tk = newImplTicket(env);
  await driveUntil(env, tk.id, (x) => x.hold !== null, 150_000); // 세 회차 반려: 실측 57~62초라 기본 60초가 빠듯했다
  const workRuns = () => env.orch.records.runsForTicket(tk.id).filter((r) => r.kind === 'work').length;
  const verifyEvidence = () => env.orch.records.evidenceFor(tk.id).filter((e) => e.label === 'unit tests').length;
  const [w0, v0] = [workRuns(), verifyEvidence()];
  const next = env.orch.reverify(tk.id);
  assert.equal(next.status, 'verifying');
  assert.equal(next.hold, null);
  await driveUntil(env, tk.id, (x) => x.hold !== null || x.status === 'in_review');
  await env.orch.idle();
  assert.equal(workRuns(), w0, '작업 회차가 늘지 않는다(토큰 없음)');
  assert.equal(verifyEvidence(), v0 + 1, '검증을 한 번 더 돌렸다');
});

test('다시 검증은 대표만, 검수 중·수정 요청 상태에서만', () => {
  const tk = { id: 'T', status: 'awaiting_approval', hold: null, round: 2 } as never;
  assert.equal(applyTicketCommand(tk, { type: 'ceo_reverify', round: 1 }, { kind: 'ceo' }, 'now').ok, false);
  const cr = { id: 'T', status: 'changes_requested', hold: null, round: 2 } as never;
  assert.equal(applyTicketCommand(cr, { type: 'ceo_reverify', round: 1 }, { kind: 'orchestrator' }, 'now').ok, false);
  const ok = applyTicketCommand(cr, { type: 'ceo_reverify', round: 1 }, { kind: 'ceo' }, 'now');
  assert.ok(ok.ok && ok.ticket.status === 'verifying' && ok.ticket.round === 1);
});

test('의존성 설치 기록은 "준비" 증거: 어떤 요구사항의 증거도 되지 않는다', (t) => {
  const d = mkdtempSync(path.join(tmpdir(), 'ac-setup-'));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  writeFileSync(path.join(d, 'package.json'), '{}');
  const s = dependencySetup(d, [])!;
  assert.equal(s.evidenceType, 'setup');
  assert.ok(EVIDENCE_STRENGTH.setup < EVIDENCE_STRENGTH.mockup);
});

test('프롬프트: 비서실장은 검증 명령과 같은 종류의 증거만, 사람 확인은 보고·듣고·해 봐야 할 때만. 검수자는 재실행하지 않는다', async (t) => {
  const env = await setup(t);
  const [emp] = env.company.employees();
  const project = env.company.requireProject(env.projectId);
  const draft = buildDraftPrompt({ employee: emp!, project, requestId: 'Q', request: 'x', nonce: 'n', decisions: [], language: 'ko' });
  assert.match(draft, /verifySuggestions/);
  assert.match(draft, /"proposal"/);
  assert.match(draft, /human_attest" only for what a person must see, hear, play or judge personally/);
  const tk = newImplTicket(env);
  const review = buildReviewPrompt({
    employee: emp!,
    project,
    ticket: tk,
    nonce: 'n',
    diff: '',
    changedPaths: [],
    evidence: [],
    assigneeSummary: '',
    decisions: [{ id: 'D-1', text: '격자는 20×20' } as never],
    language: 'ko',
  });
  assert.match(review, /installs are blocked/);
  assert.match(review, /격자는 20×20/, '검수자도 대표 결정을 받는다');
});

test('승인 요청에 검수자 의견이 함께 담긴다', { timeout: 120_000 }, async (t) => {
  const env = await setup(t);
  const tk = newImplTicket(env);
  await driveUntil(env, tk.id, (x) => x.status === 'awaiting_approval' || x.hold !== null);
  const a = env.orch.records.pendingApprovalFor(tk.id, 'integrate')!;
  const review = (a.detail as { review: { by: string; summary: string } | null }).review;
  assert.ok(review?.summary, '검수 의견이 있다');
  assert.equal(review!.by, env.company.requireTicket(tk.id).reviewerId);
});

test('실행해 보기는 승인·반려가 끝나면 꺼진다(옛 제출물을 열어 두지 않는다)', { timeout: 120_000 }, async (t) => {
  const env = await setup(t);
  const tk = newImplTicket(env);
  await driveUntil(env, tk.id, (x) => x.status === 'awaiting_approval' || x.hold !== null);
  await env.orch.preview(env.projectId, tk.id);
  assert.equal(env.orch.previewList().length, 1);
  assert.equal(env.orch.previewList()[0]!.stale, false, '지금 제출물을 띄웠다');
  const a = env.orch.records.pendingApprovalFor(tk.id, 'integrate')!;
  env.orch.decideIntegration(a.id, 'rejected', { reason: '다시' });
  assert.equal(env.orch.previewList().length, 0);
});

test('실측 토큰 갱신 경합 오류는 "일시적" 오류: 로그인 필요·형식 오류가 아니다', async () => {
  const { classifyCommon } = await import('../../src/adapters/types.ts');
  const msg =
    'Failed to refresh OAuth token: another Claude Code process is refreshing it or exited mid-refresh. This is usually transient; retry in a minute, and if it persists close other Claude Code processes or sign in again';
  assert.equal(classifyCommon({ exitCode: 1, timedOut: false, stderr: '', finalText: msg }), 'transient');
  assert.equal(
    classifyCommon({ exitCode: 1, timedOut: false, stderr: '', finalText: 'Not logged in · Please run /login' }),
    'auth_required',
  );
});

test('실패한 초안 요청은 같은 내용으로 다시 보낼 수 있다', { timeout: 60_000 }, async (t) => {
  const env = await setup(t);
  env.company.hireEmployee({ name: '비서실장', roles: ['chief-of-staff'], cli: 'fake', model: 'diligent' });
  const [emp] = env.company.employees();
  env.orch.records.saveRequest({
    id: 'Q-old',
    projectId: env.projectId,
    text: '버전 표시',
    status: 'failed',
    employeeId: emp!.id,
    runId: null,
    summary: '',
    drafts: [],
    questions: [],
    error: 'x',
    ticketIds: [],
    createdAt: new Date().toISOString(),
  });
  const next = await env.orch.retryRequest('Q-old');
  assert.equal(next.retriedFrom, 'Q-old');
  assert.equal(next.text, '버전 표시');
  assert.equal(env.orch.records.request('Q-old')!.status, 'dismissed');
  await assert.rejects(env.orch.retryRequest('Q-old'), /다시 시도|cannot be retried/);
  await env.orch.idle();
});

// 결과물 종류(화면·문서·프로그램): 대표 요청(2026-10-01) "게임만이 아니라 모든 분야에 쓰이면 좋겠다".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDraftPrompt, buildReviewPrompt, buildWorkPrompt, profileBlock } from '../../src/agents/prompt.ts';
import { parseDrafts, profileOf } from '../../src/agents/report.ts';
import { claudeAdapter } from '../../src/adapters/claude.ts';
import { codexAdapter } from '../../src/adapters/codex.ts';
import { pythonTests } from '../../src/app/repo-inspect.ts';
import type { InvocationRequest } from '../../src/adapters/types.ts';
import type { Employee, Project, ProjectProfile, Ticket } from '../../src/core/types.ts';

const emp = { id: 'E1', name: '민수', roles: ['implementer'], cli: 'claude' } as Employee;
const project = (profile?: ProjectProfile): Project =>
  ({ id: 'P1', name: 'p', protectedPaths: [], verifyCommands: [], docRules: '', ...(profile ? { profile } : {}) }) as unknown as Project;
const ticket = (type: Ticket['type'], evidenceType = 'human_attest'): Ticket =>
  ({
    id: 'T-1',
    type,
    title: 't',
    purpose: 'p',
    round: 1,
    writeScope: ['docs/**'],
    requirements: [{ id: 'R1', text: 'r', evidenceType }],
    doneCriteria: 'd',
  }) as unknown as Ticket;
const work = (p: Project, t: Ticket) =>
  buildWorkPrompt({ employee: emp, project: p, ticket: t, nonce: 'n', decisions: [], feedback: null, language: 'ko' });
const doc = project({ summary: '카페 사업계획서', mobile: false, game: false, deliverable: 'document' });
const prog = project({ summary: '가계부 CSV 정리 CLI', mobile: false, game: false, deliverable: 'program' });

test('프로필: 결과물 종류를 읽고, 화면이 아니면 휴대폰·게임 점검은 끈다. 모르는 값은 화면', () => {
  assert.deepEqual(profileOf({ summary: '보고서', mobile: true, game: true, deliverable: 'document' }), {
    summary: '보고서',
    mobile: false,
    game: false,
    deliverable: 'document',
  });
  assert.equal(profileOf({ summary: 'x', deliverable: 'video' })?.deliverable, 'screen');
  assert.equal(profileOf({ summary: 'x', mobile: true })?.mobile, true);
});

test('지시문: 문서 프로젝트는 문서로 쓰고 화면 점검 안내가 없다', () => {
  const p = work(doc, ticket('doc'));
  assert.match(p, /Deliverable: documents/);
  assert.match(p, /reading your document rendered in the app/);
  assert.doesNotMatch(p, /Screen check guide|screenSteps|previewPage|Demo commands guide/);
  assert.doesNotMatch(p, /AI development company/);
});

test('지시문: 화면 없는 프로그램은 확인용 실행 명령을 남기게 한다', () => {
  const p = work(prog, ticket('impl'));
  assert.match(p, /Demo commands guide/);
  assert.match(p, /"demoCommands":\[\]/);
  assert.match(p, /python -m unittest/);
  assert.doesNotMatch(p, /Screen check guide|screenSteps/);
});

test('지시문: 프로필이 없으면(예전 프로젝트) 지금처럼 화면 점검', () => {
  const p = work(project(), ticket('impl'));
  assert.match(p, /Screen check guide/);
  assert.match(p, /"screenSteps":\[\]/);
});

test('조사 업무: 보고서 파일과 실제로 연 출처만, 검수자는 출처를 열어 대조', () => {
  const t = ticket('research', 'inspection');
  assert.match(work(doc, t), /research ticket: write your findings into a Markdown file/);
  assert.match(work(doc, t), /never write a URL from memory/);
  const review = buildReviewPrompt({
    employee: emp,
    project: doc,
    ticket: t,
    nonce: 'n',
    diff: '',
    changedPaths: [],
    evidence: [],
    assigneeSummary: '',
    language: 'ko',
  });
  assert.match(review, /open at least three of the cited sources/);
  assert.doesNotMatch(work(doc, ticket('doc')), /research ticket/);
});

test('초안: 결과물 종류별 규칙, 프로필 제안에 deliverable, 조사 업무는 범위가 없으면 research/**', () => {
  const draft = (p: Project) =>
    buildDraftPrompt({ employee: emp, project: p, requestId: 'Q-1', request: 'r', nonce: 'n', decisions: [], language: 'ko' });
  assert.match(draft(doc), /deliverables are documents/);
  assert.match(draft(prog), /pytest is not installed here/);
  assert.match(draft(project()), /"deliverable":"screen\|document\|program"/);
  const text =
    '```json\n' +
    JSON.stringify({
      nonce: 'n',
      tickets: [{ type: 'research', title: '조사', requirements: [{ text: 'r', evidenceType: 'inspection' }] }],
    }) +
    '\n```';
  const r = parseDrafts(text, 'n');
  assert.ok(r.ok);
  assert.deepEqual(r.ok && r.report.tickets[0]!.writeScope, ['research/**']);
});

test('프로필 블록: 화면 프로젝트는 예전 그대로', () => {
  assert.match(profileBlock(project({ summary: 'RPG', mobile: false, game: true })), /desktop only[\s\S]*This is a game/);
});

const base: InvocationRequest = {
  prompt: 'p',
  cwd: '.',
  model: null,
  accessLevel: 'read-only',
  allowedCommands: [],
  profileEnv: {},
  runDir: '.',
};
const after = (args: string[], flag: string) => args[args.indexOf(flag) + 1] ?? '';

test('웹 도구: 조사 업무에서만 Claude WebFetch/WebSearch와 Codex 실시간 검색을 연다', () => {
  const off = claudeAdapter.buildInvocation(base).args;
  assert.match(after(off, '--disallowedTools'), /WebFetch/);
  const on = claudeAdapter.buildInvocation({ ...base, web: true }).args;
  assert.match(after(on, '--allowedTools'), /WebFetch,WebSearch/);
  assert.doesNotMatch(after(on, '--disallowedTools'), /WebFetch/);
  const write = claudeAdapter.buildInvocation({ ...base, accessLevel: 'write-ask', web: true }).args;
  assert.match(after(write, '--allowedTools'), /WebSearch/);
  assert.ok(!write.includes('--disallowedTools'));
  assert.equal(codexAdapter.buildInvocation({ ...base, web: true }).env.AC_CODEX_WEB, '1');
  assert.equal(codexAdapter.buildInvocation(base).env.AC_CODEX_WEB, undefined);
});

test('파이썬 검사 추천: pytest라고 적힌 곳만 pytest, 아니면 표준 unittest', () => {
  const files = (m: Record<string, string>) => (f: string) => m[f] ?? null;
  assert.deepEqual(pythonTests(files({ 'pytest.ini': '' }), true)?.argv, ['python', '-m', 'pytest']);
  assert.deepEqual(pythonTests(files({ 'pyproject.toml': '[tool.pytest.ini_options]' }), false)?.argv, ['python', '-m', 'pytest']);
  assert.deepEqual(pythonTests(files({ 'main.py': '' }), true)?.argv, ['python', '-m', 'unittest', 'discover', '-s', 'tests', '-t', '.']);
  assert.equal(pythonTests(files({ 'main.py': '' }), false), null);
  assert.equal(pythonTests(files({}), true), null);
});

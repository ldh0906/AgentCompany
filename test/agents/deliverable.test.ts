// 결과물 종류(화면·문서·프로그램): 대표 요청(2026-10-01) "게임만이 아니라 모든 분야에 쓰이면 좋겠다".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDraftPrompt, buildReviewPrompt, buildWorkPrompt, profileBlock } from '../../src/agents/prompt.ts';
import { buildAcceptancePrompt } from '../../src/agents/acceptance-prompts.ts';
import { parseDrafts, parseReport, profileOf } from '../../src/agents/report.ts';
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

test('조사·문서 검수: 결론·핵심 숫자를 바꾸는 오류만 반려, 작은 실수는 "minorFixes"', () => {
  const review = (p: Project, t: Ticket) =>
    buildReviewPrompt({
      employee: emp,
      project: p,
      ticket: t,
      nonce: 'n',
      diff: '',
      changedPaths: [],
      evidence: [],
      assigneeSummary: '',
      language: 'ko',
    });
  assert.match(review(doc, ticket('doc', 'inspection')), /Request changes only for errors that would change a conclusion/);
  assert.match(review(project(), ticket('research', 'inspection')), /Request changes only for errors that would change a conclusion/);
  assert.doesNotMatch(review(project(), ticket('impl', 'unit_test')), /Request changes only for errors that would change a conclusion/);
});

test('대표 요청 원문: 담당자와 검수자 모두 보고, 다른 조각의 조건과도 어긋나지 않게', () => {
  const req = '일주일 식단 짜줘. 주말에 한 번 장보면 되게';
  const w = buildWorkPrompt({
    employee: emp,
    project: doc,
    ticket: ticket('doc'),
    nonce: 'n',
    decisions: [],
    feedback: null,
    request: req,
    language: 'ko',
  });
  assert.match(w, /The CEO's original request[\s\S]*주말에 한 번 장보면 되게/);
  assert.match(w, /must not contradict anything the CEO asked for/);
  const r = buildReviewPrompt({
    employee: emp,
    project: doc,
    ticket: ticket('doc'),
    nonce: 'n',
    diff: '',
    changedPaths: [],
    evidence: [],
    assigneeSummary: '',
    request: req,
    language: 'ko',
  });
  assert.match(r, /does not contradict the original request/);
  assert.doesNotMatch(work(doc, ticket('doc')), /original request/, '요청이 없으면(직접 만든 업무) 빼기');
});

test('인수 시험 지시문: 화면 사진이 있으면 사진으로 판정, 화면인데 못 찍었으면 ❓, 화면이 아니면 말하지 않는다', () => {
  const base = {
    employee: emp,
    request: 'r',
    tests: [{ id: 'A1', check: 'c', how: 'h' }],
    tickets: [],
    checks: [],
    decisions: [],
    round: 1,
    maxRounds: 3,
    nonce: 'n',
    language: 'ko',
  };
  const shot = buildAcceptancePrompt({
    ...base,
    project: project(),
    screens: { shots: [{ file: '.acceptance-shots/1.png', label: 'T-1 R2 첫 화면' }], errors: [], text: '단어 퀴즈' },
  });
  assert.match(shot, /\.acceptance-shots\/1\.png: T-1 R2 첫 화면/);
  assert.match(shot, /from the pictures, not from reading CSS/);
  assert.match(buildAcceptancePrompt({ ...base, project: project(), screens: null }), /No screenshots could be taken.*❓/);
  const program = buildAcceptancePrompt({ ...base, project: project({ deliverable: 'program' } as ProjectProfile), screens: null });
  assert.doesNotMatch(program, /screenshot/i);
});

test('인수 시험을 끈 프로젝트: 비서실장에게 인수 시험을 쓰지 말라고 한다', () => {
  const draft = (p: Project) =>
    buildDraftPrompt({ employee: emp, project: p, requestId: 'Q-1', request: 'r', nonce: 'n', decisions: [], language: 'ko' });
  assert.match(draft(project()), /V-model: before splitting/);
  const off = draft({ ...project(), acceptanceTests: false } as Project);
  assert.doesNotMatch(off, /V-model: before splitting/);
  assert.match(off, /Leave "acceptance" empty/);
});

test('전권 위임 중: 기본값이 분명한 작은 결정은 멈추지 않고 정해 "assumed"에 적는다', () => {
  const work = (delegated: boolean) =>
    buildWorkPrompt({
      employee: emp,
      project: project(),
      ticket: ticket('impl'),
      nonce: 'n',
      decisions: [],
      feedback: null,
      language: 'ko',
      delegated,
    });
  assert.match(work(true), /delegated decisions to the team/);
  assert.match(work(true), /"assumed":\[\]/);
  assert.doesNotMatch(work(false), /assumed/);
  const text =
    '```json\n' +
    JSON.stringify({
      nonce: 'n',
      kind: 'work',
      status: 'done',
      summary: 's',
      requirements: [{ id: 'R1', claim: 'met', notes: '' }],
      assumed: ['알림 간격 60분(흔한 기본값)', 3],
    }) +
    '\n```';
  const r = parseReport(text, { kind: 'work', nonce: 'n', requirementIds: ['R1'] });
  assert.ok(r.ok && r.report.kind === 'work');
  assert.deepEqual(r.report.assumed, ['알림 간격 60분(흔한 기본값)']);
});

test('검수자의 작은 실수(minorFixes): 검수 지시에 칸이 있고, 읽어 들이며, 뒤 업무 지시에 넘어간다', () => {
  const review = buildReviewPrompt({
    employee: emp,
    project: project(),
    ticket: ticket('doc'),
    nonce: 'n',
    diff: '',
    changedPaths: [],
    evidence: [],
    assigneeSummary: '',
    language: 'ko',
  });
  assert.match(review, /"minorFixes":\[\]/);
  const text =
    '```json\n' +
    JSON.stringify({
      nonce: 'n',
      kind: 'review',
      verdict: 'approve',
      summary: 's',
      requirements: [{ id: 'R1', met: true, evidenceIds: [], reason: '' }],
      minorFixes: ['docs/books.md: 5·6월이 둘 다 인문인데 "연달아 같은 장르 없음"이라고 씀', ' ', 7],
    }) +
    '\n```';
  const r = parseReport(text, { kind: 'review', nonce: 'n', requirementIds: ['R1'] });
  assert.ok(r.ok && r.report.kind === 'review');
  assert.deepEqual(r.report.minorFixes, ['docs/books.md: 5·6월이 둘 다 인문인데 "연달아 같은 장르 없음"이라고 씀']);
  const base = { employee: emp, project: project(), ticket: ticket('doc'), nonce: 'n', decisions: [], feedback: null, language: 'ko' };
  assert.match(
    buildWorkPrompt({ ...base, knownIssues: ['T-58: 5·6월 장르 표기'] }),
    /Small issues reviewers noted[\s\S]*T-58: 5·6월 장르 표기/,
  );
  assert.doesNotMatch(buildWorkPrompt(base), /Small issues reviewers noted/);
});

test('인수 시험 지시문: 사람만 확인할 수 있는 것은 ❓, 링크는 시스템 확인 결과를 믿는다', () => {
  const p = buildAcceptancePrompt({
    employee: emp,
    project: project({ summary: 's', mobile: false, game: false, deliverable: 'document' }),
    request: 'r',
    tests: [{ id: 'A1', check: 'c', how: 'h' }],
    tickets: ['- T-57 [done] 조사\n  system link check (passed): 12개 열림'],
    checks: [],
    decisions: [],
    round: 1,
    maxRounds: 3,
    nonce: 'n',
    language: 'ko',
  });
  assert.match(p, /a fix ticket cannot make a phone call/);
  assert.match(p, /You cannot open web pages/);
  assert.match(p, /"for":"review"/);
});

test('전권 위임: "assumed"는 대표가 읽는 쉬운 말로, 구현 세부는 빼라고 한다', () => {
  const w = buildWorkPrompt({
    employee: emp,
    project: project(),
    ticket: ticket('impl'),
    nonce: 'n',
    decisions: [],
    feedback: null,
    language: 'ko',
    delegated: true,
  });
  assert.match(w, /read by a non-developer CEO/);
  assert.match(w, /Leave out implementation details/);
});

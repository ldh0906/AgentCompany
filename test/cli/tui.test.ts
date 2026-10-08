// TUI 그리기: 한글이 섞여도 모든 줄이 정확히 화면 폭, 대표 차례는 바로 할 수 있는 동작으로.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render, todoItems, wrap, type Model } from '../../src/cli/tui.ts';
import { fit, pad, width } from '../../src/cli/term.ts';
import type { CliState } from '../../src/cli/view.ts';

const now = '2026-10-08T06:00:00.000Z';
const state = {
  employees: [
    { id: 'E-1', name: '리드', roles: ['chief-of-staff'], cli: 'claude', rank: 'lead', active: true },
    { id: 'E-2', name: '구현', roles: ['implementer'], cli: 'codex', rank: 'senior', active: true },
  ],
  projects: [{ id: 'P-1', name: '가계부', originPath: 'C:/work/ledger' }],
  tickets: [
    {
      id: 'T-1',
      title: '아주 긴 한글 제목이 들어간 업무로 폭을 넘깁니다 아주 길게 길게 길게',
      status: 'in_progress',
      hold: null,
      requirements: [],
    },
    {
      id: 'T-2',
      title: '버튼',
      status: 'verifying',
      hold: { reason: 'needs_permission', resumeTo: 'verifying', since: now, note: '계약:src/contract/types.ts' },
      requirements: [],
    },
  ],
  approvals: [
    {
      id: 'A-1',
      kind: 'integrate_request',
      ticketId: null,
      summary: '요청 결과물: 가계부 — 업무 2개, 5개 파일',
      detail: {
        requestId: 'Q-1',
        text: '가계부 만들어줘',
        changedPaths: ['a', 'b'],
        tickets: [{ id: 'T-1', title: 'x' }],
        checks: [{ ticketId: 'T-1', id: 'R2', text: '화면이 보인다' }],
        acceptance: { passed: 2, total: 3, left: ['A3 ⚠ 저장이 안 됨'] },
      },
      state: 'pending',
      createdAt: now,
    },
  ],
  runs: [{ id: 'R-1', ticketId: 'T-1', employeeId: 'E-2', kind: 'work', status: 'running', startedAt: now }],
  requests: [],
  ceoTodos: [
    { key: 'appr:A-1', kind: 'approval', title: 'x', link: '/' },
    {
      key: 'hold:T-2',
      kind: 'permission',
      title: 'T-2 버튼: 계약 파일 수정',
      link: '/tickets/T-2',
      ticketId: 'T-2',
      reason: '허락 필요',
      action: { kind: 'allow', paths: ['계약:src/contract/types.ts'] },
    },
  ],
  events: [{ seq: 1, ts: now, actor: 'ceo', type: 'request.submitted', entityId: 'Q-1', payload: { text: '가계부', chief: 'E-1' } }],
  paused: false,
  delegation: { on: false },
} as unknown as CliState;

const model = (over: Partial<Model> = {}): Model => ({
  s: state,
  project: '가계부',
  sel: 0,
  mode: 'normal',
  input: '',
  detail: false,
  msg: '',
  error: '',
  ...over,
});

test('글자 폭: 한글은 두 칸, 잘라도 폭을 넘지 않는다', () => {
  assert.equal(width('가a'), 3);
  assert.equal(width(fit('가나다라마', 5)), 5);
  assert.equal(fit('가나다라마', 5), '가나…');
  assert.equal(width(pad('가', 6)), 6);
  assert.deepEqual(wrap('가나다라', 4), ['가나', '다라']);
});

test('TUI: 여러 크기에서 모든 줄이 정확히 화면 폭이고, 화면 높이를 넘지 않는다', () => {
  for (const [w, h] of [
    [80, 24],
    [120, 40],
    [60, 18],
  ] as const) {
    for (const m of [model(), model({ detail: true }), model({ mode: 'input', input: '로그인 화면 만들어줘' }), model({ sel: 1 })]) {
      const lines = render(m, w, h);
      assert.ok(lines.length <= h, `${w}x${h}: ${lines.length}줄`);
      for (const l of lines) assert.equal(width(l), w, `${w}x${h}: ${JSON.stringify(l)}`);
    }
  }
  const text = render(model(), 100, 30).join('\n');
  assert.match(text, /구현 Codex/);
  assert.match(text, /작업 T-1/, '누가 무엇을 하는지');
  assert.match(text, /대표 차례 \(2\)/);
});

test('대표 차례: 요청 결과물은 승인(직접 확인 항목 포함), 계약 수정 보류는 허락/되돌리기', () => {
  const [a, b] = todoItems(state);
  assert.equal(a!.act.kind, 'approval');
  assert.ok(a!.act.kind === 'approval' && a!.act.request && a!.act.checks[0] === 'T-1:R2');
  assert.ok(a!.act.kind === 'approval' && a!.act.text.some((x) => x.includes('인수 시험 2/3')));
  assert.deepEqual(b!.act, { kind: 'scope', ticketId: 'T-2' });
  const detail = render(model({ detail: true }), 100, 30).join('\n');
  assert.match(detail, /직접 확인: T-1 화면이 보인다/);
});

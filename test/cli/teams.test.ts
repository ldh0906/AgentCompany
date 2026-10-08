// 팀 파일(YAML): 내장 팀을 읽고, primary·secondary를 쓸 수 있는 AI로 바꾸고, 지금 팀을 파일로 내보낸다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { builtInTeams, exportTeam, loadTeam, parseTeam, resolveSeats } from '../../src/cli/teams.ts';
import { parseYaml } from '../../src/cli/yaml.ts';

test('YAML: 맵·목록·한 줄 목록·따옴표·주석·숫자', () => {
  const y = parseYaml(`# 주석
name: "팀 # 이름"
n: 3
on: true
seats:
  - name: 리드  # 끝 주석
    roles: [chief-of-staff, qa]
  - name: 'it''s'
    roles:
      - implementer
list:
- a
- b
`);
  assert.deepEqual(y, {
    name: '팀 # 이름',
    n: 3,
    on: true,
    seats: [
      { name: '리드', roles: ['chief-of-staff', 'qa'] },
      { name: "it's", roles: ['implementer'] },
    ],
    list: ['a', 'b'],
  });
  assert.throws(() => parseYaml('a: |\n  b'), /YAML 1/);
});

test('내장 팀: starter·workshop·factory, primary·secondary는 로그인된 AI로', () => {
  const names = builtInTeams().map((t) => t.name);
  assert.deepEqual(names.sort(), ['factory', 'starter', 'workshop']);
  const starter = resolveSeats(loadTeam('starter'), ['codex', 'claude']);
  assert.deepEqual(
    starter.map((s) => [s.name, s.cli, s.rank]),
    [
      ['리드', 'codex', 'lead'],
      ['구현', 'claude', 'senior'],
    ],
  );
  // AI가 하나뿐이면 secondary도 그 AI
  assert.ok(resolveSeats(loadTeam('workshop'), ['claude']).every((s) => s.cli === 'claude'));
  assert.throws(() => resolveSeats(loadTeam('starter'), []), /doctor/);
  assert.throws(() => loadTeam('nope'), /starter/);
});

test('팀 파일 검사: 모르는 역할·직급·중복 이름은 거부', () => {
  assert.throws(() => parseTeam('seats:\n  - name: a\n    roles: [boss]\n', 'x.yaml'), /boss/);
  assert.throws(() => parseTeam('seats:\n  - name: a\n    roles: [qa]\n    rank: king\n', 'x.yaml'), /rank/);
  assert.throws(() => parseTeam('seats:\n  - name: a\n    roles: [qa]\n  - name: a\n    roles: [qa]\n', 'x.yaml'), /같은 이름/);
});

test('지금 팀 내보내기 → 다시 읽으면 같은 팀(삭제·비활성 직원은 빠짐)', () => {
  const yaml = exportTeam('mine', [
    { name: '팀장 "A"', roles: ['chief-of-staff', 'qa'], rank: 'lead', cli: 'claude', model: 'opus', active: true },
    { name: '구현', roles: ['implementer'], rank: 'senior', cli: 'codex', model: null, active: true },
    { name: '퇴사', roles: ['qa'], rank: 'senior', cli: 'codex', model: null, active: true, removedAt: '2026-10-01' },
  ]);
  const t = parseTeam(yaml, 'mine.yaml');
  assert.equal(t.name, 'mine');
  assert.deepEqual(
    t.seats.map((s) => [s.name, s.roles, s.rank, s.cli, s.model]),
    [
      ['팀장 "A"', ['chief-of-staff', 'qa'], 'lead', 'claude', 'opus'],
      ['구현', ['implementer'], 'senior', 'codex', null],
    ],
  );
});

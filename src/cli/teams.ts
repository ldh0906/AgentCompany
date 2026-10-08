// 팀 파일(YAML): 팀을 한 장으로 적고 `aco up <팀>` 한 번으로 고용한다. 내장 팀은 teams/*.yaml.
// cli: primary(로그인된 첫 AI), secondary(다른 AI가 있으면 그것, 없으면 primary), 또는 claude/codex/agy를 직접.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_ACTIVE_EMPLOYEES, RANKS, type Employee, type Rank, type RoleTemplate } from '../core/types.ts';
import { parseYaml, toYaml, type Yaml } from './yaml.ts';

const ROLES: readonly RoleTemplate[] = ['chief-of-staff', 'planner', 'architect', 'implementer', 'ux', 'qa', 'recorder'];
const CLIS = ['claude', 'codex', 'agy', 'fake'] as const;
type Cli = (typeof CLIS)[number];

export interface Seat {
  name: string;
  roles: RoleTemplate[];
  rank: Rank;
  /** primary | secondary | claude | codex | agy | fake */
  cli: string;
  model?: string | null;
}

export interface Team {
  name: string;
  description: string;
  seats: Seat[];
}

export function teamsDir(): string {
  // src/cli → ../../teams, dist/cli → ../../teams
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'teams');
}

export function builtInTeams(): Team[] {
  const dir = teamsDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.yaml'))
    .map((f) => parseTeam(readFileSync(path.join(dir, f), 'utf8'), f));
}

/** 내장 팀 이름(starter) 또는 YAML 파일 경로 */
export function loadTeam(nameOrPath: string): Team {
  if (/\.ya?ml$/i.test(nameOrPath) || existsSync(nameOrPath)) {
    return parseTeam(readFileSync(nameOrPath, 'utf8'), nameOrPath);
  }
  const file = path.join(teamsDir(), `${nameOrPath}.yaml`);
  if (!existsSync(file)) {
    const known = builtInTeams().map((t) => t.name);
    throw new Error(`알 수 없는 팀: ${nameOrPath} (내장 팀: ${known.join(', ')} 또는 .yaml 파일 경로)`);
  }
  return parseTeam(readFileSync(file, 'utf8'), file);
}

export function parseTeam(src: string, where: string): Team {
  const y = parseYaml(src);
  const fail = (m: string) => {
    throw new Error(`${where}: ${m}`);
  };
  if (!y || typeof y !== 'object' || Array.isArray(y)) fail('팀 파일은 name, seats가 있는 맵이어야 합니다.');
  const o = y as { [k: string]: Yaml };
  if (!Array.isArray(o.seats) || !o.seats.length) fail('seats 목록이 비어 있습니다.');
  const seats = (o.seats as Yaml[]).map((s, i): Seat => {
    if (!s || typeof s !== 'object' || Array.isArray(s)) fail(`seats ${i + 1}: 맵이어야 합니다.`);
    const x = s as { [k: string]: Yaml };
    const name = typeof x.name === 'string' && x.name.trim() ? x.name.trim() : fail(`seats ${i + 1}: name이 없습니다.`)!;
    const roles = (Array.isArray(x.roles) ? x.roles : [x.roles]).map(String);
    const bad = roles.filter((r) => !ROLES.includes(r as RoleTemplate));
    if (!roles.length || bad.length) fail(`${name}: 알 수 없는 역할 ${bad.join(', ') || '(없음)'} (가능: ${ROLES.join(', ')})`);
    const rank = String(x.rank ?? 'senior');
    if (!RANKS.includes(rank as Rank)) fail(`${name}: rank는 ${RANKS.join(' | ')} 중 하나입니다.`);
    const cli = String(x.cli ?? 'primary');
    if (!['primary', 'secondary', ...CLIS].includes(cli)) fail(`${name}: cli는 primary | secondary | ${CLIS.join(' | ')} 중 하나입니다.`);
    return { name, roles: roles as RoleTemplate[], rank: rank as Rank, cli, model: typeof x.model === 'string' ? x.model : null };
  });
  if (seats.length > MAX_ACTIVE_EMPLOYEES) fail(`직원은 최대 ${MAX_ACTIVE_EMPLOYEES}명입니다.`);
  if (new Set(seats.map((s) => s.name)).size !== seats.length) fail('같은 이름의 자리가 있습니다.');
  return {
    name: typeof o.name === 'string' ? o.name : path.basename(where).replace(/\.ya?ml$/i, ''),
    description: typeof o.description === 'string' ? o.description : '',
    seats,
  };
}

/** primary·secondary를 지금 쓸 수 있는 AI로 바꾼다. available은 선호 순서(로그인된 것 먼저). */
export function resolveSeats(team: Team, available: Cli[]): (Seat & { cli: Cli })[] {
  if (!available.length) throw new Error('쓸 수 있는 AI CLI가 없습니다. `agent-company doctor`로 설치·로그인을 확인하세요.');
  const primary = available[0]!;
  const secondary = available.find((c) => c !== primary) ?? primary;
  return team.seats.map((s) => ({ ...s, cli: s.cli === 'primary' ? primary : s.cli === 'secondary' ? secondary : (s.cli as Cli) }));
}

/** 지금 팀을 팀 파일로(공유·재사용용). 쓰는 AI는 그대로 적는다. */
export function exportTeam(
  name: string,
  employees: Pick<Employee, 'name' | 'roles' | 'rank' | 'cli' | 'model' | 'active' | 'removedAt'>[],
): string {
  const seats = employees
    .filter((e) => e.active && !e.removedAt)
    .map((e) => ({
      name: e.name,
      roles: e.roles,
      rank: e.rank ?? 'senior',
      cli: e.cli,
      ...(e.model ? { model: e.model } : {}),
    }));
  return `${toYaml({ name, description: '', seats } as unknown as Yaml)}\n`;
}

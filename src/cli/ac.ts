// 짧은 명령으로 회사 쓰기: ac up · ac ask · ac ps · ac approve · ac reject · ac down · ac open · ac team
// 대시보드와 같은 API를 부른다(데몬이 없으면 창 없이 띄운다). 인자 없이 `ac`만 치면 TUI.
import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import type { Approval, Requirement } from '../core/types.ts';
import type { CeoRequest } from '../app/records.ts';
import type { RepoInspection } from '../app/repo-inspect.ts';
import type { DoctorReport } from '../app/doctor.ts';
import { Client, ensureDaemon } from './client.ts';
import { builtInTeams, exportTeam, loadTeam, resolveSeats } from './teams.ts';
import { c, table } from './term.ts';
import { nameOf, openTickets, projectFor, statusLabel, teamRows, type CliState } from './view.ts';

export const AC_COMMANDS = ['up', 'ask', 'ps', 'approve', 'reject', 'down', 'open', 'team'] as const;

const say = (s = '') => console.log(s);
const fail = (msg: string): never => {
  throw new Error(msg);
};

/** 데몬을 띄울 때 넘길 인자(--port) */
let daemonArgs: string[] = [];

async function connect(dataDir: string, quiet = false): Promise<Client> {
  const { daemon, started } = await ensureDaemon(dataDir, daemonArgs);
  if (started && !quiet) say(c.dim('회사를 켰습니다(창 없이 백그라운드).'));
  return new Client(daemon);
}

async function ask(q: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(q)).trim();
  } finally {
    rl.close();
  }
}

const yes = async (q: string, def = true) => {
  if (!process.stdin.isTTY) return def;
  const a = (await ask(`${q} ${def ? '[Y/n]' : '[y/N]'} `)).toLowerCase();
  return a ? a.startsWith('y') || a === 'ㅇ' : def;
};

export function openUrl(url: string): void {
  const [file, args] =
    process.platform === 'win32'
      ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  execFile(file, args as string[], { windowsHide: true }, () => {});
}

// ---------------- up ----------------

/** 이 폴더를 프로젝트로 등록하고(처음이면) 팀을 고용한다(직원이 없으면). */
async function up(argv: string[], dataDir: string): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { path: { type: 'string' }, fake: { type: 'boolean' } },
  });
  const cwd = values.path ?? process.cwd();
  const client = await connect(dataDir);
  let state = await client.get<CliState>('state');

  let project = state.projects.find((p) => sameDir(p.originPath, cwd));
  if (!project) {
    const repo = await client.get<RepoInspection>(`inspect?path=${encodeURIComponent(cwd)}`);
    if (!repo.isGit)
      fail(
        `여기는 git 저장소의 맨 위 폴더가 아닙니다: ${cwd}\n  새로 시작하려면: git init && git commit --allow-empty -m init   그다음 ac up`,
      );
    project = await client.post<CliState['projects'][number]>('projects', {
      name: repo.name,
      originPath: cwd,
      baseBranch: repo.baseBranch,
      verifyCommands: repo.verify,
      protectedPaths: repo.protectedSuggestions,
    });
    say(`${c.green('✔')} 프로젝트 등록: ${c.bold(project.name)} ${c.dim(`(${repo.baseBranch})`)}`);
    say(c.dim(`  검사 명령: ${repo.verify.map((v) => v.argv.join(' ')).join(', ') || '없음(웹의 프로젝트 화면에서 추가할 수 있습니다)'}`));
  } else say(`${c.green('✔')} 프로젝트: ${c.bold(project.name)}`);

  const active = state.employees.filter((e) => e.active && !e.removedAt);
  if (active.length && positionals[0])
    say(c.yellow(`이미 팀이 있어(${active.length}명) ${positionals[0]} 팀을 새로 고용하지 않았습니다. 바꾸려면 웹의 조직 화면을 쓰세요.`));
  if (!active.length) {
    const team = loadTeam(positionals[0] ?? 'starter');
    let available: ('claude' | 'codex' | 'agy' | 'fake')[];
    if (values.fake) available = ['fake'];
    else {
      say(c.dim('AI CLI 확인 중…'));
      const doc = await client.get<DoctorReport>('doctor');
      available = (['claude', 'codex', 'agy'] as const).filter((k) => {
        const x = doc.clis.find((y) => y.kind === k);
        return x?.found && x.login !== 'missing';
      });
      if (!available.length)
        fail(
          '로그인된 AI CLI가 없습니다. `agent-company doctor`로 로그인 방법을 확인하거나, 구독 없이 체험하려면 `ac up --fake`를 쓰세요.',
        );
    }
    for (const s of resolveSeats(team, available)) {
      await client.post('employees', { name: s.name, roles: s.roles, cli: s.cli, rank: s.rank, model: s.model ?? null });
    }
    say(`${c.green('✔')} ${c.bold(team.name)} 팀 고용: ${team.description}`);
    state = await client.get<CliState>('state');
  }
  say();
  printTeam(state);
  say();
  say(`다음: ${c.cyan('ac ask "만들고 싶은 것"')}  ·  화면: ${c.cyan('ac')}  ·  웹: ${c.cyan('ac open')}`);
}

function sameDir(a: string, b: string): boolean {
  const n = (x: string) => x.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
  return n(a) === n(b);
}

// ---------------- ask ----------------

async function askLead(argv: string[], dataDir: string): Promise<void> {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { yes: { type: 'boolean', short: 'y' } } });
  const text = positionals.join(' ').trim() || (process.stdin.isTTY ? await ask('무엇을 만들까요? ') : '');
  if (!text) fail('요청 내용을 적어 주세요: ac ask "로그인 화면 만들어줘"');
  const client = await connect(dataDir);
  const state = await client.get<CliState>('state');
  const project = projectFor(state, process.cwd()) ?? fail('이 폴더의 프로젝트가 없습니다. 먼저 `ac up`을 실행하세요.');
  const req = await client.post<CeoRequest>('requests', { projectId: project.id, text });
  const lead = state.employees.find((e) => e.id === req.employeeId);
  say(`${c.dim('→')} ${lead?.name ?? '리드'}에게 보냈습니다. 업무로 나누는 중…`);
  const done = await waitDrafted(client, req.id);
  if (done.status === 'failed') fail(`초안을 만들지 못했습니다: ${done.error ?? ''}`);
  if (done.status === 'accepted') {
    say(`${c.green('✔')} 위임 모드라 리드가 바로 확정했습니다. 진행은 ${c.cyan('ac')}로 보세요.`);
    return;
  }
  if (done.status !== 'drafted') fail(`요청 상태: ${done.status}`);
  printDrafts(done);
  if (values.yes || (await yes('이대로 시작할까요?'))) {
    await client.post(`requests/${done.id}/accept`, {});
    say(`${c.green('✔')} 시작했습니다. 진행은 ${c.cyan('ac')}(화면) 또는 ${c.cyan('ac ps')}로 보세요.`);
  } else say(c.dim('확정하지 않았습니다. 나중에 `ac approve`나 웹에서 확정할 수 있습니다.'));
}

async function waitDrafted(client: Client, id: string): Promise<CeoRequest> {
  const frames = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
  let i = 0;
  const started = Date.now();
  for (;;) {
    const r = (await client.get<CliState>('state')).requests.find((x) => x.id === id);
    if (!r) fail('요청을 찾을 수 없습니다.');
    if (r!.status !== 'drafting') {
      if (process.stdout.isTTY) process.stdout.write('\r\x1b[K');
      return r!;
    }
    if (process.stdout.isTTY)
      process.stdout.write(`\r${c.cyan(frames[i++ % frames.length]!)} 초안 작성 중 ${Math.round((Date.now() - started) / 1000)}초`);
    await new Promise((res) => setTimeout(res, 1000));
  }
}

const DIFF: Record<string, string> = { easy: '쉬움', normal: '보통', hard: '어려움' };

function printDrafts(r: CeoRequest): void {
  say(c.bold(`\n${r.summary || '업무 초안'}`));
  for (const [i, d] of r.drafts.entries()) {
    const tags = [d.type, DIFF[d.difficulty] ?? d.difficulty, ...(d.contract ? [c.yellow('공유 계약')] : [])].join(' · ');
    say(
      `  ${c.bold(`${i + 1}.`)} ${d.title} ${c.dim(`(${tags})`)}${d.dependsOn.length ? c.dim(` ← ${d.dependsOn.map((x) => x + 1).join(', ')}`) : ''}`,
    );
    const mine = d.requirements.filter((q) => q.evidenceType === 'human_attest');
    if (mine.length) say(c.dim(`     👀 내가 확인할 것: ${mine.map((q) => q.text).join(' / ')}`));
  }
  if (r.questions.length) {
    say(c.bold('\n질문 (답하지 않으면 리드 제안대로)'));
    for (const [i, q] of r.questions.entries()) say(`  ? ${q}${r.proposals?.[i] ? c.dim(`  → 제안: ${r.proposals[i]}`) : ''}`);
  }
  if (r.acceptance?.length) {
    say(c.bold('\n다 끝나면 이렇게 확인합니다'));
    for (const a of r.acceptance) say(`  ✓ ${a.check}`);
  }
  say();
}

// ---------------- ps ----------------

function printTeam(s: CliState): void {
  const rows = teamRows(s);
  if (!rows.length) {
    say(c.dim('직원이 없습니다. `ac up`으로 팀을 고용하세요.'));
    return;
  }
  say(
    table([
      [c.dim('팀'), c.dim('AI'), c.dim('직급'), c.dim('지금')],
      ...rows.map((r) => [`${r.busy ? c.green('●') : c.gray('○')} ${r.name}`, r.cli, r.rank, r.busy ? r.doing : c.dim(r.doing)]),
    ]),
  );
}

async function ps(dataDir: string): Promise<void> {
  const client = await connect(dataDir);
  const s = await client.get<CliState>('state');
  if (s.paused) say(c.yellow('⏸ 회사가 일시정지 상태입니다.'));
  printTeam(s);
  const open = openTickets(s);
  say();
  if (open.length)
    say(
      table([
        [c.dim('업무'), c.dim('상태'), c.dim('담당'), c.dim('제목')],
        ...open.map((t) => [
          t.id,
          !t.hold
            ? statusLabel(t.status)
            : t.hold.reason === 'waiting_dependency'
              ? c.dim('앞 업무 대기')
              : c.yellow(`${statusLabel(t.status)}·멈춤`),
          nameOf(s, t.assigneeId),
          t.title,
        ]),
      ]),
    );
  else say(c.dim('진행 중인 업무가 없습니다.'));
  const todos = s.ceoTodos.length;
  say();
  say(todos ? c.yellow(`⚑ 대표 차례 ${todos}개 — ac approve 또는 ac`) : c.dim('대표가 할 일은 없습니다.'));
}

// ---------------- approve / reject ----------------

interface Pending {
  kind: 'approval' | 'draft';
  id: string;
  label: string;
  approval?: Approval;
  request?: CeoRequest;
}

/** 대표가 바로 결정할 수 있는 것: 승인 요청과 확정할 초안 */
export function pendingOf(s: CliState): Pending[] {
  const order = (a: Approval) => (a.kind === 'integrate_request' ? 0 : a.kind === 'integrate' ? 1 : 2);
  return [
    ...[...s.approvals]
      .sort((a, b) => order(a) - order(b))
      .map((a): Pending => ({ kind: 'approval', id: a.id, label: a.summary, approval: a })),
    ...s.requests
      .filter((r) => r.status === 'drafted')
      .map((r): Pending => ({ kind: 'draft', id: r.id, label: `초안 확정: ${r.text.split('\n')[0]!.slice(0, 80)}`, request: r })),
  ];
}

async function pick(client: Client, which: string | undefined): Promise<{ s: CliState; p: Pending } | null> {
  const s = await client.get<CliState>('state');
  const list = pendingOf(s);
  if (!list.length) {
    say(c.dim('대표가 결정할 것이 없습니다.'));
    return null;
  }
  if (which) {
    const n = Number(which);
    const p =
      Number.isInteger(n) && n >= 1 && n <= list.length ? list[n - 1] : list.find((x) => x.id === which || x.approval?.ticketId === which);
    return p ? { s, p } : fail(`없는 항목: ${which}`);
  }
  if (list.length === 1) return { s, p: list[0]! };
  for (const [i, x] of list.entries()) say(`  ${c.bold(`${i + 1}.`)} ${x.label}`);
  const a = await ask('번호: ');
  const p = list[Number(a) - 1];
  return p ? { s, p } : null;
}

async function approve(argv: string[], dataDir: string): Promise<void> {
  const { positionals, values } = parseArgs({ args: argv, allowPositionals: true, options: { branch: { type: 'boolean' } } });
  const client = await connect(dataDir);
  const got = await pick(client, positionals[0]);
  if (!got) return;
  const { s, p } = got;
  if (p.kind === 'draft') {
    printDrafts(p.request!);
    await client.post(`requests/${p.id}/accept`, {});
    say(`${c.green('✔')} 초안을 확정했습니다.`);
    return;
  }
  const a = p.approval!;
  const d = (a.detail ?? {}) as Record<string, unknown>;
  say(c.bold(a.summary));
  // 직접 확인 항목: 확인했으면 y, 지금 못 하면 나중에(할 일로 남는다)
  const checks: { key: string; text: string }[] =
    a.kind === 'integrate_request'
      ? ((d.checks as { ticketId: string; id: string; text: string }[]) ?? []).map((x) => ({
          key: `${x.ticketId}:${x.id}`,
          text: `${x.ticketId} ${x.text}`,
        }))
      : a.kind === 'integrate' && d.mode !== 'review'
        ? (s.tickets.find((t) => t.id === a.ticketId)?.requirements ?? [])
            .filter((r: Requirement) => r.evidenceType === 'human_attest')
            .map((r: Requirement) => ({ key: r.id, text: r.text }))
        : [];
  if (a.kind === 'integrate_request') {
    const acc = d.acceptance as { passed: number; total: number; left: string[] } | null;
    say(c.dim(`  바뀐 파일 ${(d.changedPaths as string[]).length}개`));
    if (acc) say(`  인수 시험 ${acc.passed}/${acc.total} 통과${acc.left.length ? c.yellow(` — 남은 것: ${acc.left.join(' / ')}`) : ''}`);
  }
  const attested: string[] = [];
  const deferred: string[] = [];
  for (const x of checks) {
    const ans = process.stdin.isTTY ? (await ask(`  👀 ${x.text}\n     확인했나요? [y]예 [l]나중에 확인 `)).toLowerCase() : 'l';
    (ans.startsWith('y') || ans === 'ㅇ' ? attested : deferred).push(x.key);
  }
  const mode = d.mode === 'auto_after_approval' && values.branch ? 'manual' : undefined;
  await client.post(`approvals/${a.id}/decide`, { decision: 'approved', attested, deferred, ...(mode ? { mode } : {}) });
  say(
    `${c.green('✔')} 승인했습니다.${a.kind === 'integrate_request' ? (d.mode === 'auto_after_approval' && !mode ? ' 내 폴더에 병합합니다.' : ` 브랜치 ac/${String(d.requestId)}로 보관합니다.`) : ''}`,
  );
}

async function reject(argv: string[], dataDir: string): Promise<void> {
  const { positionals } = parseArgs({ args: argv, allowPositionals: true });
  const client = await connect(dataDir);
  const got = await pick(client, positionals[0]);
  if (!got) return;
  const { p } = got;
  if (p.kind === 'draft') {
    await client.post(`requests/${p.id}/dismiss`, {});
    say(`${c.green('✔')} 초안을 버렸습니다.`);
    return;
  }
  const reason = positionals.slice(1).join(' ').trim() || (await ask('무엇을 고쳐야 하나요? '));
  if (!reason && p.approval!.kind !== 'tool_permission') fail('고칠 내용을 적어 주세요.');
  await client.post(`approvals/${p.id}/decide`, { decision: 'rejected', reason });
  say(`${c.green('✔')} 반려했습니다.${p.approval!.kind === 'integrate_request' ? ' 이 내용으로 고칠 업무를 만들었습니다.' : ''}`);
}

// ---------------- team / down / open ----------------

async function team(argv: string[], dataDir: string): Promise<void> {
  const [sub, file] = argv;
  if (sub === 'export') {
    const client = await connect(dataDir);
    const s = await client.get<CliState>('state');
    const yaml = exportTeam('my-team', s.employees);
    if (file) {
      writeFileSync(file, yaml, 'utf8');
      say(`${c.green('✔')} ${file}에 저장했습니다. 다른 곳에서: ac up ${file}`);
    } else process.stdout.write(yaml);
    return;
  }
  say(c.bold('내장 팀') + c.dim('  (ac up <이름> 또는 ac up 내팀.yaml)'));
  for (const t of builtInTeams())
    say(`  ${c.cyan(t.name.padEnd(9))} ${t.description} ${c.dim(`— ${t.seats.map((x) => x.name).join(', ')}`)}`);
  say(c.dim('\n지금 팀을 파일로: ac team export 내팀.yaml'));
}

async function down(dataDir: string): Promise<void> {
  const { findDaemon } = await import('./client.ts');
  const d = findDaemon(dataDir);
  if (!d) {
    say(c.dim('꺼져 있습니다.'));
    return;
  }
  await new Client(d).post('shutdown', {});
  say(`${c.green('✔')} 회사를 껐습니다. 진행 중인 직원 실행은 계속되고 다음에 켤 때 이어받습니다.`);
}

export async function runAc(cmd: (typeof AC_COMMANDS)[number], argv: string[], dataDir: string, extra: string[] = []): Promise<void> {
  daemonArgs = extra;
  try {
    switch (cmd) {
      case 'up':
        return await up(argv, dataDir);
      case 'ask':
        return await askLead(argv, dataDir);
      case 'ps':
        return await ps(dataDir);
      case 'approve':
        return await approve(argv, dataDir);
      case 'reject':
        return await reject(argv, dataDir);
      case 'down':
        return await down(dataDir);
      case 'open': {
        const client = await connect(dataDir);
        openUrl(client.dashboard);
        say(c.dim(client.daemon.base));
        return;
      }
      case 'team':
        return await team(argv, dataDir);
    }
  } catch (e) {
    console.error(`${c.red('✖')} ${(e as Error).message}`);
    process.exitCode = 1;
  }
}

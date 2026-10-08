// `aco` 터미널 화면: 팀 · 진행 · 대표 차례 · 리드에게 말하기를 한 화면에.
// 그리기(render)는 상태만 받아 줄을 만드는 순수 함수이고, 키 입력·새로 고침은 runTui가 한다. 의존성 없음(ANSI).
import type { CeoTodo } from '../app/notify.ts';
import { Client, ensureDaemon } from './client.ts';
import { openUrl, pendingOf } from './ac.ts';
import { c, fit, pad, width } from './term.ts';
import { feed, hhmm, projectFor, projectOfItem, statusLabel, teamRows, type CliState } from './view.ts';

/** 대표 차례 한 줄: 여기서 바로 할 수 있는 것(act)과 웹에서 할 것 */
export interface TodoItem {
  label: string;
  why: string;
  act:
    | { kind: 'approval'; id: string; checks: string[]; warn: string[]; request: boolean; text: string[] }
    | { kind: 'draft'; id: string; text: string[] }
    | { kind: 'scope'; ticketId: string }
    | { kind: 'release'; ticketId: string }
    | { kind: 'reverify'; ticketId: string }
    | { kind: 'web' };
}

export interface Model {
  s: CliState | null;
  project: string | null;
  /** 지금 폴더의 프로젝트: 대표 차례는 이 프로젝트의 것만(없으면 회사 전체 알림만) */
  projectId?: string | null;
  sel: number;
  mode: 'normal' | 'input' | 'reason' | 'confirm-checks';
  input: string;
  detail: boolean;
  msg: string;
  error: string;
  /** 확인·사유 입력 중인 승인: 누른 순간의 항목을 붙잡아 둔다(그사이 목록이 바뀌어도 다른 승인에 적용하지 않게). */
  target?: { approvalId: string; label: string; checks: string[]; warn: string[]; request: boolean } | null;
}

export function todoItems(s: CliState, projectId: string | null): TodoItem[] {
  const out: TodoItem[] = [];
  // 다른 프로젝트의 승인·초안은 여기서 처리하지 않는다(그 폴더에서 열거나 aco approve --all)
  for (const p of projectId ? pendingOf(s, projectId) : []) {
    if (p.kind === 'draft') {
      const r = p.request!;
      out.push({
        label: p.label,
        why: `업무 ${r.drafts.length}개${r.questions.length ? ` · 질문 ${r.questions.length}개(답 없으면 제안대로)` : ''}`,
        act: {
          kind: 'draft',
          id: r.id,
          text: [
            r.summary || r.text,
            ...r.drafts.map((d, i) => `${i + 1}. ${d.title}${d.contract ? ' [공유 계약]' : ''}`),
            ...r.questions.map((q, i) => `? ${q}${r.proposals?.[i] ? ` → ${r.proposals[i]}` : ''}`),
          ],
        },
      });
      continue;
    }
    const a = p.approval!;
    const d = (a.detail ?? {}) as Record<string, unknown>;
    const req = a.kind === 'integrate_request';
    const checks = req
      ? ((d.checks as { ticketId: string; id: string; text: string }[]) ?? []).map((x) => `${x.ticketId}:${x.id}`)
      : a.kind === 'integrate' && d.mode !== 'review'
        ? (s.tickets.find((t) => t.id === a.ticketId)?.requirements ?? []).filter((r) => r.evidenceType === 'human_attest').map((r) => r.id)
        : [];
    const acc = d.acceptance as { passed: number; total: number; left: string[] } | null | undefined;
    // 끝나지 않은 업무·남은 인수 시험: 줄에도 보이고, 승인 전에 한 번 더 확인한다(자세히를 열지 않아도)
    const notDone = (d.notDone as string[] | undefined) ?? [];
    const warn = [
      ...(notDone.length ? [`끝나지 않은 업무 ${notDone.length}개`] : []),
      ...(acc?.left.length ? [`남은 인수 시험 ${acc.left.length}개`] : []),
    ];
    out.push({
      label: warn.length ? `⚠ ${a.summary}` : a.summary,
      why: req
        ? warn.length
          ? `${warn.join(' · ')} — Enter로 확인`
          : '요청 결과물 완성 · 승인하면 한 번에 반영'
        : a.kind === 'tool_permission'
          ? `권한 요청: ${String(d.tool ?? '')}`
          : '검수 통과 · 승인하면 반영',
      act: {
        kind: 'approval',
        id: a.id,
        checks,
        warn,
        request: req,
        text: req
          ? [
              String(d.text ?? ''),
              `업무: ${((d.tickets as { id: string; title: string }[]) ?? []).map((t) => `${t.id} ${t.title}`).join(' · ')}`,
              `바뀐 파일 ${((d.changedPaths as string[]) ?? []).length}개`,
              ...((d.notDone as string[] | undefined) ?? []).map((x) => `⚠ 끝나지 않은 업무(결과물에 없음): ${x}`),
              ...(acc ? [`인수 시험 ${acc.passed}/${acc.total} 통과${acc.left.length ? ` — 남은 것: ${acc.left.join(' / ')}` : ''}`] : []),
              ...((d.checks as { ticketId: string; text: string }[]) ?? []).map((x) => `👀 직접 확인: ${x.ticketId} ${x.text}`),
            ]
          : [a.summary, String(d.summary ?? '')].filter(Boolean),
      },
    });
  }
  // 그 밖의 대표 차례(멈춘 업무 등): 허락·재개·다시 검사는 여기서, 나머지는 웹에서
  for (const t of s.ceoTodos.filter(
    // 업무에 딸린 일은 이 프로젝트 것만. 소속을 모르면(null) 여기서는 처리하지 않는다(웹에서)
    (x: CeoTodo) =>
      x.kind !== 'approval' && x.kind !== 'draft' && (!x.ticketId || (projectId !== null && projectOfItem(s, x) === projectId)),
  )) {
    const tid = t.ticketId ?? '';
    const act: TodoItem['act'] =
      t.action?.kind === 'allow' && tid
        ? { kind: 'scope', ticketId: tid }
        : t.action?.kind === 'release' && tid
          ? { kind: 'release', ticketId: tid }
          : t.action?.kind === 'reverify' && tid
            ? { kind: 'reverify', ticketId: tid }
            : { kind: 'web' };
    out.push({ label: t.title, why: t.reason ?? '', act });
  }
  return out;
}

const KEYS: Record<TodoItem['act']['kind'], string> = {
  approval: '[a]승인 [r]반려',
  draft: '[a]확정 [r]버리기',
  scope: '[a]허락 [r]되돌리게',
  release: '[a]재개',
  reverify: '[a]다시 검사',
  web: '[o]웹에서',
};

/** 화면 한 장(W×H). 각 줄은 정확히 W칸. */
export function render(m: Model, W: number, H: number): string[] {
  const lines: string[] = [];
  const s = m.s;
  const status = !s ? c.dim('연결 중…') : s.paused ? c.yellow('⏸ 일시정지') : c.green('● 실행 중');
  const title = ` Agent Company${m.project ? ` · ${m.project}` : ''}`;
  const right = `${s?.delegation.on ? c.magenta('위임 ') : ''}${status} `;
  lines.push(c.inverse(pad(title, W - width(right))) + right);

  const todos = s ? todoItems(s, m.projectId ?? null) : [];
  const sel = Math.min(m.sel, Math.max(0, todos.length - 1));
  const todoRows = Math.min(Math.max(todos.length, 1), 5);
  const bottom = 1 /* 구분 */ + 1 /* 제목 */ + todoRows + 1 /* 구분 */ + 1 /* 입력 */ + 1; /* 도움말 */
  const bodyH = Math.max(3, H - 1 - bottom);
  // 좁은 창(60칸 미만)에서는 팀 칸을 접고 진행만 보인다(줄이 넘쳐 화면이 깨지지 않게)
  const twoCols = W >= 60;
  const leftW = twoCols ? Math.min(36, Math.max(24, Math.floor(W * 0.32))) : 0;
  const rightW = twoCols ? W - leftW - 3 : W;

  // 왼쪽: 팀
  const team = s ? teamRows(s, m.projectId ?? null) : [];
  const left: string[] = [c.bold('팀')];
  if (s && !team.length) left.push(c.dim('직원 없음 — q로 나가서 aco up'));
  for (const r of team) {
    left.push(`${r.busy ? c.green('●') : c.gray('○')} ${r.name} ${c.dim(r.cli)}`);
    left.push(`  ${r.busy ? c.cyan(r.doing) : c.dim(r.doing)}`);
  }
  // 업무는 지금 폴더의 프로젝트 것만. 다른 프로젝트에서 도는 일은 개수만 알린다(QA 뒤 사용자 보고: "pubg로 들어가졌다")
  const unfinished = s ? s.tickets.filter((t) => !['done', 'cancelled', 'failed'].includes(t.status)) : [];
  const open = unfinished.filter((t) => t.projectId === (m.projectId ?? null));
  const elsewhere = unfinished.length - open.length;
  if (open.length) {
    left.push('', c.bold('업무'));
    for (const t of open) {
      const waiting = t.hold?.reason === 'waiting_dependency';
      const st = waiting ? '앞 업무 대기' : statusLabel(t.status);
      left.push(`${t.hold && !waiting ? c.yellow('!') : ' '}${t.id} ${c.dim(st)} ${t.title}`);
    }
  }
  if (elsewhere) left.push('', c.dim(`다른 프로젝트에서 ${elsewhere}개 진행 중`));

  // 오른쪽: 진행(또는 고른 항목 자세히)
  const right2: string[] = [];
  const item = todos[sel];
  if (m.detail && item) {
    right2.push(c.bold('자세히'));
    const text = 'text' in item.act ? item.act.text : [item.label, item.why];
    for (const t of text) for (const part of wrap(t, rightW)) right2.push(part);
  } else {
    right2.push(c.bold('진행'));
    if (s && !m.project) right2.push(c.yellow('이 폴더는 아직 프로젝트가 아닙니다. q로 나가서 `aco up`을 실행하세요.'));
    const f = s ? feed(s, bodyH - 1, m.projectId ?? null) : [];
    if (s && !f.length && m.project) right2.push(c.dim('아직 기록이 없습니다. 아래에서 리드에게 만들고 싶은 것을 말해 보세요.'));
    for (const x of f) right2.push(`${c.gray(hhmm(x.at))} ${x.text}`);
  }
  const rightShown = m.detail ? right2.slice(0, bodyH) : [right2[0]!, ...right2.slice(1).slice(-(bodyH - 1))];
  for (let i = 0; i < bodyH; i++)
    lines.push(twoCols ? `${pad(left[i] ?? '', leftW)} ${c.gray('│')} ${pad(rightShown[i] ?? '', rightW)}` : pad(rightShown[i] ?? '', W));

  // 대표 차례
  lines.push(c.gray('─'.repeat(W)));
  const keys = item ? `${KEYS[item.act.kind]} [Enter]자세히${item.act.kind === 'web' ? '' : ' [o]웹'}` : '';
  lines.push(pad(`${todos.length ? c.yellow(`⚑ 대표 차례 (${todos.length})`) : c.dim('대표 차례 없음')}  ${c.dim(keys)}`, W));
  const start = Math.max(0, Math.min(sel - todoRows + 1, todos.length - todoRows));
  for (let i = 0; i < todoRows; i++) {
    const t = todos[start + i];
    if (!t) {
      lines.push(pad(c.dim('  지금 대표가 할 일은 없습니다.'), W));
      continue;
    }
    const mark = start + i === sel ? c.cyan('▶') : ' ';
    const body = `${mark} ${t.label}  ${c.dim(t.why)}`;
    lines.push(pad(start + i === sel ? c.bold(fit(body, W)) : body, W));
  }
  lines.push(c.gray('─'.repeat(W)));

  // 입력 줄
  if (m.mode === 'input') lines.push(pad(`${c.cyan('리드에게 >')} ${m.input}${c.inverse(' ')}`, W));
  else if (m.mode === 'reason')
    lines.push(pad(`${c.yellow(`반려(${m.target?.label ?? ''}) — 무엇을 고쳐야 하나요? >`)} ${m.input}${c.inverse(' ')}`, W));
  else if (m.mode === 'confirm-checks')
    lines.push(
      pad(
        c.yellow(
          m.target?.checks.length
            ? `승인 — ${m.target.warn.length ? `⚠ ${m.target.warn.join(', ')} · ` : ''}직접 확인: [y] 모두 확인했음  [l] 나중에 확인  [Esc] 취소`
            : `승인 — ⚠ ${m.target?.warn.join(', ') ?? ''}. 그래도 승인할까요? [y] 승인  [Esc] 취소`,
        ),
        W,
      ),
    );
  else lines.push(pad(m.error ? c.red(`✖ ${m.error}`) : m.msg ? c.green(m.msg) : c.dim('[i] 리드에게 말하기'), W));
  lines.push(pad(c.dim(' ↑↓ 고르기 · i 말하기 · a 승인 · r 반려 · Enter 자세히 · o 웹 · q 종료'), W));
  return lines.slice(0, H);
}

/** 화면 폭에 맞춰 줄바꿈(한글 두 칸 고려) */
export function wrap(text: string, w: number): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    let cur = '';
    for (const ch of para) {
      if (width(cur + ch) > w) {
        out.push(cur);
        cur = '';
      }
      cur += ch;
    }
    out.push(cur);
  }
  return out;
}

/** TUI가 쓰는 입출력(테스트는 가짜를 넘긴다) */
export interface TuiIo {
  stdin: Pick<NodeJS.ReadStream, 'isTTY' | 'setRawMode' | 'setEncoding' | 'pause' | 'on'>;
  stdout: Pick<NodeJS.WriteStream, 'isTTY' | 'columns' | 'rows' | 'write' | 'on'>;
  /** 새로 고침 간격(ms) */
  refreshMs?: number;
  cwd?: string;
}

export async function runTui(
  dataDir: string,
  daemonArgs: string[] = [],
  io: TuiIo = { stdin: process.stdin, stdout: process.stdout },
): Promise<void> {
  const cwd = io.cwd ?? process.cwd();
  if (!io.stdin.isTTY || !io.stdout.isTTY) {
    console.log('터미널 화면은 대화형 터미널에서만 열립니다. `aco ps`를 쓰세요.');
    return;
  }
  const { daemon } = await ensureDaemon(dataDir, daemonArgs);
  const client = new Client(daemon);
  const m: Model = { s: null, project: null, sel: 0, mode: 'normal', input: '', detail: false, msg: '', error: '' };
  const out = io.stdout;
  const draw = () => {
    const rows = render(m, out.columns || 100, out.rows || 30);
    out.write(`\x1b[H${rows.join('\r\n')}\x1b[J`);
  };
  const flash = (msg: string, error = false) => {
    m.msg = error ? '' : msg;
    m.error = error ? msg : '';
    draw();
  };
  const refresh = async () => {
    try {
      m.s = await client.get<CliState>('state');
      const p = projectFor(m.s, cwd);
      m.project = p?.name ?? null;
      m.projectId = p?.id ?? null;
      m.error = m.error.startsWith('연결') ? '' : m.error;
    } catch (e) {
      m.error = `연결 끊김: ${(e as Error).message}`;
    }
    draw();
  };
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      flash(ok);
    } catch (e) {
      flash((e as Error).message, true);
    }
    await refresh();
  };
  const current = () => (m.s ? todoItems(m.s, m.projectId ?? null)[m.sel] : undefined);
  /** 붙잡아 둔 승인이 아직 기다리는 중인지(아니면 취소) */
  const takeTarget = () => {
    const t = m.target ?? null;
    m.target = null;
    if (!t || !m.s?.approvals.some((a) => a.id === t.approvalId)) {
      flash('그사이 목록이 바뀌어 취소했습니다. 다시 골라 주세요.', true);
      return null;
    }
    return t;
  };

  out.write('\x1b[?1049h\x1b[?25l');
  io.stdin.setRawMode(true);
  io.stdin.setEncoding('utf8');
  const timer = setInterval(() => void refresh(), io.refreshMs ?? 1500);
  let quit: () => void = () => {};
  const done = new Promise<void>((r) => (quit = r));
  const cleanup = () => {
    clearInterval(timer);
    io.stdin.setRawMode(false);
    io.stdin.pause();
    out.write('\x1b[?25h\x1b[?1049l');
  };
  out.on('resize', draw);

  io.stdin.on('data', (key: string) => {
    const item = current();
    if (key === '\x03') return quit();
    if (m.mode === 'input' || m.mode === 'reason') {
      if (key === '\x1b') {
        m.mode = 'normal';
        m.input = '';
        m.target = null;
      } else if (key === '\r' || key === '\n') {
        const text = m.input.trim();
        const mode = m.mode;
        m.mode = 'normal';
        m.input = '';
        if (!text) return draw();
        if (mode === 'input') {
          const project = m.s ? projectFor(m.s, cwd) : null;
          if (!project) return flash('이 폴더의 프로젝트가 없습니다. `aco up` 먼저.', true);
          void act(
            () => client.post('requests', { projectId: project.id, text }),
            '리드에게 보냈습니다. 초안이 나오면 대표 차례에 뜹니다.',
          );
        } else {
          const t = takeTarget();
          if (!t) return;
          void act(
            () => client.post(`approvals/${t.approvalId}/decide`, { decision: 'rejected', reason: text }),
            t.request ? '반려했습니다. 고칠 업무를 만들었습니다.' : '반려했습니다.',
          );
        }
        return;
      } else if (key === '\x7f' || key === '\b') m.input = [...m.input].slice(0, -1).join('');
      else if (!key.startsWith('\x1b')) m.input += key.replace(/[\r\n\t]/g, ' ');
      return draw();
    }
    if (m.mode === 'confirm-checks') {
      m.mode = 'normal';
      const later = (key === 'l' || key === 'ㅣ') && Boolean(m.target?.checks.length);
      if (key === 'y' || key === 'ㅛ' || later) {
        const t = takeTarget();
        if (!t) return;
        const all = key === 'l' || key === 'ㅣ' ? { deferred: t.checks } : { attested: t.checks };
        void act(() => client.post(`approvals/${t.approvalId}/decide`, { decision: 'approved', ...all }), '승인했습니다.');
        return;
      }
      m.target = null;
      return draw();
    }
    const n = m.s ? todoItems(m.s, m.projectId ?? null).length : 0;
    switch (key) {
      case 'q':
      case 'ㅂ':
        return quit();
      case '\x1b[A':
      case 'k':
        m.sel = Math.max(0, m.sel - 1);
        return draw();
      case '\x1b[B':
      case 'j':
        m.sel = Math.min(Math.max(0, n - 1), m.sel + 1);
        return draw();
      case '\r':
        m.detail = !m.detail;
        return draw();
      case '\x1b':
        m.detail = false;
        return draw();
      case 'i':
      case '/':
      case '\t':
      case 'ㅑ':
        m.mode = 'input';
        m.msg = m.error = '';
        return draw();
      case 'o':
      case 'ㅐ':
        openUrl(client.dashboard);
        return flash('웹 화면을 열었습니다.');
      case 'a':
      case 'ㅁ':
        if (!item) return;
        if (item.act.kind === 'approval') {
          const a = item.act;
          if (a.checks.length || a.warn.length) {
            m.target = { approvalId: a.id, label: item.label, checks: a.checks, warn: a.warn, request: a.request };
            m.mode = 'confirm-checks';
            return draw();
          }
          return void act(() => client.post(`approvals/${a.id}/decide`, { decision: 'approved' }), '승인했습니다.');
        }
        if (item.act.kind === 'draft') {
          const id = item.act.id;
          return void act(() => client.post(`requests/${id}/accept`, {}), '초안을 확정했습니다. 일을 시작합니다.');
        }
        if (item.act.kind === 'scope') {
          const id = item.act.ticketId;
          return void act(() => client.post(`tickets/${id}/scope`, { allow: true }), '허락했습니다.');
        }
        if (item.act.kind === 'release') {
          const id = item.act.ticketId;
          return void act(() => client.post(`tickets/${id}/release`, {}), '다시 시작합니다.');
        }
        if (item.act.kind === 'reverify') {
          const id = item.act.ticketId;
          return void act(() => client.post(`tickets/${id}/reverify`, {}), '다시 검사합니다.');
        }
        return flash('이 항목은 웹에서 처리하세요: o', true);
      case 'r':
      case 'ㄱ':
        if (!item) return;
        if (item.act.kind === 'approval') {
          m.target = {
            approvalId: item.act.id,
            label: item.label,
            checks: item.act.checks,
            warn: item.act.warn,
            request: item.act.request,
          };
          m.mode = 'reason';
          return draw();
        }
        if (item.act.kind === 'draft') {
          const id = item.act.id;
          return void act(() => client.post(`requests/${id}/dismiss`, {}), '초안을 버렸습니다.');
        }
        if (item.act.kind === 'scope') {
          const id = item.act.ticketId;
          return void act(() => client.post(`tickets/${id}/scope`, { allow: false }), '되돌리게 했습니다.');
        }
        return;
    }
  });

  await refresh();
  await done;
  cleanup();
}

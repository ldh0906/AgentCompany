// 고급 QA(직접 플레이): QA 직원이 보이지 않는 크롬을 play 명령으로 조종하며 직접 해 본다(play.ts).
// orchestrator.ts에서 떼어 냄(2026-10-01: 3500줄이 넘어 기능별로 나눔).
import { tr } from '../core/i18n.ts';

import { randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPlaytestPrompt } from '../agents/prompt.ts';
import type { Ticket } from '../core/types.ts';
import { DEFAULT_BUDGET } from '../core/types.ts';
import { verdictsOf } from '../core/verdicts.ts';
import { DomainError } from './company.ts';
import type { OrchHost } from './orch-host.ts';
import { MAX_STEPS, stopPlay } from './play.ts';
import type { RunRecord } from './records.ts';
import { findChrome } from './screen-check.ts';

/** 고급 QA(직접 플레이) 기록(설정 playtest:<업무 ID 또는 Q:요청 ID>). */
export interface PlaytestInfo {
  state: 'running' | 'done' | 'failed';
  at: string;
  by: 'ceo' | 'auto';
  qaBy: string;
  dir: string;
  url: string;
  runId: string | null;
  opinion: string | null;
  note: string;
}

export class Playtests {
  private readonly h: OrchHost;

  constructor(host: OrchHost) {
    this.h = host;
  }

  private readonly playtestNonces = new Map<string, string>();

  playtestOf(key: string): PlaytestInfo | null {
    const raw = this.h.company.store.getSetting(`playtest:${key}`);
    return raw ? (JSON.parse(raw) as PlaytestInfo) : null;
  }

  private savePlaytest(key: string, p: PlaytestInfo): void {
    this.h.company.store.setSetting(`playtest:${key}`, JSON.stringify(p));
    this.h.changed('playtest', key);
  }

  /**
   * 고급 QA: Claude QA 직원이 보이지 않는 크롬을 명령으로 조종하며 직접 플레이한다(대표 요청, 2026-09-30).
   * 업무 하나(제출물)를 볼 수도, 요청 하나가 끝난 뒤 기준 브랜치 전체를 볼 수도 있다. 한 번에 약 300만~700만 토큰(실측 637만, 56번 조작).
   */
  async startPlaytest(scope: { ticketId?: string; requestId?: string }, by: 'ceo' | 'auto'): Promise<PlaytestInfo> {
    const ticket = scope.ticketId ? this.h.company.requireTicket(scope.ticketId) : null;
    const req = scope.requestId ? this.h.records.request(scope.requestId) : null;
    if (!ticket && !req) throw new DomainError(tr('무엇을 플레이할지 정해 주세요.', 'Choose what to play-test.'));
    const key = ticket ? ticket.id : `Q:${req!.id}`;
    if (this.playtestOf(key)?.state === 'running') throw new DomainError(tr('이미 플레이 중입니다.', 'Already playing.'));
    const project = this.h.company.requireProject(ticket?.projectId ?? req!.projectId);
    // 사진을 보며 명령을 쓸 수 있는 Claude만(fake는 테스트용)
    const pool = this.h.company
      .employees()
      .filter((e) => e.active && !e.removedAt && (e.cli === 'claude' || e.cli === 'fake') && e.id !== ticket?.assigneeId);
    const qa = pool.find((e) => e.roles.includes('qa')) ?? pool[0];
    if (!qa)
      throw new DomainError(tr('고급 QA는 화면을 볼 수 있는 Claude 직원이 필요합니다.', 'Play tests need an active Claude employee.'));
    if (!findChrome()) throw new DomainError(tr('크롬이 없어 플레이할 수 없습니다.', 'Chrome not found.'));
    const info = await this.h.preview(project.id, ticket?.id ?? null);
    if (!info.url) throw new DomainError(tr('결과물을 띄우지 못했습니다.', 'Could not start the build.'));
    const dir = path.join(this.h.dataDir, 'playtests', key.replace(':', '_'), String(Date.now()));
    await mkdir(dir, { recursive: true });
    // QA는 이 폴더의 ./play 한 가지 명령만 쓸 수 있다(경로·공백 문제 없이 허용 목록에 넣으려고).
    // 이 앱의 CLI(소스로 떠 있으면 main.ts, 빌드본이면 main.js)
    const cli = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? '../cli/main.ts' : '../cli/main.js', import.meta.url));
    await writeFile(
      path.join(dir, 'play'),
      `#!/bin/sh\nexec "${process.execPath.replaceAll('\\', '/')}" "${cli.replaceAll('\\', '/')}" play --dir "${dir.replaceAll('\\', '/')}" --url "${info.url}" "$@"\n`,
      { mode: 0o755 },
    );
    const tickets = ticket
      ? [ticket]
      : req!.ticketIds.map((id) => this.h.company.store.get<Ticket>('tickets', id)).filter((x): x is Ticket => Boolean(x));
    const goals = ticket
      ? ticket.requirements.map((r) => ({ id: r.id, text: r.text }))
      : [{ id: 'R1', text: req!.text.slice(0, 1500) }, ...tickets.map((t, n) => ({ id: `R${n + 2}`, text: `${t.title}: ${t.purpose}` }))];
    const hints = tickets.flatMap((t) => {
      const r = this.h.records.latestSubmission(t)?.report;
      return r?.kind === 'work' ? r.requirements.filter((x) => x.notes).map((x) => `${t.id} ${x.id}: ${x.notes.slice(0, 600)}`) : [];
    });
    const nonce = randomBytes(6).toString('hex');
    this.playtestNonces.set(nonce, key);
    const room = ticket ? this.h.chat.ensureTicketChannel(ticket.id) : (this.h.chat.ensureGeneral(), this.h.chat.channel('general'));
    const prompt = buildPlaytestPrompt({
      employee: qa,
      goals,
      subject: ticket
        ? `${ticket.id} ${ticket.title}`
        : tr(`요청 "${req!.text.slice(0, 80)}" 전체`, `the whole request "${req!.text.slice(0, 80)}"`),
      profile: project.profile,
      hints: hints.slice(0, 12),
      maxActions: MAX_STEPS,
      // 실측(2026-10-01, 메이플 5차): 대표가 "퀘스트 창은 J 유지"로 정했는데, 요청 원문의 "Q키"대로 확인해 ⚠를 줬다.
      decisions: this.h.records.decisions(project.id, 'current').map((d) => `- ${d.text}`),
      nonce,
      language: this.h.language,
    });
    const record: PlaytestInfo = {
      state: 'running',
      at: new Date().toISOString(),
      by,
      qaBy: qa.id,
      dir,
      url: info.url,
      runId: null,
      opinion: null,
      note: '',
    };
    this.savePlaytest(key, record);
    const runId = await this.h.launchChat({
      ticket: { id: room!.id, round: 1, budget: { ...DEFAULT_BUDGET, runTimeoutMs: 30 * 60_000 } },
      employee: { ...qa, allowedCommands: [['./play']] },
      kind: 'chat',
      cwd: dir,
      prompt,
      nonce,
      accessLevel: 'write-allowlist',
      baseSha: null,
    });
    const now = this.playtestOf(key);
    if (now?.state === 'running') this.savePlaytest(key, { ...now, runId });
    this.h.chat.post(
      room!.id,
      'system',
      tr(
        `🎮 고급 QA: ${qa.name}이(가) ${ticket ? ticket.id : '이번 요청 결과'}를 직접 플레이해 봅니다(${by === 'auto' ? '자동' : '대표 요청'}).`,
        `🎮 Play test: ${qa.name} is playing ${ticket ? ticket.id : 'the finished request'}.`,
      ),
      'event',
    );
    return this.playtestOf(key)!;
  }

  /** 플레이 실행이 끝나면: 결과를 기록하고, 크롬 세션을 닫고, 대표에게 알린다. */
  async finishPlaytest(run: RunRecord, reply: string | null, errorText: string): Promise<void> {
    const key = this.playtestNonces.get(run.nonce) ?? this.findPlaytestByRun(run.id);
    if (!key) return;
    this.playtestNonces.delete(run.nonce);
    const p = this.playtestOf(key);
    if (!p) return;
    await stopPlay(p.dir).catch(() => {});
    const done: PlaytestInfo = reply
      ? { ...p, state: 'done', runId: run.id, opinion: reply }
      : { ...p, state: 'failed', runId: run.id, note: errorText.slice(0, 500) };
    this.savePlaytest(key, done);
    const v = reply ? verdictsOf(reply) : [];
    const counts = `✅${v.filter((x) => x.mark === '✅').length} ⚠${v.filter((x) => x.mark === '⚠').length} ❓${v.filter((x) => x.mark === '❓').length}`;
    this.h.notice(
      reply
        ? tr(`고급 QA 결과 (${key}): ${counts}`, `Play test result (${key}): ${counts}`)
        : tr(`고급 QA 실패 (${key})`, `Play test failed (${key})`),
      reply
        ? v
            .filter((x) => x.mark !== '✅')
            .map((x) => `${x.id} ${x.mark} ${x.line}`)
            .join(' / ') || tr('문제 없음', 'No problems')
        : errorText.slice(0, 200),
      key.startsWith('Q:') ? '/' : `/tickets/${key}`,
    );
  }

  private findPlaytestByRun(runId: string): string | null {
    for (const t of this.h.company.tickets()) if (this.playtestOf(t.id)?.runId === runId) return t.id;
    for (const r of this.h.records.requests(50)) if (this.playtestOf(`Q:${r.id}`)?.runId === runId) return `Q:${r.id}`;
    return null;
  }

  /** 플레이 사진(마지막 몇 장): 누를 때만 불러온다. */
  async playtestShots(key: string, limit = 8): Promise<{ name: string; dataUrl: string }[]> {
    const p = this.playtestOf(key);
    if (!p) return [];
    const dir = path.join(p.dir, 'shots');
    const names = (await readdir(dir).catch(() => [] as string[]))
      .filter((f) => f.endsWith('.jpg'))
      .sort()
      .slice(-limit);
    const out: { name: string; dataUrl: string }[] = [];
    for (const n of names) {
      const buf = await readFile(path.join(dir, n)).catch(() => null);
      if (buf) out.push({ name: n, dataUrl: `data:image/jpeg;base64,${buf.toString('base64')}` });
    }
    return out;
  }
}

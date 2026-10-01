// 자동 화면 점검: 승인 대기 제출물을 띄워 찍고(screen-check.ts), 화면 QA 직원 의견을 받고, 문제면 자동으로 돌려보낸다.
// orchestrator.ts에서 떼어 냄(2026-10-01: 3500줄이 넘어 기능별로 나눔).
import { tr } from '../core/i18n.ts';

import { randomBytes } from 'node:crypto';
import { readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { buildScreenCheckPrompt } from '../agents/prompt.ts';
import { extractLastJson, screenStepsOf } from '../agents/report.ts';
import type { Employee, Project, Ticket } from '../core/types.ts';
import { DEFAULT_BUDGET, TERMINAL_STATUSES, deliverableOf } from '../core/types.ts';
import { verdictsOf } from '../core/verdicts.ts';
import { ticketChannelId } from './chat.ts';
import { DomainError } from './company.ts';
import type { OrchHost } from './orch-host.ts';
import type { RunRecord } from './records.ts';
import { captureScreens, findChrome, type DownloadedFile, type ScreenClip } from './screen-check.ts';

export interface ScreenQaHost extends OrchHost {
  readonly screenCheckOn: boolean;
  nameOf(id: string): string;
  decideIntegration(approvalId: string, decision: 'rejected', opts: { reason: string; by: string }): unknown;
}

/** 자동 화면 점검 기록(설정 screen:<업무 ID>에 JSON으로 저장). */
export interface ScreenCheck {
  sha: string;
  state: 'running' | 'done' | 'failed';
  at: string;
  note: string;
  shots: { label: string; file: string }[];
  errors: string[];
  qaRunId: string | null;
  qaBy: string | null;
  /** 담당 직원이 남긴 점검 순서를 따랐는지(아니면 흔한 조작만) */
  scripted?: boolean;
  /** 조작 중 내려받은 파일과 인코딩 판정 */
  downloads?: DownloadedFile[];
  /** 확인 순서의 조작 직후 몇 초 녹화(사진 파일 목록) */
  clips?: ScreenClip[];
}

export class ScreenQa {
  private readonly h: ScreenQaHost;

  constructor(host: ScreenQaHost) {
    this.h = host;
  }

  private screenBusy = new Set<string>();
  /** 화면 QA 실행의 nonce → 업무 ID(의견이 저장보다 먼저 와도 알아보게) */
  private readonly screenQaNonces = new Map<string, string>();

  screenCheckOf(ticketId: string): ScreenCheck | null {
    const raw = this.h.company.store.getSetting(`screen:${ticketId}`);
    return raw ? (JSON.parse(raw) as ScreenCheck) : null;
  }

  private saveScreenCheck(ticketId: string, c: ScreenCheck): void {
    this.h.company.store.setSetting(`screen:${ticketId}`, JSON.stringify(c));
    this.h.changed('ticket', ticketId);
  }

  /** 승인 대기 업무에 대표 직접 확인 요구가 있으면, 이번 제출물로 한 번 화면을 찍고 QA 의견을 받는다. */
  maybeScreenCheck(t: Ticket): void {
    if (!this.h.screenCheckOn || this.h.paused() || t.type === 'review' || t.hold) return;
    if (!t.requirements.some((r) => r.evidenceType === 'human_attest')) return;
    // 화면이 없는 결과물(문서·프로그램)은 찍을 화면이 없다.
    if (deliverableOf(this.h.company.store.get<Project>('projects', t.projectId)) !== 'screen') return;
    const sha = this.h.records.latestSubmission(t)?.headSha;
    if (!sha || this.screenBusy.has(t.id)) return;
    const prev = this.screenCheckOf(t.id);
    if (prev && prev.sha === sha && prev.state !== 'running') return; // running인데 busy가 아니면 재시작으로 끊긴 것: 다시 한다
    this.screenBusy.add(t.id);
    this.h.track(
      `screen:${t.id}`,
      this.screenCheck(t, sha)
        .catch((e: unknown) => {
          this.saveScreenCheck(t.id, { ...this.blankCheck(sha), state: 'failed', note: String((e as Error)?.message ?? e).slice(0, 500) });
        })
        .finally(() => this.screenBusy.delete(t.id)),
    );
  }

  private blankCheck(sha: string): ScreenCheck {
    return { sha, state: 'running', at: new Date().toISOString(), note: '', shots: [], errors: [], qaRunId: null, qaBy: null };
  }

  private async screenCheck(t: Ticket, sha: string): Promise<void> {
    const check = this.blankCheck(sha);
    const fail = (note: string) => this.saveScreenCheck(t.id, { ...check, state: 'failed', note });
    const chrome = findChrome();
    if (!chrome)
      return fail(
        tr(
          '크롬을 찾지 못해 자동 화면 점검을 건너뜁니다. 실행해 보기로 직접 확인해 주세요.',
          'Chrome not found, so the automatic screen check was skipped.',
        ),
      );
    this.saveScreenCheck(t.id, check);
    const info = await this.h.preview(t.projectId, t.id);
    if (!info.url)
      return fail(
        tr('결과물을 띄우지 못했습니다: ', 'Could not start the submission: ') +
          info.log.trim().split('\n').slice(-4).join(' ').slice(0, 400),
      );
    const outDir = path.join(this.h.dataDir, 'screens', t.id, sha.slice(0, 12));
    // 새 제출물을 찍으면 옛 제출물의 사진·녹화는 지운다(용량: 최신 것만 남긴다).
    for (const old of await readdir(path.dirname(outDir)).catch(() => [] as string[]))
      if (old !== path.basename(outDir)) await rm(path.join(path.dirname(outDir), old), { recursive: true, force: true }).catch(() => {});
    // 담당 직원이 남긴 점검 순서(대표 직접 확인 요구사항별)를 따라 한다. 없으면 흔한 조작만.
    const attestIds = new Set(t.requirements.filter((r) => r.evidenceType === 'human_attest').map((r) => r.id));
    // 저장된 보고서가 아니라 원문에서 다시 읽는다: 읽는 규칙이 나아지면 "다시 찍기"만으로 반영된다.
    const sub = this.h.records.latestSubmission(t);
    const raw = sub?.finalText ? (extractLastJson(sub.finalText) as Record<string, unknown> | null) : null;
    // 어느 요구사항인지 모르는 순서('*')는 확인할 요구사항이 하나면 그것으로, 아니면 "화면"으로 붙인다.
    const star = attestIds.size === 1 ? [...attestIds][0]! : tr('화면', 'screen');
    const scenarios = screenStepsOf(
      raw?.screenSteps,
      t.requirements.map((r) => r.id),
    )
      .map((x) => (x.requirementId === '*' ? { ...x, requirementId: star } : x))
      .filter((x) => attestIds.has(x.requirementId) || x.requirementId === star);
    const project = this.h.company.requireProject(t.projectId);
    const cap = await captureScreens(info.url, outDir, chrome, scenarios, { mobile: project.profile?.mobile ?? true });
    check.shots = cap.shots;
    check.errors = cap.errors;
    check.scripted = scenarios.length > 0;
    check.downloads = cap.downloads;
    check.clips = cap.clips;
    check.state = 'done';
    check.note = info.url;
    const room = this.h.chat.ensureTicketChannel(t.id);
    const qa = this.pickScreenQa(t);
    if (room)
      this.h.chat.post(
        room.id,
        'system',
        tr(
          `자동 화면 점검: 결과물을 띄워 ${cap.shots.length}장 찍었습니다(콘솔 오류 ${cap.errors.length}개).${qa ? ` ${qa.name}이(가) 화면을 보고 의견을 답니다.` : ''} 승인 카드에서 사진을 볼 수 있습니다.`,
          `Automatic screen check: ran the submission and took ${cap.shots.length} screenshots (${cap.errors.length} console errors).${qa ? ` ${qa.name} will comment.` : ''}`,
        ),
        'event',
      );
    if (qa && room) {
      const nonce = randomBytes(6).toString('hex');
      // 빠른 답이 check.qaRunId 저장보다 먼저 올 수 있다: nonce로 먼저 표시해 둔다.
      this.screenQaNonces.set(nonce, t.id);
      const prompt = buildScreenCheckPrompt({
        employee: qa,
        ticket: t,
        checks: t.requirements.filter((r) => r.evidenceType === 'human_attest').map((r) => ({ id: r.id, text: r.text })),
        // QA는 녹화에서 처음·가운데·끝 세 장만 본다(토큰 절약). 녹화 전체는 대표가 본다.
        shots: [
          ...cap.shots.map((s) => ({ file: path.basename(s.file), label: s.label })),
          ...cap.clips.flatMap((c) =>
            [...new Set([0, Math.floor((c.frames.length - 1) / 2), c.frames.length - 1])].map((i, n, all) => ({
              file: path.relative(outDir, c.frames[i]!).replaceAll('\\', '/'),
              label: tr(`${c.label} 움직임 ${n + 1}/${all.length} (녹화 중 한 장)`, `${c.label} motion ${n + 1}/${all.length}`),
            })),
          ),
        ],
        errors: cap.errors,
        pageText: cap.text,
        scenarios,
        profile: project.profile,
        downloads: cap.downloads.map((d) => `${d.name} (${d.size} bytes) — ${d.verdict}${d.text ? `\n${d.text.preview}` : ''}`),
        notes:
          sub?.report?.kind === 'work'
            ? sub.report.requirements.filter((r) => attestIds.has(r.id) && r.notes).map((r) => `${r.id}: ${r.notes.slice(0, 1500)}`)
            : [],
        nonce,
        language: this.h.language,
      });
      const runId = await this.h.launchChat({
        ticket: { id: room.id, round: 1, budget: { ...DEFAULT_BUDGET, runTimeoutMs: 10 * 60_000 } },
        employee: qa,
        kind: 'chat',
        cwd: outDir,
        prompt,
        nonce,
        accessLevel: 'read-only',
        baseSha: null,
      });
      check.qaRunId = runId;
      check.qaBy = qa.id;
    }
    this.saveScreenCheck(t.id, check);
  }

  /**
   * 화면 QA가 문제(⚠)를 찾으면 대표를 거치지 않고 담당자에게 바로 돌려보낸다(대표 요청: "QA가 바로 찔러버리게").
   * ❓(사진으로 판단 불가)는 돌려보내지 않는다. 업무당 2번까지만, 그다음은 대표에게 넘긴다.
   */
  maybeQaReject(ticketId: string, run: RunRecord, opinion: string): void {
    const c = this.screenCheckOf(ticketId);
    const t = this.h.company.store.get<Ticket>('tickets', ticketId);
    const isQa = this.screenQaNonces.get(run.nonce) === ticketId || c?.qaRunId === run.id;
    this.screenQaNonces.delete(run.nonce);
    if (!c || !isQa || !t || t.status !== 'awaiting_approval' || t.hold) return;
    const project = this.h.company.requireProject(t.projectId);
    if (project.qaAutoReject === false) return;
    const warns = verdictsOf(opinion).filter((v) => v.mark === '⚠' && !v.unsure);
    if (!warns.length) return;
    const a = this.h.records.pendingApprovalFor(t.id, 'integrate');
    if (!a || this.h.records.latestSubmission(t)?.headSha !== c.sha) return;
    const room = this.h.chat.ensureTicketChannel(t.id);
    const used = Number(this.h.company.store.getSetting(`qa_rejects:${t.id}`) || 0);
    if (used >= 2) {
      if (room)
        this.h.chat.post(
          room.id,
          'system',
          tr(
            'QA가 또 문제를 찾았지만 자동으로 돌려보내기는 두 번까지라 대표에게 넘깁니다.',
            'QA found problems again, but auto send-back is limited to twice; the CEO decides.',
          ),
          'event',
        );
      return;
    }
    const qa = this.h.nameOf(run.employeeId);
    const reason = tr(
      `화면 QA(${qa})가 문제를 찾아 자동으로 돌려보냅니다(${used + 1}/2). 아래를 고치고, 확인 순서에서 고친 모습이 보이게 하세요.\n${warns.map((w) => `- ${w.id}: ${w.line}`).join('\n')}\n\nQA 의견 전문:\n${opinion.slice(0, 3000)}`,
      `Screen QA (${qa}) found problems and sent this back automatically (${used + 1}/2). Fix these and show the fix in your check steps.\n${warns.map((w) => `- ${w.id}: ${w.line}`).join('\n')}\n\nFull QA notes:\n${opinion.slice(0, 3000)}`,
    );
    this.h.decideIntegration(a.id, 'rejected', { reason, by: `qa:${run.employeeId}` });
    this.h.company.store.setSetting(`qa_rejects:${t.id}`, String(used + 1));
    const text = tr(
      `🔁 ${qa}이(가) 화면에서 문제를 찾아 ${t.id}를 담당자에게 돌려보냈습니다: ${warns.map((w) => `${w.id} ${w.line}`).join(' / ')}`,
      `🔁 ${qa} sent ${t.id} back: ${warns.map((w) => `${w.id} ${w.line}`).join(' / ')}`,
    );
    if (room) this.h.chat.post(room.id, 'system', text, 'event');
    this.h.chat.ensureGeneral();
    this.h.chat.post('general', 'system', text, 'event');
    this.h.notice(
      tr(`QA가 ${t.id}를 돌려보냈습니다`, `QA sent ${t.id} back`),
      warns.map((w) => `${w.id} ${w.line}`).join(' / '),
      `/tickets/${t.id}`,
    );
  }

  /** 화면을 볼 직원: 사진을 읽을 수 있는 Claude QA를 먼저, 없으면 다른 Claude, 그다음 아무 QA·검수자. 담당자는 피한다. */
  private pickScreenQa(t: Ticket): Employee | null {
    const pool = this.h.company.employees().filter((e) => e.active && !e.removedAt && e.id !== t.assigneeId);
    return (
      pool.find((e) => e.cli === 'claude' && e.roles.includes('qa')) ??
      pool.find((e) => e.cli === 'claude') ??
      pool.find((e) => e.roles.includes('qa')) ??
      pool.find((e) => e.id === t.reviewerId) ??
      null
    );
  }

  /** 승인 카드용: 점검 기록 + QA 의견(업무방에 올라온 답). 사진은 따로 받는다(screenImages). */
  screenCheckView(
    ticketId: string,
  ): (Omit<ScreenCheck, 'shots'> & { shots: { label: string }[]; opinion: string | null; qaState: string | null }) | null {
    const c = this.screenCheckOf(ticketId);
    if (!c) return null;
    const run = c.qaRunId ? this.h.records.run(c.qaRunId) : null;
    const opinion = c.qaRunId
      ? (this.h.chat.messages(ticketChannelId(ticketId), 300).find((m) => m.runId === c.qaRunId)?.text ?? null)
      : null;
    return {
      ...c,
      shots: c.shots.map((s) => ({ label: s.label })),
      clips: (c.clips ?? []).map((x) => ({ label: x.label, fps: x.fps, frames: [] as string[], count: x.frames.length })),
      opinion,
      qaState: run?.status ?? null,
    };
  }

  /** 녹화 한 편을 불러온다(재생을 누를 때만: 대시보드를 무겁게 하지 않는다). */
  async screenClip(ticketId: string, index: number): Promise<{ label: string; fps: number; frames: string[] }> {
    const clip = this.screenCheckOf(ticketId)?.clips?.[index];
    if (!clip)
      throw new DomainError(tr('녹화가 없습니다(업무가 끝나 정리되었을 수 있습니다).', 'No recording (it may have been cleaned up).'));
    const root = path.resolve(this.h.dataDir, 'screens') + path.sep;
    const frames: string[] = [];
    for (const f of clip.frames) {
      if (!path.resolve(f).startsWith(root)) continue;
      const buf = await readFile(f).catch(() => null);
      if (buf) frames.push(`data:image/jpeg;base64,${buf.toString('base64')}`);
    }
    if (!frames.length) throw new DomainError(tr('녹화가 정리되었습니다.', 'The recording was cleaned up.'));
    return { label: clip.label, fps: clip.fps, frames };
  }

  private lastScreenSweep = 0;

  /**
   * 끝난 업무의 녹화·내려받은 파일을 지운다(대표 선택: 끝나면 지우기). 사진은 기록용으로 남긴다.
   * 10분에 한 번, 재시작해도 빠짐없이 돌도록 폴더를 훑는다.
   */
  async sweepScreens(): Promise<void> {
    if (Date.now() - this.lastScreenSweep < 10 * 60_000) return;
    this.lastScreenSweep = Date.now();
    const root = path.join(this.h.dataDir, 'screens');
    for (const ticketId of await readdir(root).catch(() => [] as string[])) {
      const t = this.h.company.store.get<Ticket>('tickets', ticketId);
      if (t && !TERMINAL_STATUSES.includes(t.status)) continue;
      for (const sha of await readdir(path.join(root, ticketId)).catch(() => [] as string[]))
        for (const sub of ['clips', 'downloads'])
          await rm(path.join(root, ticketId, sha, sub), { recursive: true, force: true }).catch(() => {});
      const c = t ? this.screenCheckOf(ticketId) : null;
      if (c?.clips?.length) this.saveScreenCheck(ticketId, { ...c, clips: [] });
    }
  }

  async screenImages(ticketId: string): Promise<{ label: string; dataUrl: string }[]> {
    const c = this.screenCheckOf(ticketId);
    if (!c) return [];
    const root = path.resolve(this.h.dataDir, 'screens') + path.sep;
    const out: { label: string; dataUrl: string }[] = [];
    for (const s of c.shots) {
      if (!path.resolve(s.file).startsWith(root)) continue;
      const buf = await readFile(s.file).catch(() => null);
      if (buf) out.push({ label: s.label, dataUrl: `data:image/png;base64,${buf.toString('base64')}` });
    }
    return out;
  }

  /** 대표가 다시 찍게 한다(예: 크롬을 새로 깔았거나 띄우기에 실패했을 때). */
  rerunScreenCheck(ticketId: string): void {
    const t = this.h.company.requireTicket(ticketId);
    if (t.status !== 'awaiting_approval')
      throw new DomainError(tr('승인 대기 중인 업무만 다시 찍을 수 있습니다.', 'Only tickets awaiting approval can be re-checked.'));
    this.h.company.store.setSetting(`screen:${ticketId}`, '');
    this.maybeScreenCheck(t);
  }
}

// 오케스트레이터: 결정적 코드로 티켓을 진행시킨다. LLM은 여기서 명령을 내리지 못한다.
// 흐름: 접수 → 대기 목록 → 배정 → 작업 실행 → 제출 검증(범위·증거) → 독립 검수 → 대표 승인 → 반영
import { tr } from '../core/i18n.ts';

import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { adapterFor } from '../adapters/index.ts';
import { isTransient } from '../adapters/types.ts';
import { buildChatPrompt, buildDraftPrompt, buildReviewPrompt, buildWorkPrompt } from '../agents/prompt.ts';
import {
  blindPrompt,
  crossPrompt,
  parseClaims,
  parseResponses,
  parseVerdicts,
  rebuttalPrompt,
  synthesize,
  type DeliberationPhase,
} from '../agents/deliberation.ts';
import { followUpsFromSummary, parseChatReply, parseDrafts, parseReport, type TicketDraft, type WorkReport } from '../agents/report.ts';
import { Chat, ticketChannelId, type ChatMessage } from './chat.ts';
import { writeDecision } from '../approvals/file-queue.ts';
import type { Actor } from '../core/ticket-machine.ts';
import type {
  Claim,
  Employee,
  Evidence,
  FailureClass,
  Project,
  ProjectProfile,
  Ticket,
  TicketStatus,
  VerifyCommand,
} from '../core/types.ts';
import { DEFAULT_BUDGET, DIFFICULTIES, DIFFICULTY_RANK, RANK_ORDER, TERMINAL_STATUSES, difficultyOf, rankOf } from '../core/types.ts';
import { pickPanel, pickStaff } from '../core/staffing.ts';
import { commandOf, judgeToolRequest } from '../core/guard.ts';
import { readAllJsonl } from '../runner/jsonl.ts';
import { locateExecutable } from '../runner/locate.ts';
import {
  abandonAndTerminate,
  isSameProcessAlive,
  killTree,
  readExitRecord,
  reapGroup,
  startProcess,
  waitForExit,
} from '../runner/process.ts';
import { AGENT_IDENTITY, git } from '../workspace/git.ts';
import {
  changedPaths,
  checkScope,
  removeWorktree,
  scopesOverlap,
  commitWorktree,
  reviewDiffText,
  ensureDetachedWorktree,
  ensureTicketWorktree,
  headSha,
  integrateAsBranch,
  integrateWithMerge,
  originFingerprint,
  projectPaths,
  refChanges,
  snapshotRefs,
  syncMirror,
  ticketBranch,
} from '../workspace/workspace.ts';
import { Company, DomainError } from './company.ts';
import { newId, Records, sha256, type CeoRequest, type RunRecord } from './records.ts';
import { appProfileDir } from './doctor.ts';
import { dependencySetup, installDependencies } from './verify-setup.ts';
import { estimates, ticketTokens, tokenBudget } from './cost.ts';
import { nodeTestArgs, suggestVerifyAt } from './repo-inspect.ts';
import { PreviewManager, type PreviewInfo } from './preview.ts';
import { CeoDesk } from './ceo-desk.ts';
import type { OrchHost } from './orch-host.ts';
import { Playtests } from './playtests.ts';
import { ScreenQa } from './screen-qa.ts';

const ORCH: Actor = { kind: 'orchestrator' };
const CEO: Actor = { kind: 'ceo' };
/** 사용량 한도 보류를 스스로 다시 시도하는 간격 */
export const USAGE_RETRY_MS = 30 * 60_000;

export interface OrchestratorOptions {
  dataDir: string;
  language?: string;
  /** 앱 전용 CLI 프로필 루트. null이면 사용자 기본 프로필을 쓴다. */
  profileRoot?: string | null;
  concurrency?: Partial<Record<string, number>>;
  /** 저장된 상태 변경 알림(대시보드 실시간 갱신용). */
  onChange?: (kind: string, id: string) => void;
  /** 승인 대기에 오면 결과물을 띄워 화면을 찍고 QA 직원 의견을 받는다(기본 켬). */
  screenCheck?: boolean;
}

export interface RecoveryReport {
  chainOk: boolean;
  chainDetail: string;
  reattached: string[];
  ingestedAfterRestart: string[];
  orphaned: string[];
}

const LOCK_HOLDING: TicketStatus[] = [
  'in_progress',
  'verifying',
  'in_review',
  'changes_requested',
  'awaiting_approval',
  'integrating',
  'assigned',
];

export class Orchestrator {
  readonly company: Company;
  readonly records: Records;
  /** 사내 대화(업무방·1:1·그룹방). 직원끼리의 보고·검수는 이벤트에서 자동으로 옮겨진다. */
  readonly chat: Chat;
  /** 자동 화면 점검(screen-qa.ts) */
  readonly screens: ScreenQa;
  /** 대표 할 일·알림(ceo-desk.ts) */
  readonly desk: CeoDesk;
  /** 고급 QA 직접 플레이(playtests.ts) */
  readonly playtests: Playtests;
  private readonly opts: Required<Omit<OrchestratorOptions, 'onChange'>> & Pick<OrchestratorOptions, 'onChange'>;
  private readonly busy = new Set<string>(); // 티켓 단위 비동기 작업 중
  private readonly liveRuns = new Map<string, Promise<void>>();
  private readonly reviewFailures = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(company: Company, opts: OrchestratorOptions) {
    this.company = company;
    this.records = new Records(company.store);
    this.chat = new Chat(company.store, {
      employees: () => company.employees(),
      ticket: (id) => company.store.get<Ticket>('tickets', id),
    });
    this.chat.onMessage = (m) => this.changed('chat', m.channelId);
    this.opts = {
      dataDir: opts.dataDir,
      language: opts.language ?? 'ko',
      profileRoot: opts.profileRoot ?? null,
      // CLI별 동시 실행 수: 실제 CLI는 제한 없음(대표 결정, 2026-09-30). 사용량 한도에 닿으면 usage_limit 보류로 멈춘다.
      concurrency: { claude: Infinity, codex: Infinity, agy: Infinity, fake: 4, ...opts.concurrency },
      onChange: opts.onChange,
      screenCheck: opts.screenCheck ?? true,
    };
    // 기능별로 떼어 낸 부분이 쓰는 오케스트레이터 쪽 기능(필요한 것만 넘긴다).
    const host: OrchHost = {
      company,
      records: this.records,
      chat: this.chat,
      dataDir: this.opts.dataDir,
      language: this.opts.language,
      paused: () => this.paused,
      changed: (kind, id) => this.changed(kind, id),
      preview: (projectId, ticketId) => this.preview(projectId, ticketId),
      // 답에서 누구를 불러도 연쇄 대화로 번지지 않게 최대 깊이로 둔다.
      launchChat: async (p) => {
        const runId = await this.launch(p);
        this.chatDepth.set(runId, Orchestrator.CHAT_MAX_DEPTH);
        return runId;
      },
      track: (key, p) => this.track(key, p),
      notice: (title, body, link) => this.desk.notice(title, body, link),
    };
    this.desk = new CeoDesk({
      ...host,
      onRequestDone: (req, tickets) => this.onRequestDone(req, tickets),
      stalled: () => this.stalledRuns(),
    });
    this.playtests = new Playtests(host);
    this.screens = new ScreenQa({
      ...host,
      screenCheckOn: this.opts.screenCheck,
      nameOf: (id) => this.nameOf(id),
      decideIntegration: (approvalId, decision, o) => this.decideIntegration(approvalId, decision, o),
    });
  }

  private readonly lastNotes = new Map<string, string>();

  /** 같은 대상·같은 내용의 이벤트는 반복 기록하지 않는다(추가 전용 로그 팽창 방지). */
  private noteOnce(entityId: string, type: string, payload: Record<string, unknown>): void {
    const key = `${entityId}|${type}`;
    const body = JSON.stringify(payload);
    if (this.lastNotes.get(key) === body) return;
    this.lastNotes.set(key, body);
    this.company.store.appendEvent('orchestrator', type, entityId, payload);
    this.changed('ticket', entityId);
  }

  private changed(kind: string, id: string): void {
    this.opts.onChange?.(kind, id);
  }

  // ======================= 수명 주기 =======================

  start(intervalMs = 1500): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), intervalMs);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.previews.stopAll();
  }

  // ======================= 실행해 보기 =======================

  readonly previews = new PreviewManager();

  /** 띄워 둔 미리보기 목록. 업무 제출물이 바뀌었으면 stale(옛 제출물을 보고 확인하지 않게). */
  previewList(): (PreviewInfo & { stale: boolean })[] {
    return this.previews.list().map((p) => {
      if (!p.ticketId) return { ...p, stale: false };
      const head = this.records
        .runsForTicket(p.ticketId)
        .filter((r) => r.kind === 'work' && r.status === 'succeeded' && r.headSha)
        .at(-1)?.headSha;
      return { ...p, stale: Boolean(head && head !== p.sha) };
    });
  }

  private stopTicketPreview(t: Ticket): void {
    this.previews.stop(`${t.projectId}:${t.id}`);
  }

  /** 제출물(ticketId) 또는 기준 브랜치 최신 상태를 띄운다. 대표 직접 확인용. */
  async preview(projectId: string, ticketId: string | null): Promise<PreviewInfo> {
    const project = this.company.requireProject(projectId);
    const paths = projectPaths(this.opts.dataDir, project.id);
    const { sha, dir } = await this.withProjectLock(project.id, async () => {
      let sha: string | null;
      if (ticketId) {
        const t = this.company.requireTicket(ticketId);
        const sub = this.records.latestSubmission(t);
        sha = sub?.headSha ?? null;
        if (!sha) throw new DomainError(tr('이 업무에는 아직 실행해 볼 제출물이 없습니다.', 'This ticket has no submission to run yet.'));
        // 제출물만 띄우면 그사이 병합된 다른 업무가 빠진다(실측: T-5 미리보기에 T-11 맵이 없음).
        // 최신 기준 브랜치에 제출물을 합친 모습을 띄우고, 충돌하면 제출물만 띄운다.
        const base = await this.syncMirrorRecorded(project, paths);
        const dir = await ensureDetachedWorktree(paths, 'preview', ticketId, base);
        const merged = await git([...AGENT_IDENTITY, 'merge', '--no-edit', '--no-ff', sha], dir, { allowFail: true });
        if (merged.code !== 0) {
          await git(['merge', '--abort'], dir, { allowFail: true });
          return { sha, dir: await ensureDetachedWorktree(paths, 'preview', ticketId, sha) };
        }
        return { sha, dir };
      } else sha = await this.syncMirrorRecorded(project, paths);
      return { sha, dir: await ensureDetachedWorktree(paths, 'preview', 'base', sha) };
    });
    // 직원이 알려 준 열어 볼 페이지(예: 알림음 확인용 demo.html)
    const t = ticketId ? this.company.requireTicket(ticketId) : null;
    const rep = t ? this.records.latestSubmission(t)?.report : null;
    const page = rep?.kind === 'work' ? (rep.previewPage ?? null) : null;
    return this.previews.start({ projectId, ticketId, sha, dir, page });
  }

  /** 모든 진행 중 비동기 작업이 끝날 때까지 기다린다(테스트용). */
  async idle(): Promise<void> {
    while (this.liveRuns.size > 0 || this.busy.size > 0 || this.ticking) {
      await Promise.allSettled([...this.liveRuns.values()]);
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  /** 재시작 복구: 감사 로그 검증 → 실행 중이던 프로세스 재연결 또는 파일에서 결과 수거. */
  async recover(): Promise<RecoveryReport> {
    const chain = this.company.store.verifyEventChain();
    const report: RecoveryReport = {
      chainOk: chain.ok,
      chainDetail: chain.ok
        ? tr(`이벤트 ${chain.count}개 검증`, `Verified ${chain.count} events`)
        : tr(`이벤트 #${chain.brokenAt}에서 변조 탐지: ${chain.reason}`, `Tampering detected at event #${chain.brokenAt}: ${chain.reason}`),
      reattached: [],
      ingestedAfterRestart: [],
      orphaned: [],
    };
    for (const prepared of this.records.runsByStatus('prepared')) {
      const shim = await findShim(prepared.runDir);
      if (shim) {
        this.records.saveRun({ ...prepared, status: 'running', pid: shim.pid, processStartMs: shim.startedAtMs });
        continue;
      }
      // 셔틀 기록이 없다: 포기 표시를 남기고 잠시 기다린 뒤 다시 본다(셔틀은 시작하자마자 표시를 확인하고 스스로 멈춘다).
      await writeFile(path.join(prepared.runDir, 'abandoned'), new Date().toISOString()).catch(() => {});
      await new Promise((r) => setTimeout(r, 1500));
      const late = await findShim(prepared.runDir);
      if (late && !(await readExitRecord(prepared.runDir))) {
        this.records.saveRun({ ...prepared, status: 'running', pid: late.pid, processStartMs: late.startedAtMs });
        continue;
      }
      // 실패로 확정하기 전에, 그사이 시작했다가 끝난(또는 그룹 정리 전에 죽은) 실행의 남은 프로세스를 정리한다.
      await abandonAndTerminate(prepared.runDir);
      await this.finishRun(prepared, {
        failure: 'spawn_failed',
        detail: tr('실행 준비 중 중단되어 프로세스가 시작되지 않았습니다.', 'Run preparation was interrupted; the process did not start.'),
      });
      report.orphaned.push(prepared.id);
    }
    for (const run of this.records.runsByStatus('running')) {
      const finished = await readExitRecord(run.runDir);
      const alive = !finished && run.pid !== null && run.processStartMs !== null && (await isSameProcessAlive(run.pid, run.processStartMs));
      if (alive) {
        // 셔틀이 살아 있다: 같은 실행에 재연결해 종료 기록(exit.json)을 기다린다.
        report.reattached.push(run.id);
        this.track(
          run.id,
          waitForExit(run.runDir, run.pid).then((o) => this.completeRun(run.id, o)),
        );
      } else {
        report.ingestedAfterRestart.push(run.id);
        // 종료 기록 없이 셔틀이 죽었다면 CLI가 남아 있을 수 있다: 재배정·재실행 전에 먼저 정리한다.
        // 종료 기록이 있어도 Unix 그룹에 자손이 남았을 수 있다.
        if (!finished) await abandonAndTerminate(run.runDir);
        else await reapGroup(run.runDir);
        const outcome = finished ? { exitCode: finished.exitCode, timedOut: finished.timedOut } : null;
        await this.completeRun(run.id, outcome);
        if (this.records.run(run.id)?.status === 'orphaned') report.orphaned.push(run.id);
      }
    }
    // 남아 있는 검증 명령 추천을 지금 규칙으로 다시 계산한다(추천 규칙이 나아져도 옛 추천이 계속 떠 있지 않게).
    for (const p of this.company.projects())
      if (!p.removedAt && p.verifyCommands.length && this.verifySuggestions(p.id).length)
        await this.autoVerifyCommands(p.id).catch(() => {});
    this.company.store.appendEvent('orchestrator', 'orchestrator.recovered', 'system', report);
    return report;
  }

  /** 실행 종료 후 처리: 작업이면 오케스트레이터가 커밋하고 범위를 계산한 뒤 결과를 수거한다. */
  private readonly completing = new Set<string>();

  private async completeRun(runId: string, outcome: { exitCode: number | null; timedOut: boolean } | null): Promise<void> {
    if (this.completing.has(runId)) return; // 같은 실행의 종료 처리가 겹치지 않게
    this.completing.add(runId);
    try {
      await this.completeRunOnce(runId, outcome);
    } finally {
      this.completing.delete(runId);
    }
  }

  private async completeRunOnce(runId: string, outcome: { exitCode: number | null; timedOut: boolean } | null): Promise<void> {
    const run = this.records.run(runId);
    if (!run || run.status !== 'running') return;
    if (run.kind === 'work' && !run.postProcessed && !outcome?.timedOut) {
      try {
        await this.postWork(run);
      } catch (error) {
        // 범위·원본 검사를 못 했으면 제출로 인정하지 않는다.
        return this.finishRun(run, {
          failure: 'unknown',
          detail: tr(`실행 후 검사 실패(제출 차단): ${String(error)}`, `Post-run checks failed (submission blocked): ${String(error)}`),
        });
      }
      run.postProcessed = true;
      this.records.saveRun(run);
    }
    await this.ingest(runId, outcome);
  }

  private async postWork(run: RunRecord): Promise<void> {
    const ticket = this.company.requireTicket(run.ticketId);
    const project = this.company.requireProject(ticket.projectId);
    const paths = projectPaths(this.opts.dataDir, project.id);
    await this.withProjectLock(project.id, async () => {
      const wt = await ensureTicketWorktree(paths, ticket.id, project.baseBranch);
      const branchRef = `refs/heads/${ticketBranch(ticket.id)}`;
      const windowSeq = run.moveSeqBefore ?? 0;
      // 오케스트레이터의 커밋 이전 상태로 비교해야 직원의 ref 조작과 구분된다.
      const refsNow = run.refsBefore ? await snapshotRefs(paths.mirror) : null;
      const prevHead = await headSha(wt.path);
      let head = await commitWorktree(wt, `${ticket.id} round ${run.round}`);
      if (head) this.records.recordRefMove(project.id, 'mirror', branchRef, prevHead, head);
      // 새 변경이 없어도 이전 회차 결과가 있으면 그대로 다시 제출한다(피드백에 대한 반박·설명). "변경 없음"으로 반려하지 않는다.
      else if (prevHead && run.baseSha && prevHead !== run.baseSha) head = prevHead;
      run.headSha = head;
      run.changedPaths = head && run.baseSha ? await changedPaths(paths.mirror, run.baseSha, head) : [];
      if (run.refsBefore && refsNow)
        run.refViolations = this.unexplained(project, 'mirror', run.refsBefore, refsNow, windowSeq, [branchRef]);
      if (run.originBefore !== null) run.originChanged = (await originFingerprint(project.originPath)) !== run.originBefore;
      if (run.originRefsBefore)
        run.originChanged ||=
          this.unexplained(project, 'origin', run.originRefsBefore, await snapshotRefs(project.originPath), windowSeq).length > 0;
    });
  }

  /** 미러 기준 브랜치 동기화. 이동을 전이 기록으로 남긴다(프로젝트 잠금 안에서 호출). */
  private async syncMirrorRecorded(project: Project, paths: ReturnType<typeof projectPaths>): Promise<string> {
    const ref = `refs/heads/${project.baseBranch}`;
    const before = existsSync(paths.mirror)
      ? (await git(['rev-parse', '--verify', '-q', ref], paths.mirror, { allowFail: true })).stdout.trim() || null
      : null;
    const after = await syncMirror(project.originPath, paths, project.baseBranch);
    this.records.recordRefMove(project.id, 'mirror', ref, before, after);
    return after;
  }

  /** 스냅샷 이후 바뀐 ref 중 오케스트레이터가 기록한 전이로 설명되지 않는 것. */
  private unexplained(
    project: Project,
    scope: 'mirror' | 'origin',
    before: Record<string, string>,
    after: Record<string, string>,
    windowSeq: number,
    allowed: string[] = [],
  ): string[] {
    return refChanges(before, after, allowed)
      .filter((ref) => scope === 'mirror' || ref.startsWith('refs/heads/') || ref.startsWith('refs/tags/'))
      .filter((ref) => !this.records.explainedByMoves(project.id, scope, ref, before[ref], after[ref], windowSeq));
  }

  private readonly projectLocks = new Map<string, Promise<unknown>>();

  /** 같은 프로젝트 미러의 git 작업(동기화·커밋·ref 비교)을 순서대로 실행한다. */
  private withProjectLock<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.projectLocks.get(projectId) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    this.projectLocks.set(
      projectId,
      next.catch(() => {}),
    );
    return next;
  }

  private track(runId: string, p: Promise<void>): void {
    const wrapped = p
      .catch((error) => {
        this.company.store.appendEvent('orchestrator', 'orchestrator.error', runId, { error: String(error) });
      })
      .finally(() => this.liveRuns.delete(runId));
    this.liveRuns.set(runId, wrapped);
  }

  // ======================= 한 번의 진행 =======================

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.pollToolApprovals();
      this.checkDailyLimit();
      await this.screens.sweepScreens().catch(() => {});
      await this.checkStalled();
      this.desk.notifyNewTodos();
      // 우선순위(1 높음 → 3 낮음) 순, 같으면 먼저 만든 순: 쓰기 범위가 겹칠 때 높은 업무가 먼저 잠금을 잡는다.
      for (const t of [...this.company.tickets()].sort((a, b) => (a.priority ?? 2) - (b.priority ?? 2))) {
        if (t.hold?.reason === 'waiting_dependency' && t.dependsOn.every((d) => this.company.requireTicket(d).status === 'done')) {
          this.apply(t.id, { type: 'release_hold' }); // 선행 업무가 끝나면 오케스트레이터가 스스로 해제
          continue;
        }
        // 사용량 한도 보류는 30분마다 스스로 다시 시도한다(아직 한도면 곧바로 다시 보류, 실행 예산은 쓰지 않음).
        // 전에는 대표가 한도가 풀렸는지 가늠해 직접 재개해야 했다.
        if (t.hold?.reason === 'usage_limit' && Date.now() - Date.parse(t.hold.since) >= USAGE_RETRY_MS) {
          this.apply(t.id, { type: 'release_hold' });
          continue;
        }
        if (TERMINAL_STATUSES.includes(t.status) || t.hold || this.busy.has(t.id)) continue;
        // 회사 전체 일시정지: 새 실행(작업·재작업·검수)을 시작하지 않는다. 검증·반영·승인 요청은 계속한다.
        if (this.paused && !['received', 'analyzing', 'backlog', 'verifying', 'integrating', 'awaiting_approval'].includes(t.status))
          continue;
        try {
          await this.advance(t);
        } catch (error) {
          this.noteOnce(t.id, 'orchestrator.error', { error: String(error) });
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  private async advance(t: Ticket): Promise<void> {
    switch (t.status) {
      case 'received':
        this.apply(t.id, { type: 'analyze' });
        return;
      case 'analyzing':
        try {
          this.apply(t.id, { type: 'accept_to_backlog' });
        } catch (error) {
          this.apply(t.id, {
            type: 'hold',
            reason: 'needs_decision',
            note: tr(
              `티켓 정보 보완 필요: ${String((error as Error).message)}`,
              `Ticket details need updating: ${String((error as Error).message)}`,
            ),
          });
        }
        return;
      case 'backlog':
        this.autoAssign(t);
        return;
      case 'assigned':
      case 'changes_requested':
        await this.startWork(t);
        return;
      case 'in_progress':
        if (t.type === 'review') {
          await this.deliberate(t);
          return;
        }
        if (!this.hasLiveRun(t.id, 'work')) {
          // 데몬 재시작 후 추적 중인 실행이 없으면 중단 처리(예산은 이미 소모됨).
          this.apply(t.id, {
            type: 'run_aborted',
            reason: tr('실행 추적이 끊겼습니다(재시작 복구).', 'Run tracking was lost (restart recovery).'),
          });
        }
        return;
      case 'verifying':
        this.runBusy(t.id, () => this.verify(t.id));
        return;
      case 'in_review':
        if (!this.hasLiveRun(t.id, 'review')) this.startReview(t);
        return;
      case 'awaiting_approval':
        this.ensureIntegrationApproval(t);
        this.maybeAutoApprove(t);
        return;
      case 'integrating':
        this.runBusy(t.id, () => this.integrate(t.id));
        return;
    }
  }

  private apply(ticketId: string, cmd: Parameters<Company['applyTicket']>[1], actor: Actor = ORCH): Ticket {
    const t = this.company.applyTicket(ticketId, cmd, actor);
    if (TERMINAL_STATUSES.includes(t.status)) this.records.releaseLocks(ticketId);
    if (t.status === 'done') this.desk.checkRequestDone(t.id);
    if (t.status === 'awaiting_approval' && !t.hold) this.ensureIntegrationApproval(t);
    this.changed('ticket', ticketId);
    return t;
  }

  private runBusy(ticketId: string, fn: () => Promise<void>): void {
    if (this.busy.has(ticketId)) return;
    this.busy.add(ticketId);
    const id = `busy:${ticketId}`;
    this.track(
      id,
      fn().finally(() => this.busy.delete(ticketId)),
    );
  }

  private hasLiveRun(ticketId: string, kind: 'work' | 'review'): boolean {
    return this.records.runsForTicket(ticketId).some((r) => r.kind === kind && r.status === 'running' && this.liveRuns.has(r.id));
  }

  private liveCountFor(cli: string): number {
    return this.records.runsByStatus('running').filter((r) => r.cli === cli && this.liveRuns.has(r.id)).length;
  }

  // ======================= 배정 =======================

  private autoAssign(t: Ticket): void {
    const active = this.company.activeEmployees();
    const load = (e: Employee) =>
      this.company.tickets().filter((x) => x.assigneeId === e.id && !TERMINAL_STATUSES.includes(x.status)).length;
    const pick = pickStaff(t, active, load);
    if (!pick.ok) {
      const need = DIFFICULTY_RANK[difficultyOf(t)];
      const note =
        pick.reason === 'too_few'
          ? tr(
              '담당자와 검수자를 나누려면 활성 직원이 2명 이상 필요합니다.',
              'At least two active employees are needed for separate assignee and reviewer roles.',
            )
          : tr(
              `이 업무(난이도 ${difficultyOf(t)})는 ${need === 'lead' ? '팀장' : '선임'} 이상만 맡을 수 있는데, 그런 직원이 없습니다. 난이도를 낮추거나 직원의 직급을 올리세요.`,
              `This ticket (difficulty ${difficultyOf(t)}) needs a ${need} or higher, and there is none. Lower the difficulty or promote an employee.`,
            );
      this.apply(t.id, { type: 'hold', reason: 'needs_decision', note });
      return;
    }
    this.apply(t.id, {
      type: 'assign',
      assigneeId: pick.assigneeId,
      reviewerId: pick.reviewerId,
      ownerId: pick.ownerId,
      reviewBelowRank: pick.reviewBelowRank,
      activeEmployeeIds: active.map((e) => e.id),
      ranks: Object.fromEntries(active.map((e) => [e.id, rankOf(e)])),
    });
  }

  // ======================= 작업 실행 =======================

  private async startWork(t: Ticket): Promise<void> {
    const employee = this.company.requireEmployee(t.assigneeId!);
    if (!employee.active) {
      this.apply(t.id, {
        type: 'hold',
        reason: 'needs_decision',
        note: tr(`담당자 ${employee.name}이(가) 비활성 상태입니다.`, `Assignee ${employee.name} is inactive.`),
      });
      return;
    }
    if (this.liveCountFor(employee.cli) >= (this.opts.concurrency[employee.cli] ?? 1)) return;
    const deps = t.dependsOn.every((d) => this.company.requireTicket(d).status === 'done');
    const locks = deps
      ? this.records.acquireLocks(
          t,
          this.company.tickets().filter((x) => LOCK_HOLDING.includes(x.status)),
        )
      : { ok: true as const };
    if (!locks.ok) {
      // 다른 업무와 쓰기 범위가 겹친다: 오류가 아니라 대기. 같은 사유로는 한 번만 기록한다.
      this.noteOnce(t.id, 'ticket.waiting_lock', { conflictWith: locks.conflictWith });
      return;
    }
    const next = this.apply(t.id, { type: 'start_work', dependenciesDone: deps, locksAcquired: true });
    if (next.status !== 'in_progress') return;
    if (next.type === 'review') return; // 검토형은 다음 tick부터 블라인드 분석을 시작한다

    const project = this.company.requireProject(t.projectId);
    const paths = projectPaths(this.opts.dataDir, project.id);
    const { wt, refsBefore, originBefore, originRefsBefore, moveSeqBefore } = await this.withProjectLock(project.id, async () => {
      await this.syncMirrorRecorded(project, paths);
      const branchRef = `refs/heads/${ticketBranch(t.id)}`;
      const existed = (await git(['rev-parse', '--verify', '-q', branchRef], paths.mirror, { allowFail: true })).stdout.trim() || null;
      const wt = await ensureTicketWorktree(paths, t.id, project.baseBranch);
      this.records.recordRefMove(project.id, 'mirror', branchRef, existed, await headSha(wt.path));
      // 반영 충돌로 돌아온 업무: 최신 기준을 업무 폴더에 합쳐 둔다. 충돌이면 표시를 남긴 채 두고(직원이 정리),
      // 제출 때 시스템 커밋이 병합을 마친다. 이제 비교 기준은 최신 기준이다(다른 업무의 변경이 범위 위반으로 보이지 않게).
      if (this.company.store.getSetting(`catch_up:${t.id}`)) {
        this.company.store.setSetting(`catch_up:${t.id}`, '');
        const before = await headSha(wt.path);
        const baseRef = `refs/heads/${project.baseBranch}`;
        const merged = await git([...AGENT_IDENTITY, 'merge', '--no-ff', '--no-edit', baseRef], wt.path, { allowFail: true });
        if (merged.code === 0) this.records.recordRefMove(project.id, 'mirror', branchRef, before, await headSha(wt.path));
        const conflicted = (await git(['diff', '--name-only', '--diff-filter=U'], wt.path, { allowFail: true })).stdout.trim();
        wt.baseSha = await headSha(paths.mirror, baseRef);
        this.company.store.appendEvent('orchestrator', 'ticket.caught_up', t.id, { conflicted: conflicted.split('\n').filter(Boolean) });
      }
      return {
        wt,
        refsBefore: await snapshotRefs(paths.mirror),
        originBefore: await originFingerprint(project.originPath),
        originRefsBefore: await snapshotRefs(project.originPath),
        moveSeqBefore: this.records.currentMoveSeq(),
      };
    });

    const go = async () => {
      const nonce = randomBytes(6).toString('hex');
      const feedback = this.lastFeedback(next);
      const prompt = buildWorkPrompt({
        employee,
        owner: next.ownerId ? this.company.employees().find((e) => e.id === next.ownerId) : null,
        project,
        ticket: next,
        nonce,
        decisions: this.records.decisions(project.id, 'current'),
        feedback,
        language: this.opts.language,
        colleagues: this.company
          .activeEmployees()
          .filter((e) => e.id !== employee.id)
          .map((e) => `"${e.name}" (${e.roles.join('/')})`),
        // 어려움·보통 업무의 첫 회차만 나눌 수 있다(작은 업무를 쪼개면 오히려 비싸다)
        canSplit: next.round === 1 && difficultyOf(next) !== 'easy' && this.canSplit(next),
        // 앱이 CLI로 떠 있을 때만(테스트 등에서는 없음): 직원이 화면 점검을 미리 돌려 볼 명령
        screenCheckCommand: /cli[\\/]main\.(ts|js)$/.test(process.argv[1] ?? '')
          ? `"${process.execPath}" "${process.argv[1]}" screen-check --url <dev-server-url> --steps <steps.json>`
          : null,
      });
      await this.launch({
        ticket: next,
        employee,
        kind: 'work',
        cwd: wt.path,
        prompt,
        nonce,
        accessLevel: employee.accessLevel,
        baseSha: wt.baseSha,
        refsBefore,
        originBefore,
        originRefsBefore,
        moveSeqBefore,
      });
    };
    // 작업공간에 의존성을 미리 깐다(실측: 직원이 "vitest 미설치로 테스트 실행 불가"). 설치는 몇 분 걸릴 수 있어
    // 다른 업무를 막지 않게 따로 돌린다. node_modules가 git에서 무시될 때만: 아니면 제출 커밋에 통째로 들어간다.
    const needsInstall =
      dependencySetup(wt.path, []) !== null && (await git(['check-ignore', '-q', 'node_modules'], wt.path, { allowFail: true })).code === 0;
    if (!needsInstall) return go();
    this.runBusy(t.id, async () => {
      const inst = await installDependencies(wt.path);
      if (inst.ran && !inst.ok)
        this.company.store.appendEvent('orchestrator', 'ticket.setup_failed', t.id, { output: inst.output.slice(-500) });
      await go();
    });
  }

  private lastFeedback(t: Ticket): string | null {
    const ev =
      t.round <= 1
        ? null
        : this.company.store
            .events(t.id)
            .filter((e) => e.type === 'ticket.changes_requested')
            .at(-1);
    const review = ev ? String((ev.payload as { reason?: string }).reason ?? '') : null;
    const splitNote = this.company.store.getSetting(`split_note:${t.id}`) || null;
    // 대표가 업무방에 남긴 말(지난 작업 시작 이후)도 다음 작업 지시에 넣는다.
    const since =
      this.records
        .runsForTicket(t.id)
        .filter((r) => r.kind === 'work')
        .at(-1)?.startedAt ?? '';
    const notes = this.chat
      .messages(ticketChannelId(t.id), 200)
      .filter((m) => m.author === 'ceo' && (m.kind === 'chat' || m.kind === 'steer') && m.createdAt > since)
      .map((m) => `- ${m.text}`);
    // 이 업무를 두고 그룹 방에서 오간 대화(계획 합의 등)도 담당자에게 전달한다.
    const related = this.chat
      .channels()
      .filter((c) => c.kind === 'group')
      .flatMap((c) => {
        const ms = this.chat.messages(c.id, 200);
        const about = c.ticketId === t.id || ms.some((m) => m.refs.includes(t.id));
        return about
          ? ms.filter((m) => m.kind === 'chat').map((m) => `- [${c.name}] ${this.nameOf(m.author)}: ${m.text.slice(0, 1200)}`)
          : [];
      })
      .slice(-20);
    const parts = [
      splitNote,
      review,
      notes.length ? tr(`대표가 업무방에 남긴 말:\n${notes.join('\n')}`, `CEO notes in the ticket room:\n${notes.join('\n')}`) : null,
      related.length
        ? tr(
            `이 업무에 관한 그룹 방 대화(합의한 계획):\n${related.join('\n')}`,
            `Group-room discussion about this ticket (agreed plan):\n${related.join('\n')}`,
          )
        : null,
    ].filter((x): x is string => Boolean(x));
    return parts.length ? parts.join('\n\n') : null;
  }

  private profileEnv(employee: Employee): Record<string, string> {
    const v = adapterFor(employee.cli).capabilities.profileEnvVar;
    return v && this.opts.profileRoot ? { [v]: appProfileDir(this.opts.profileRoot, employee.cli) } : {};
  }

  private async launch(p: {
    ticket: Pick<Ticket, 'id' | 'round' | 'budget'>;
    employee: Employee;
    kind: 'work' | 'review' | 'analysis' | 'chat';
    cwd: string;
    prompt: string;
    nonce: string;
    accessLevel: Employee['accessLevel'];
    baseSha: string | null;
    refsBefore?: Record<string, string>;
    originBefore?: string;
    originRefsBefore?: Record<string, string>;
    moveSeqBefore?: number;
    phase?: DeliberationPhase;
    claimIds?: string[];
  }): Promise<string> {
    const adapter = adapterFor(p.employee.cli);
    const runId = newId('R');
    const runDir = path.join(this.opts.dataDir, 'runs', runId);
    const approvalDir = adapter.capabilities.permissionRelay ? path.join(runDir, 'approvals') : null;
    const inv = adapter.buildInvocation({
      prompt: p.prompt,
      cwd: p.cwd,
      model: p.employee.model,
      effort: p.employee.effort ?? null,
      accessLevel: p.accessLevel,
      allowedCommands: p.employee.allowedCommands,
      profileEnv: this.profileEnv(p.employee),
      ...(approvalDir ? { approvalDir } : {}),
      runDir,
    });
    await mkdir(runDir, { recursive: true });
    for (const f of inv.files) await writeFile(f.path, f.content, 'utf8');
    await writeFile(path.join(runDir, 'prompt.md'), p.prompt, 'utf8');

    const located =
      inv.file === process.execPath
        ? { launch: { file: inv.file, argsPrefix: [] as string[] } }
        : await locateExecutable(inv.file, inv.env);
    const run: RunRecord = {
      id: runId,
      ticketId: p.ticket.id,
      employeeId: p.employee.id,
      kind: p.kind,
      nonce: p.nonce,
      status: 'prepared',
      pid: null,
      cliSessionId: null,
      runDir,
      exitCode: null,
      failureClass: null,
      startedAt: new Date().toISOString(),
      endedAt: null,
      round: p.ticket.round,
      cli: p.employee.cli,
      processStartMs: null,
      approvalDir,
      worktreePath: p.cwd,
      baseSha: p.baseSha,
      headSha: null,
      changedPaths: [],
      refViolations: [],
      originChanged: false,
      refsBefore: p.refsBefore ?? null,
      originBefore: p.originBefore ?? null,
      originRefsBefore: p.originRefsBefore ?? null,
      moveSeqBefore: p.moveSeqBefore ?? 0,
      postProcessed: false,
      phase: p.phase ?? null,
      claimIds: p.claimIds ?? [],
      report: null,
      reportError: null,
      finalText: null,
      summary: '',
    };
    this.records.saveRun(run); // 먼저 기록하고 나중에 실행(write-ahead)
    this.company.store.appendEvent(p.employee.id, `run.${p.kind}.prepared`, p.ticket.id, {
      runId,
      cli: p.employee.cli,
      model: p.employee.model,
      effort: p.employee.effort ?? null,
    });

    if (!located?.launch) {
      await this.finishRun(run, {
        failure: 'spawn_failed',
        detail: tr(
          `${adapter.displayName} 실행 파일(${inv.file})을 찾지 못했습니다.`,
          `${adapter.displayName} executable (${inv.file}) not found.`,
        ),
      });
      return runId;
    }
    try {
      const proc = await startProcess({
        file: located.launch.file,
        args: [...located.launch.argsPrefix, ...inv.args],
        cwd: p.cwd,
        env: inv.env,
        stdinText: inv.stdinText,
        runDir,
        timeoutMs: p.ticket.budget.runTimeoutMs,
      });
      run.status = 'running';
      run.pid = proc.pid;
      run.processStartMs = proc.startedAtMs;
      this.records.saveRun(run);
      this.changed('run', runId);
      this.track(
        runId,
        proc.done.then((outcome) => this.completeRun(runId, outcome)),
      );
    } catch (error) {
      await this.finishRun(run, { failure: 'spawn_failed', detail: String(error) });
    }
    return runId;
  }

  /**
   * 실행 결과 수거. outcome이 null이면 데몬 재시작 후 파일에서만 판단한다.
   * exit code 0만으로 성공이 아니다: 최종 응답 + 스키마 + nonce가 모두 맞아야 한다.
   */
  private async ingest(runId: string, outcome: { exitCode: number | null; timedOut: boolean } | null): Promise<void> {
    const run = this.records.run(runId);
    if (!run || (run.status !== 'running' && run.status !== 'prepared')) return;
    const adapter = adapterFor(run.cli as Employee['cli']);
    const out = await readAllJsonl(path.join(run.runDir, 'stdout.log'));
    const stderr = await readFile(path.join(run.runDir, 'stderr.log'), 'utf8').catch(() => '');
    const parsed = adapter.parse(out.events);
    run.cliSessionId = parsed.sessionId;
    run.finalText = parsed.finalText;
    run.usage = parsed.usage ?? null;
    run.exitCode = outcome?.exitCode ?? null;

    const fresh = run;
    if (run.kind === 'analysis' && run.phase)
      return this.finishDeliberationRun(
        run,
        outcome?.timedOut ? null : parsed.finalText,
        outcome?.timedOut ? tr('시간 초과', 'Timed out') : stderr,
      );
    if (run.kind === 'analysis') return this.finishDrafts(run, parsed.finalText, outcome, stderr);
    if (run.kind === 'chat') return this.finishChat(run, outcome?.timedOut ? null : parsed.finalText, parsed.errorText ?? stderr);

    const ticket = this.company.requireTicket(run.ticketId);
    const report = parseReport(parsed.finalText, {
      kind: run.kind === 'review' ? 'review' : 'work',
      nonce: run.nonce,
      requirementIds: ticket.requirements.map((r) => r.id),
    });
    if (outcome?.timedOut) return this.finishRun(fresh, { failure: 'timeout', detail: tr('실행 시간 초과', 'Run timed out') });
    if (!report.ok) {
      // CLI가 오류로 끝났으면(최종 응답이 오류 메시지) 형식 오류가 아니라 그 오류로 분류한다(실측: 토큰 갱신 경합).
      const cls: FailureClass =
        report.reason === 'nonce_mismatch'
          ? 'nonce_mismatch'
          : parsed.finalText && !parsed.errorText
            ? 'schema_invalid'
            : adapter.classifyFailure({ exitCode: run.exitCode, timedOut: false, stderr, finalText: parsed.errorText ?? parsed.finalText });
      return this.finishRun(fresh, {
        failure: outcome === null && !parsed.finalText ? 'unknown' : cls,
        detail: `${report.detail}${stderr ? `\nstderr: ${stderr.slice(-800)}` : ''}`,
        orphan: outcome === null && !parsed.finalText,
      });
    }
    fresh.report = report.report;
    fresh.summary = report.report.summary;
    await this.finishRun(fresh, null);
  }

  private async finishRun(run: RunRecord, failure: { failure: FailureClass; detail: string; orphan?: boolean } | null): Promise<void> {
    if (run.kind === 'analysis' && run.phase) return this.finishDeliberationRun(run, null, failure?.detail ?? tr('실패', 'Failed'));
    if (run.kind === 'analysis') return this.finishDrafts(run, null, null, failure?.detail ?? '');
    if (run.kind === 'chat') return this.finishChat(run, null, failure?.detail ?? '');
    // 실행 결과·이벤트·티켓 전이를 한 트랜잭션으로: 중간에 죽어도 "성공했는데 제출 안 됨" 상태가 남지 않는다.
    this.company.store.transact(() => this.finishRunTx(run, failure));
    await this.cleanupSplitWorktrees();
    if (!failure && run.kind === 'work' && run.report?.kind === 'work') this.afterWorkReport(run, run.report);
    if (!failure && run.kind === 'review' && run.report?.kind === 'review') {
      const t = this.company.store.get<Ticket>('tickets', run.ticketId);
      const r = run.report;
      if (t) this.postFollowUps(run, t, r.followUps?.length ? r.followUps : followUpsFromSummary(r.summary));
    }
    this.checkTokenBudget(run.ticketId);
  }

  // ======================= 자동 설정 =======================

  /**
   * 병합 뒤 기준 브랜치에 테스트·타입 검사·빌드 명령이 생겼는지 본다(실측: 빈 저장소로 시작하면 대표가 직접 넣어야 했다).
   * 검증 명령이 하나도 없으면 바로 넣고, 이미 있으면 빠진 것을 추천으로 남긴다(프로젝트 화면에서 한 번에 추가).
   */
  async autoVerifyCommands(projectId: string): Promise<void> {
    const project = this.company.requireProject(projectId);
    const found = await suggestVerifyAt(project.originPath, project.baseBranch);
    // npx tsc --noEmit 과 tsc --noEmit 은 같은 명령이다.
    const same = (cmd: string) => cmd.trim().replace(/^npx\s+/, '');
    const have = new Set(project.verifyCommands.map((v) => same(v.argv.join(' '))));
    // 실측: node --test tests가 있는데 같은 일을 하는 npm test를 또 추천했다. 스크립트 본문이 이미 있으면 뺀다.
    const missing = found
      .filter((f) => !have.has(same(f.argv.join(' '))) && !(f.runs && have.has(same(f.runs))))
      .map(({ label, argv, evidenceType }) => ({ label, argv, evidenceType }));
    if (!missing.length) {
      this.company.store.setSetting(`verify_suggest:${projectId}`, '');
      return;
    }
    if (project.verifyCommands.length === 0) {
      this.company.updateProject(projectId, { verifyCommands: missing });
      this.chat.ensureGeneral();
      this.chat.post(
        'general',
        'system',
        tr(
          `${project.name}: 병합된 코드에 검증 명령이 생겨 자동으로 추가했습니다 — ${missing.map((m) => m.argv.join(' ')).join(', ')}`,
          `${project.name}: added verify commands found in the merged code — ${missing.map((m) => m.argv.join(' ')).join(', ')}`,
        ),
        'event',
      );
    } else this.company.store.setSetting(`verify_suggest:${projectId}`, JSON.stringify(missing));
    this.changed('project', projectId);
  }

  verifySuggestions(projectId: string): VerifyCommand[] {
    const raw = this.company.store.getSetting(`verify_suggest:${projectId}`);
    return raw ? (JSON.parse(raw) as VerifyCommand[]) : [];
  }

  // ======================= 비용(토큰) =======================

  /** 업무별 예산을 넘으면 멈추고 대표에게 묻는다(계속 돌며 토큰을 태우지 않게). */
  private checkTokenBudget(ticketId: string): void {
    const t = this.company.store.get<Ticket>('tickets', ticketId);
    if (!t || TERMINAL_STATUSES.includes(t.status) || t.hold) return;
    const used = ticketTokens(this.records, t.id);
    const budget = this.budgetOf(t);
    if (used < budget) return;
    // 대표가 판단할 수 있게: 어디까지 왔는지, 실제 비용은 얼마인지(대부분 캐시 재사용이면 토큰 수보다 훨씬 싸다).
    // 실측(2026-09-30): 1225만 토큰 중 97%가 캐시 재사용이었고 비용은 약 $6.4였다. 작업은 이미 제출돼 검사·검수만 남아 있었다.
    const runs = this.records.runsForTicket(t.id);
    const cost = runs.reduce((a, r) => a + (r.usage?.costUsd ?? 0), 0);
    const cached = runs.reduce((a, r) => a + (r.usage?.cacheRead ?? 0), 0);
    const submitted = ['verifying', 'in_review', 'awaiting_approval'].includes(t.status);
    // 이미 제출되어 검사·검수만 남았으면 멈추지 않는다(남은 비용이 작다): 알리고 그대로 간다.
    // 돌려보내져 다시 일해야 할 때(그때는 제출 상태가 아님) 멈추고 묻는다.
    // 실측(2026-10-01, 메이플 5차): "작업은 이미 끝나 제출됐고 검사·검수만 남음(10~20만)"인데 멈춰 대표가 눌러야 했다.
    if (submitted) {
      if (!this.company.store.getSetting(`budget_noted:${t.id}:${Math.round(budget)}`)) {
        this.company.store.setSetting(`budget_noted:${t.id}:${Math.round(budget)}`, '1');
        this.desk.notice(
          tr(
            `${t.id} 토큰 예산을 넘었습니다 (${Math.round(used / 1e4)}만 / ${Math.round(budget / 1e4)}만)`,
            `${t.id} is over its token budget`,
          ),
          tr(
            `작업은 이미 제출되어 검사·검수만 남아 그대로 진행합니다${cost ? ` (추정 $${cost.toFixed(1)})` : ''}. 다시 일해야 하면 그때 멈추고 묻습니다.`,
            'The work is already submitted, so checks and review continue. It will stop and ask if more work is needed.',
          ),
          `/tickets/${t.id}`,
        );
      }
      return;
    }
    this.apply(t.id, {
      type: 'hold',
      reason: 'needs_decision',
      note: tr(
        [
          `토큰 예산을 넘었습니다: ${Math.round(used / 1e4)}만 / 예산 ${Math.round(budget / 1e4)}만.`,
          cached > used / 2
            ? `그중 ${Math.round((cached / used) * 100)}%는 캐시 재사용이라 실제 비용은 더 작습니다${cost ? ` (추정 $${cost.toFixed(1)})` : ''}.`
            : cost
              ? `추정 비용 $${cost.toFixed(1)}.`
              : '',
          submitted
            ? '작업은 이미 끝나 제출되었습니다. 남은 것은 자동 검사와 검수뿐입니다(보통 10~20만 토큰).'
            : '작업이 아직 끝나지 않았습니다.',
          '예산을 늘려 계속하거나 취소하세요.',
        ]
          .filter(Boolean)
          .join(' '),
        `Token budget exceeded: ${Math.round(used / 1e3)}k of ${Math.round(budget / 1e3)}k${cost ? ` (est. $${cost.toFixed(1)})` : ''}.${submitted ? ' The work is already submitted; only checks and review remain.' : ''} Raise the budget to continue, or cancel.`,
      ),
    });
  }

  /** 예산을 늘리고(없으면 1.5배, 적어도 쓴 양의 1.3배) 예산 때문에 멈췄으면 다시 돌린다. */
  raiseTokenBudget(ticketId: string, maxTokens?: number): Ticket {
    const t = this.company.requireTicket(ticketId);
    const used = ticketTokens(this.records, t.id);
    const next = maxTokens ?? Math.max(this.budgetOf(t) * 1.5, used * 1.3);
    let out = this.company.setTicketTokenBudget(t.id, next);
    if (out.hold?.reason === 'needs_decision' && /토큰 예산|Token budget/.test(out.hold.note) && used < next) out = this.releaseHold(t.id);
    this.changed('ticket', t.id);
    return out;
  }

  private dailyCheckedAt = 0;

  /** 하루 한도: 넘으면 회사 전체를 멈추고, 다음 날 자동으로 푼다(대표가 그날 직접 풀면 그날은 다시 멈추지 않는다). */
  private checkDailyLimit(): void {
    if (Date.now() - this.dailyCheckedAt < 30_000) return;
    this.dailyCheckedAt = Date.now();
    const limit = Number(this.company.store.getSetting('daily_token_limit') ?? 0);
    const d = new Date();
    const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const reason = this.company.store.getSetting('paused_reason') ?? '';
    if (this.paused && reason.startsWith('daily:') && reason !== `daily:${today}`) {
      this.company.store.setSetting('paused_reason', '');
      this.setPaused(false);
      return;
    }
    if (!limit || this.paused || this.company.store.getSetting('daily_override') === today) return;
    const used = this.records.usageSummary(d).today.total;
    if (used < limit) return;
    this.company.store.setSetting('paused_reason', `daily:${today}`);
    this.setPaused(true);
    this.chat.ensureGeneral();
    this.chat.post(
      'general',
      'system',
      tr(
        `오늘 토큰 한도(${Math.round(limit / 1e4)}만)에 닿아 회사 전체를 멈췄습니다. 내일 자동으로 다시 시작합니다. 지금 계속하려면 "일시정지 풀기"를 누르세요.`,
        `Hit today's token limit (${Math.round(limit / 1e3)}k); paused until tomorrow. Press Resume to continue now.`,
      ),
      'event',
    );
  }

  private estimateCache: { at: number; value: ReturnType<typeof estimates> } | null = null;

  /** 난이도별 예상치(1분 캐시: 대시보드가 업무마다 예산을 물어본다). */
  tokenEstimates(): ReturnType<typeof estimates> {
    if (!this.estimateCache || Date.now() - this.estimateCache.at > 60_000)
      this.estimateCache = { at: Date.now(), value: estimates(this.records, this.company.tickets()) };
    return this.estimateCache.value;
  }

  private budgetOf(t: Ticket): number {
    const e = this.tokenEstimates()[difficultyOf(t)];
    return tokenBudget(t, e.samples >= 2 ? e.tokens : undefined);
  }

  ticketBudget(t: Ticket): { used: number; budget: number } {
    return { used: ticketTokens(this.records, t.id), budget: this.budgetOf(t) };
  }

  setDailyTokenLimit(tokens: number): { dailyLimit: number } {
    const v = Math.max(0, Math.round(tokens || 0));
    this.company.store.setSetting('daily_token_limit', String(v));
    this.dailyCheckedAt = 0;
    this.changed('company', 'company');
    return { dailyLimit: v };
  }

  // ======================= 사내 대화 =======================

  /** 대화 답장의 연쇄 깊이(대표 메시지 = 0). 직원끼리 끝없이 부르는 것을 막는다. */
  private readonly chatDepth = new Map<string, number>();
  /** 답장 중인데 또 불리면 끝난 뒤 한 번 더 답하게 표시한다. */
  private readonly chatAgain = new Map<string, number>();
  static readonly CHAT_MAX_DEPTH = 3;
  static readonly CHAT_MAX_AI_REPLIES_PER_HOUR = 12;

  private nameOf(id: string): string {
    if (id === 'ceo') return tr('대표', 'CEO');
    if (id === 'system') return tr('시스템', 'System');
    return this.company.employees().find((e) => e.id === id)?.name ?? id;
  }

  private liveWorkRun(ticketId: string, employeeId: string): RunRecord | null {
    return (
      this.records
        .runsForTicket(ticketId)
        .find((r) => r.kind === 'work' && r.employeeId === employeeId && r.status === 'running' && this.liveRuns.has(r.id)) ?? null
    );
  }

  /**
   * 대표가 대화방에 쓴다. 1:1이면 그 직원이, 다른 방이면 멘션된 직원이 답한다.
   * 멘션된 직원이 이 업무를 지금 작업 중이면 대화 대신 작업에 지시로 전달한다(Codex는 실행 중에, 나머지는 다음 회차에).
   */
  async ceoMessage(channelId: string, text: string): Promise<ChatMessage> {
    const c = this.chat.channel(channelId);
    if (!c) throw new DomainError(tr('방을 찾을 수 없습니다.', 'Channel not found.'));
    if (!text.trim()) throw new DomainError(tr('내용이 비어 있습니다.', 'Message is empty.'));
    const m = this.chat.post(channelId, 'ceo', text.trim(), 'chat');
    const responders = c.kind === 'dm' ? c.members.filter((x) => x !== 'ceo') : m.mentions.filter((x) => x !== 'ceo');
    for (const id of responders) {
      if (c.ticketId) {
        const live = this.liveWorkRun(c.ticketId, id);
        if (live) {
          await this.deliverSteer(live, text.trim(), channelId);
          continue;
        }
      }
      await this.dispatchChat(channelId, id, 0, m);
    }
    return m;
  }

  /** 작업 중인 직원에게 지시: Codex는 진행 중인 턴에 끼워 넣고(turn/steer), 나머지 CLI는 다음 회차 지시에 넣는다. */
  async deliverSteer(run: RunRecord, text: string, channelId: string | null): Promise<'live' | 'next_round'> {
    const room = channelId ?? (run.ticketId.startsWith('T-') ? this.chat.ensureTicketChannel(run.ticketId)?.id : null);
    if (run.cli === 'codex' && run.status === 'running') {
      const dir = path.join(run.runDir, 'steer');
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, `${Date.now()}.json`), JSON.stringify({ text }), 'utf8');
      if (room)
        this.chat.post(
          room,
          'system',
          tr(
            `${this.nameOf(run.employeeId)}에게 작업 중 지시로 전달했습니다(다음 단계에서 반영).`,
            `Sent to ${this.nameOf(run.employeeId)} mid-run (applied at the next step).`,
          ),
          'event',
        );
      return 'live';
    }
    if (room) {
      if (!channelId) this.chat.post(room, 'ceo', text, 'steer');
      this.chat.post(
        room,
        'system',
        tr(
          `${this.nameOf(run.employeeId)}은(는) 작업 중이라 이 말은 다음 회차 지시에 포함됩니다(${run.cli}는 실행 중 지시를 받지 못함).`,
          `${this.nameOf(run.employeeId)} is working; this goes into the next round's instructions (${run.cli} can't take mid-run input).`,
        ),
        'event',
      );
    }
    return 'next_round';
  }

  /** 실행 화면의 "지시 보내기". */
  async steerRun(runId: string, text: string): Promise<'live' | 'next_round'> {
    const run = this.records.run(runId);
    if (!run || run.status !== 'running') throw new DomainError(tr('진행 중인 실행이 아닙니다.', 'That run is not running.'));
    if (!text.trim()) throw new DomainError(tr('내용이 비어 있습니다.', 'Message is empty.'));
    const room = run.ticketId.startsWith('T-') ? this.chat.ensureTicketChannel(run.ticketId)?.id : null;
    if (room) this.chat.post(room, 'ceo', `@${this.nameOf(run.employeeId)} ${text.trim()}`, 'steer');
    return this.deliverSteer(run, text.trim(), room ?? null);
  }

  /** 직원에게 답장을 시킨다(읽기 전용 짧은 실행). 깊이·빈도 제한과 중복 실행 방지를 여기서 한다. */
  private async dispatchChat(channelId: string, employeeId: string, depth: number, trigger: ChatMessage): Promise<void> {
    const employee = this.company.employees().find((e) => e.id === employeeId);
    if (!employee) return;
    if (!employee.active || employee.removedAt) {
      this.chat.post(
        channelId,
        'system',
        tr(`${employee.name}은(는) 지금 비활성 상태라 답할 수 없습니다.`, `${employee.name} is inactive.`),
        'event',
      );
      return;
    }
    // 회사가 멈춰 있으면 직원끼리의 연쇄 대화는 시작하지 않는다(대표가 직접 부른 것만 답한다).
    if (this.paused && depth > 0) return;
    if (depth > Orchestrator.CHAT_MAX_DEPTH) {
      this.chat.post(
        channelId,
        'system',
        tr(
          '직원끼리 주고받은 대화가 길어져 여기서 멈춥니다. 이어가려면 대표가 다시 불러 주세요.',
          'The AI-to-AI thread got long, so it stops here. Mention someone to continue.',
        ),
        'event',
      );
      return;
    }
    const hourAgo = new Date(Date.now() - 3600_000).toISOString();
    const aiReplies = this.records
      .runsForTicket(channelId)
      .filter((r) => r.kind === 'chat' && r.startedAt > hourAgo && (this.chatDepth.get(r.id) ?? 1) > 0).length;
    if (depth > 0 && aiReplies >= Orchestrator.CHAT_MAX_AI_REPLIES_PER_HOUR) {
      this.chat.post(
        channelId,
        'system',
        tr(
          '이 방의 직원 간 대화가 한 시간 한도에 닿았습니다(토큰 절약).',
          'This room hit its hourly AI-to-AI reply limit (saving tokens).',
        ),
        'event',
      );
      return;
    }
    const busy = this.records
      .runsForTicket(channelId)
      .some((r) => r.kind === 'chat' && r.employeeId === employeeId && r.status === 'running');
    if (busy) {
      this.chatAgain.set(`${channelId}|${employeeId}`, depth);
      return;
    }
    await this.startChatRun(channelId, employee, depth, trigger);
  }

  private async startChatRun(channelId: string, employee: Employee, depth: number, trigger: ChatMessage): Promise<void> {
    const c = this.chat.channel(channelId)!;
    const ticket = c.ticketId ? this.company.store.get<Ticket>('tickets', c.ticketId) : null;
    const projectId = c.projectId ?? ticket?.projectId ?? this.company.projects().find((p) => !p.removedAt)?.id ?? null;
    const project = projectId ? this.company.requireProject(projectId) : null;
    let cwd = this.opts.dataDir;
    if (project) {
      const paths = projectPaths(this.opts.dataDir, project.id);
      const ticketWt = ticket ? path.join(paths.worktrees, ticket.id) : null;
      cwd =
        ticketWt && existsSync(ticketWt)
          ? ticketWt
          : await this.withProjectLock(project.id, async () =>
              ensureDetachedWorktree(paths, 'review', '_chat', await this.syncMirrorRecorded(project, paths)),
            );
    }
    const history = this.chat
      .messages(channelId, 40)
      .filter((m) => m.id !== trigger.id)
      .map((m) => ({ author: this.nameOf(m.author), text: m.kind === 'event' ? `(${m.text})` : m.text, at: m.createdAt }));
    const nonce = randomBytes(6).toString('hex');
    const prompt = buildChatPrompt({
      employee,
      employees: this.company.employees(),
      channel: { kind: c.kind, name: c.name, topic: c.topic, memberNames: c.members.map((x) => this.nameOf(x)) },
      history,
      trigger: { author: this.nameOf(trigger.author), text: trigger.text },
      project,
      ticket,
      decisions: project ? this.records.decisions(project.id, 'current') : [],
      nonce,
      language: this.opts.language,
      canOpenRoom: depth < Orchestrator.CHAT_MAX_DEPTH,
      board: this.boardSummary(projectId),
    });
    const runId = await this.launch({
      ticket: { id: channelId, round: 1, budget: { ...DEFAULT_BUDGET, runTimeoutMs: 10 * 60_000 } },
      employee,
      kind: 'chat',
      cwd,
      prompt,
      nonce,
      accessLevel: 'read-only',
      baseSha: null,
    });
    this.chatDepth.set(runId, depth);
    this.changed('chat', channelId);
  }

  /** 대화용 업무판 요약: 최근·진행 중 업무의 상태와 담당(한 줄씩). */
  private boardSummary(projectId: string | null): string {
    const tickets = this.company.tickets(projectId ?? undefined);
    const open = tickets.filter((t) => !TERMINAL_STATUSES.includes(t.status));
    const done = tickets.filter((t) => t.status === 'done').slice(-8);
    const line = (t: Ticket) =>
      `${t.id} [${t.status}${t.hold ? `, hold: ${t.hold.reason}` : ''}] r${t.round} ${t.title} — ${tr('담당', 'assignee')} ${this.nameOf(t.assigneeId ?? '-')}, ${tr('검수', 'reviewer')} ${this.nameOf(t.reviewerId ?? '-')}`;
    return [...open.map(line), ...(done.length ? [tr('최근 완료:', 'Recently done:'), ...done.map(line)] : [])].join('\n');
  }

  private async finishChat(run: RunRecord, finalText: string | null, errorText: string): Promise<void> {
    const parsed = parseChatReply(finalText, run.nonce);
    const failed = !parsed || (isTransient(finalText) && !finalText?.includes(run.nonce));
    await this.playtests.finishPlaytest(run, failed || !parsed ? null : parsed.reply, errorText);
    run.endedAt = new Date().toISOString();
    run.status = failed ? 'failed' : 'succeeded';
    run.summary = parsed?.reply.slice(0, 200) ?? '';
    run.reportError = failed ? (errorText || finalText || tr('답이 없습니다.', 'No reply.')).slice(0, 1000) : null;
    this.records.saveRun(run);
    const channelId = run.ticketId;
    const depth = this.chatDepth.get(run.id) ?? 1;
    this.chatDepth.delete(run.id);
    if (!this.chat.channel(channelId)) return;
    if (failed || !parsed) {
      this.chat.post(
        channelId,
        'system',
        tr(
          `${this.nameOf(run.employeeId)} 답장 실패: ${(run.reportError ?? '').slice(0, 300)}`,
          `${this.nameOf(run.employeeId)} could not reply: ${(run.reportError ?? '').slice(0, 300)}`,
        ),
        'event',
      );
    } else {
      const msg = this.chat.post(channelId, run.employeeId, parsed.reply, 'chat', { runId: run.id });
      const ticketId = this.chat.channel(channelId)?.ticketId;
      if (ticketId) this.screens.maybeQaReject(ticketId, run, parsed.reply);
      if (parsed.profile) this.proposeProfile(channelId, parsed.profile, run.employeeId);
      const byName = (n: string) => this.company.employees().find((e) => e.name === n.trim() && !e.removedAt)?.id;
      const called = new Set(
        [...parsed.mentions.map(byName), ...msg.mentions].filter((x): x is string => Boolean(x) && x !== 'ceo' && x !== run.employeeId),
      );
      for (const id of called) await this.dispatchChat(channelId, id, depth + 1, msg);
      if (parsed.openRoom && depth < Orchestrator.CHAT_MAX_DEPTH) {
        const members = parsed.openRoom.members.map(byName).filter((x): x is string => Boolean(x) && x !== run.employeeId);
        const src = this.chat.channel(channelId)!;
        const room = this.chat.createGroup({
          name: parsed.openRoom.name,
          members,
          createdBy: run.employeeId,
          topic: parsed.openRoom.topic,
          projectId: src.projectId,
          ticketId: src.ticketId,
        });
        this.chat.post(
          channelId,
          'system',
          tr(
            `${this.nameOf(run.employeeId)}이(가) 그룹 방 "${room.name}"을 열었습니다.`,
            `${this.nameOf(run.employeeId)} opened the group room "${room.name}".`,
          ),
          'event',
        );
        const first = this.chat.post(room.id, run.employeeId, parsed.openRoom.message || parsed.openRoom.topic || parsed.reply, 'chat');
        for (const id of members) await this.dispatchChat(room.id, id, depth + 1, first);
      }
    }
    // 답하는 동안 또 불렸으면 한 번 더.
    const key = `${channelId}|${run.employeeId}`;
    const again = this.chatAgain.get(key);
    if (again !== undefined) {
      this.chatAgain.delete(key);
      const last = this.chat.messages(channelId, 1).at(-1);
      const emp = this.company.employees().find((e) => e.id === run.employeeId);
      if (last && emp && last.author !== run.employeeId) await this.startChatRun(channelId, emp, again, last);
    }
    this.changed('chat', channelId);
    this.changed('run', run.id);
  }

  // ======================= 나중에 확인 =======================

  /** 승인 때 "나중에 확인"으로 미룬 대표 직접 확인 항목 */
  laterChecks(ticketId: string): { id: string; text: string; at: string }[] {
    const raw = this.company.store.getSetting(`later_checks:${ticketId}`);
    return raw ? (JSON.parse(raw) as { id: string; text: string; at: string }[]) : [];
  }

  /**
   * 미뤄 둔 확인을 끝낸다. 괜찮으면 확인 기록을 남기고, 문제가 있으면 비서실장에게 고칠 요청을 보낸다.
   */
  async resolveLaterCheck(ticketId: string, requirementId: string, ok: boolean, note = ''): Promise<{ requestId: string | null }> {
    const list = this.laterChecks(ticketId);
    const item = list.find((x) => x.id === requirementId);
    if (!item) throw new DomainError(tr('나중에 확인할 항목이 아닙니다.', 'Not a deferred check.'));
    this.company.store.setSetting(`later_checks:${ticketId}`, JSON.stringify(list.filter((x) => x.id !== requirementId)));
    let requestId: string | null = null;
    if (ok) this.attest(ticketId, requirementId, tr('반영 뒤 대표가 직접 확인했습니다.', 'Confirmed by the CEO after merging.'));
    else {
      const t = this.company.requireTicket(ticketId);
      const req = await this.submitRequest(
        t.projectId,
        tr(
          `${t.id} "${t.title}"을(를) 반영한 뒤 대표가 직접 확인해 보니 이 부분이 기대와 달라요: ${item.text}${note ? `\n대표 메모: ${note}` : ''}`,
          `After ${t.id} "${t.title}" was merged, the CEO checked and this is not right: ${item.text}${note ? `\nCEO note: ${note}` : ''}`,
        ),
      );
      requestId = req.id;
    }
    this.changed('ticket', ticketId);
    return { requestId };
  }

  // ======================= 멈춘 실행 =======================

  /** 이만큼 아무 출력이 없으면 멈췄을 수 있다고 대표에게 알린다(라이브 화면은 5분부터 ⚠). */
  static readonly STALL_MS = 10 * 60_000;
  private stalled = new Map<string, number>();
  private lastStallCheck = 0;

  /**
   * 1분마다: 실행 중인데 출력이 STALL_MS 넘게 없는 직원을 찾는다. 처음 찾으면 대표에게 알린다.
   * 실측(첫 사용, 2026-10-01): 직원이 띄운 시험 스크립트가 끝나지 않아 실행이 10분 넘게 멈췄는데,
   * 대표에게 보이는 곳은 라이브 화면의 작은 ⚠뿐이었다(그대로 두면 30분 시간 제한까지 기다린다).
   */
  private async checkStalled(): Promise<void> {
    if (Date.now() - this.lastStallCheck < 60_000) return;
    this.lastStallCheck = Date.now();
    const next = new Map<string, number>();
    for (const runId of this.liveRuns.keys()) {
      const run = this.records.run(runId);
      if (!run || run.status !== 'running') continue;
      const out = await stat(path.join(run.runDir, 'stdout.log'))
        .then((s) => s.mtimeMs)
        .catch(() => 0);
      const quiet = Date.now() - Math.max(out, Date.parse(run.startedAt));
      if (quiet < Orchestrator.STALL_MS) continue;
      next.set(runId, quiet);
      if (!this.stalled.has(runId))
        this.desk.notice(
          tr(
            `${this.nameOf(run.employeeId)}이(가) ${Math.round(quiet / 60_000)}분째 아무 신호가 없습니다`,
            `${this.nameOf(run.employeeId)} has been silent for ${Math.round(quiet / 60_000)} minutes`,
          ),
          tr(
            `${run.ticketId}: 끝나지 않는 명령을 기다리고 있을 수 있습니다. 라이브 화면에서 "끊고 다시 시키기"를 누를 수 있습니다.`,
            `${run.ticketId}: it may be waiting on a command that never ends. Use "Cut and restart" on the Live page.`,
          ),
          `/live/${run.id}`,
        );
    }
    this.stalled = next;
  }

  /** 멈췄을 수 있는 실행: 실행 ID → 조용했던 시간(ms) */
  stalledRuns(): { runId: string; ticketId: string; employeeId: string; quietMs: number }[] {
    return [...this.stalled].flatMap(([runId, quietMs]) => {
      const run = this.records.run(runId);
      return run?.status === 'running' ? [{ runId, ticketId: run.ticketId, employeeId: run.employeeId, quietMs }] : [];
    });
  }

  /**
   * 대표가 멈춘 실행을 끊는다: 직원 AI 프로세스(와 그것이 띄운 명령)만 끝내면, 실행은 보통의 실패로 처리되어
   * 작업이면 다음 차례에 다시 시키고(실행 1회 소모), 대화·초안은 다시 시도할 수 있다.
   * 작업이면 다음 지시에 "끝나지 않는 명령을 기다리지 말 것"을 대표 메모로 남긴다.
   */
  async restartRun(runId: string): Promise<{ ok: true }> {
    const run = this.records.run(runId);
    if (!run || run.status !== 'running' || !this.liveRuns.has(runId))
      throw new DomainError(tr('이미 끝난 실행입니다.', 'This run has already finished.'));
    const pid = await readFile(path.join(run.runDir, 'pid.json'), 'utf8')
      .then((x) => (JSON.parse(x) as { cliPid?: number | null }).cliPid ?? null)
      .catch(() => null);
    if (!pid) throw new DomainError(tr('직원 프로세스를 찾지 못했습니다.', 'Employee process not found.'));
    const quietMin = Math.round((this.stalled.get(runId) ?? 0) / 60_000);
    this.company.store.appendEvent('ceo', 'run.restarted', run.ticketId, { runId, quietMin });
    if (run.kind === 'work' && this.chat.channel(ticketChannelId(run.ticketId)))
      this.chat.post(
        ticketChannelId(run.ticketId),
        'ceo',
        tr(
          `지난 실행이 ${quietMin ? `${quietMin}분 동안 ` : ''}아무 신호 없이 멈춰서 끊었습니다. 끝나지 않는 명령(서버·감시·시험 스크립트)을 기다리지 말고, 직접 띄운 것은 끄고, 오래 걸릴 명령에는 시간 제한을 두세요.`,
          `The last run went silent${quietMin ? ` for ${quietMin} minutes` : ''}, so I cut it. Don't wait on commands that never end (servers, watchers, test scripts): stop what you start and put a timeout on long commands.`,
        ),
        'chat',
      );
    await killTree(pid);
    this.stalled.delete(runId);
    this.changed('run', runId);
    return { ok: true };
  }

  /**
   * 대화에서 프로젝트 성격이 바뀌면(예: "휴대폰에서도 돼야 해") 직원이 프로필 변경을 제안하고, 대표가 한 번에 반영한다.
   * 대표 요청(2026-10-01 우선순위 5): 프로필을 설정 화면에서만 고칠 수 있어 대화로 바뀐 내용이 직원들에게 전해지지 않았다.
   */
  private proposeProfile(channelId: string, profile: ProjectProfile, by: string): void {
    const c = this.chat.channel(channelId);
    const ticket = c?.ticketId ? this.company.store.get<Ticket>('tickets', c.ticketId) : null;
    const projectId = c?.projectId ?? ticket?.projectId ?? this.company.projects().find((p) => !p.removedAt)?.id;
    const project = projectId ? this.company.store.get<Project>('projects', projectId) : null;
    if (!project) return;
    const cur = project.profile;
    if (cur && cur.summary === profile.summary && cur.mobile === profile.mobile && cur.game === profile.game) return;
    this.company.store.setSetting(`profile_proposal:${project.id}`, JSON.stringify({ profile, by, at: new Date().toISOString() }));
    this.chat.post(
      channelId,
      'system',
      tr(
        `${this.nameOf(by)}이(가) ${project.name} 프로필 변경을 제안했습니다: ${profile.summary} — 프로젝트 화면에서 반영할 수 있습니다.`,
        `${this.nameOf(by)} proposed a new profile for ${project.name}: ${profile.summary} (apply it on the Projects page).`,
      ),
      'event',
    );
    this.changed('project', project.id);
  }

  profileProposal(projectId: string): { profile: ProjectProfile; by: string; at: string } | null {
    const raw = this.company.store.getSetting(`profile_proposal:${projectId}`);
    return raw ? (JSON.parse(raw) as { profile: ProjectProfile; by: string; at: string }) : null;
  }

  /** 대표가 제안을 반영하거나 버린다. */
  resolveProfileProposal(projectId: string, accept: boolean): Project {
    const p = this.profileProposal(projectId);
    if (!p) throw new DomainError(tr('프로필 변경 제안이 없습니다.', 'No profile proposal.'));
    this.company.store.setSetting(`profile_proposal:${projectId}`, '');
    const project = accept ? this.company.updateProject(projectId, { profile: p.profile }) : this.company.requireProject(projectId);
    this.changed('project', projectId);
    return project;
  }

  private readonly splitCleanup = new Set<string>();

  private async cleanupSplitWorktrees(): Promise<void> {
    for (const id of [...this.splitCleanup]) {
      this.splitCleanup.delete(id);
      const t = this.company.store.get<Ticket>('tickets', id);
      if (!t) continue;
      const paths = projectPaths(this.opts.dataDir, t.projectId);
      await this.withProjectLock(t.projectId, async () => {
        await removeWorktree(paths, path.join(paths.worktrees, id));
        await git(['branch', '-D', ticketBranch(id)], paths.mirror, { allowFail: true });
      });
    }
  }

  // ======================= 대표 알림·고급 QA 잇기 =======================

  /** 요청이 끝났을 때: 게임 프로젝트에서 켜 두었으면 고급 QA(직접 플레이)를 한 번 한다. */
  private onRequestDone(req: CeoRequest, tickets: Ticket[]): void {
    const project = this.company.store.get<Project>('projects', req.projectId);
    if (!project?.profile?.game || !project.autoPlaytest || !tickets.some((t) => t.status === 'done')) return;
    void this.playtests
      .startPlaytest({ requestId: req.id }, 'auto')
      .catch((e: unknown) =>
        this.desk.notice(tr('고급 QA를 시작하지 못했습니다', 'Could not start the play test'), String((e as Error)?.message ?? e)),
      );
  }

  /** 이 업무를 나눌 수 있는가: 나눈 조각이 아니고, 아직 한 번도 나누지 않은 업무만. */
  canSplit(t: Ticket): boolean {
    return !this.company.store.getSetting(`split_parent:${t.id}`) && !this.company.store.getSetting(`split_note:${t.id}`);
  }

  /**
   * 담당자가 "혼자 하기엔 크다"며 나눈 부분을 업무로 만든다(대표 요청: 부하가 팀장에게 피드백해 일감을 나누기).
   * 실측(2026-09-30, 메이플 3차): 어려운 업무 셋이 팀장 한 명에게 몰려 1시간 반 동안 선임 둘이 놀았다.
   * - 조각은 보통 난이도 이하라 선임도 맡는다. 쓰기 범위는 원래 업무 범위 안이어야 한다. 겹치는 조각끼리는 앞 조각을 기다린다.
   * - 원래 업무는 조각이 다 끝날 때까지 기다렸다가 최신 기준에서 새로 시작해 마무리한다.
   */
  private splitTicket(ticket: Ticket, run: RunRecord, wr: WorkReport): boolean {
    const parts = wr.split ?? [];
    if (parts.length < 2 || !this.canSplit(ticket)) return false;
    const prefix = (g: string) => {
      const n = g.replaceAll('\\', '/');
      const i = n.search(/[*?[{]/);
      return (i === -1 ? n : n.slice(0, i)).toLowerCase();
    };
    const inside = (g: string) => ticket.writeScope.some((p) => prefix(g).startsWith(prefix(p)));
    if (!parts.every((p) => p.writeScope.every(inside))) return false;
    const created: Ticket[] = [];
    this.company.store.transact(() => {
      for (const [n, p] of parts.entries()) {
        const deps = created.filter((c) => scopesOverlap(c.writeScope, p.writeScope)).map((c) => c.id);
        const child = this.company.createTicket(
          {
            projectId: ticket.projectId,
            type: 'impl',
            title: p.title,
            purpose: tr(
              `${ticket.id}의 일부(${n + 1}/${parts.length}): ${p.purpose}`,
              `Part ${n + 1}/${parts.length} of ${ticket.id}: ${p.purpose}`,
            ),
            requirements: p.requirements.map((q) => ({ text: q.text, evidenceType: q.evidenceType as Evidence['type'] })),
            doneCriteria: tr('요구사항을 증거로 충족하고 검수를 통과한다.', 'Requirements proven with evidence and review passed.'),
            writeScope: p.writeScope,
            difficulty: p.difficulty,
            dependsOn: deps,
          },
          ORCH,
        );
        this.company.store.setSetting(`split_parent:${child.id}`, ticket.id);
        created.push(child);
      }
      this.company.addDependencies(
        ticket.id,
        created.map((c) => c.id),
      );
      this.company.store.setSetting(
        `split_note:${ticket.id}`,
        tr(
          `이 업무를 나눴고, 나눈 업무 ${created.map((c) => `${c.id}(${c.title})`).join(', ')}가 끝나 기준 브랜치에 들어갔습니다. 나눈 업무가 한 일을 이어받아, 남은 요구사항과 연결(통합)을 마무리해 제출하세요. 다시 나눌 수는 없습니다.`,
          `You split this ticket; the parts ${created.map((c) => `${c.id} (${c.title})`).join(', ')} are done and merged into the base. Build on them, finish the remaining requirements and the integration, then submit. You cannot split again.`,
        ),
      );
      this.apply(ticket.id, {
        type: 'run_aborted',
        reason: tr(`담당자가 업무를 ${created.length}개로 나눔`, `Assignee split the ticket into ${created.length}`),
        hold: {
          reason: 'waiting_dependency',
          note: tr(
            `나눈 업무(${created.map((c) => c.id).join(', ')})가 끝나면 이어서 마무리합니다.`,
            `Resumes after the parts (${created.map((c) => c.id).join(', ')}) are done.`,
          ),
        },
      });
    });
    // 나눈 업무의 결과를 받도록: 원래 업무의 작업 공간은 비우고(트랜잭션 뒤 finishRun에서), 다시 시작할 때 최신 기준에서 새로 만든다.
    this.splitCleanup.add(ticket.id);
    // 쓰기 잠금도 내려놓는다: 조각이 같은 범위 안에서 일해야 한다. 다시 시작할 때 다시 잡는다.
    this.records.releaseLocks(ticket.id);
    const text = tr(
      `${this.nameOf(run.employeeId)}이(가) 혼자 하기엔 크다고 보고 일을 ${created.length}개로 나눴습니다: ${created.map((c) => `${c.id} ${c.title}`).join(' / ')}. 다른 직원이 나눠 맡고, 끝나면 ${ticket.id}가 이어서 마무리합니다.`,
      `${this.nameOf(run.employeeId)} split the work into ${created.length}: ${created.map((c) => `${c.id} ${c.title}`).join(' / ')}. ${ticket.id} resumes when they are done.`,
    );
    const room = this.chat.ensureTicketChannel(ticket.id);
    if (room) this.chat.post(room.id, 'system', text, 'event');
    this.chat.ensureGeneral();
    this.chat.post('general', 'system', text, 'event');
    return true;
  }

  /** 작업 보고의 후속 업무 제안·동료 질문을 업무방에 올린다. */
  private afterWorkReport(run: RunRecord, report: WorkReport): void {
    const t = this.company.store.get<Ticket>('tickets', run.ticketId);
    // 직원이 칸을 안 채워도 요약에 "범위 밖·후속"이 있으면 제안으로 올린다.
    const followUps = report.followUps?.length ? report.followUps : followUpsFromSummary(report.summary);
    if (!t || (!followUps.length && !report.ask?.length)) return;
    const room = this.chat.ensureTicketChannel(t.id);
    if (!room) return;
    this.postFollowUps(run, t, followUps);
    for (const a of report.ask ?? []) {
      const to = this.company.employees().find((e) => e.name === a.to && !e.removedAt);
      if (!to || to.id === run.employeeId) continue;
      if (!room.members.includes(to.id)) this.chat.addMembers(room.id, [to.id]);
      const m = this.chat.post(room.id, run.employeeId, `@${to.name} ${a.text}`, 'chat');
      void this.dispatchChat(room.id, to.id, 1, m);
    }
  }

  private postFollowUps(run: RunRecord, t: Ticket, followUps: { title: string; reason: string }[]): void {
    const room = this.chat.ensureTicketChannel(t.id);
    if (!room || !followUps.length) return;
    // 같은 제목의 제안은 한 번만(재작업 회차마다 반복하지 않게)
    const seen = new Set(
      this.chat
        .messages(room.id, 300)
        .filter((m) => m.followUp)
        .map((m) => m.followUp!.title),
    );
    for (const f of followUps.filter((x) => !seen.has(x.title)))
      this.chat.post(
        room.id,
        run.employeeId,
        tr(`후속 업무 제안: ${f.title}\n${f.reason}`, `Follow-up suggestion: ${f.title}\n${f.reason}`),
        'followup',
        {
          followUp: { title: f.title, reason: f.reason, projectId: t.projectId, ticketId: t.id },
        },
      );
  }

  /** 후속 업무 제안 → 비서실장에게 요청(대표가 누름). */
  async followUpToRequest(messageId: string): Promise<CeoRequest> {
    const m = this.company.store.get<ChatMessage>('chat', messageId);
    if (!m?.followUp) throw new DomainError(tr('후속 업무 제안이 아닙니다.', 'Not a follow-up suggestion.'));
    const projectId = m.followUp.projectId ?? this.company.projects().find((p) => !p.removedAt)?.id;
    if (!projectId) throw new DomainError(tr('프로젝트가 없습니다.', 'No project.'));
    const req = await this.submitRequest(
      projectId,
      `${m.followUp.title}\n\n${m.followUp.reason}${m.followUp.ticketId ? tr(`\n(출처: ${m.followUp.ticketId} 업무방)`, `\n(from ${m.followUp.ticketId})`) : ''}`,
    );
    this.company.store.put(
      'chat',
      m.id,
      { ...m, followUp: { ...m.followUp, requestId: req.id } },
      { channel_id: m.channelId, created_at: m.createdAt },
    );
    this.changed('chat', m.channelId);
    return req;
  }

  private finishRunTx(run: RunRecord, failure: { failure: FailureClass; detail: string; orphan?: boolean } | null): void {
    run.endedAt = new Date().toISOString();
    run.status = failure ? (failure.orphan ? 'orphaned' : 'failed') : 'succeeded';
    run.failureClass = failure?.failure ?? null;
    run.reportError = failure?.detail ?? null;
    this.records.saveRun(run);
    this.expireToolApprovals(run);
    this.company.store.appendEvent(run.employeeId, `run.${run.kind}.${run.status}`, run.ticketId, {
      runId: run.id,
      failureClass: run.failureClass,
      detail: failure?.detail?.slice(0, 1000) ?? null,
      summary: run.summary,
    });
    this.changed('run', run.id);

    const ticket = this.company.requireTicket(run.ticketId);
    if (run.kind === 'work') {
      if (ticket.status !== 'in_progress') return;
      if (failure) {
        const hold =
          failure.failure === 'usage_limit'
            ? {
                reason: 'usage_limit' as const,
                note: tr(
                  '구독 사용량 한도에 도달했습니다. 30분마다 스스로 다시 시도합니다(한도가 풀린 걸 알면 보류 해제로 바로 재개).',
                  'Subscription usage limit reached. Retrying by itself every 30 minutes (release the hold to resume now).',
                ),
              }
            : failure.failure === 'auth_required'
              ? {
                  reason: 'needs_permission' as const,
                  note: tr(
                    '이 직원의 AI 로그인이 풀렸습니다. 시스템 화면에서 "로그인 창 열기"로 다시 로그인한 뒤 보류를 해제하세요.',
                    'This employee’s AI login expired. Use "Open login window" on the System page, then release the hold.',
                  ),
                }
              : failure.failure === 'spawn_failed'
                ? { reason: 'needs_decision' as const, note: failure.detail }
                : failure.failure === 'model_unsupported'
                  ? {
                      reason: 'needs_decision' as const,
                      note: tr(
                        `설치된 CLI가 이 직원의 모델을 지원하지 않습니다. CLI를 업데이트하거나(예: claude update) 조직 화면에서 모델을 바꾸세요.
${failure.detail.slice(0, 400)}`,
                        `The installed CLI does not support this employee's model. Update the CLI (e.g. claude update) or change the model on the Team page.
${failure.detail.slice(0, 400)}`,
                      ),
                    }
                  : undefined;
        this.apply(ticket.id, {
          type: 'run_aborted',
          reason: `${failure.failure}: ${failure.detail.slice(0, 300)}`,
          ...(hold ? { hold } : {}),
        });
        return;
      }
      const wr = run.report as WorkReport;
      if (wr.status !== 'done' && wr.split?.length && this.splitTicket(ticket, run, wr)) return;
      // 시험용 파일만 더 쓰겠다는 요청은 대표가 판단할 것이 아니다: 다른 진행 중 업무와 겹치지 않으면 바로 허용한다.
      // 실측(2026-10-01, 물 마시기): "tests/sound/** 허용하고 계속"을 비개발자 대표가 판단하지 못한 채 눌렀다.
      const askPaths = wr.needScope?.paths ?? [];
      const project = this.company.requireProject(ticket.projectId);
      if (
        askPaths.length &&
        askPaths.every((p) => /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[a-z]+$/i.test(p.replaceAll('\\', '/'))) &&
        !checkScope(askPaths, askPaths, project.protectedPaths).protectedTouched.length &&
        !this.company.tickets().some((x) => x.id !== ticket.id && LOCK_HOLDING.includes(x.status) && scopesOverlap(x.writeScope, askPaths))
      ) {
        this.company.extendWriteScope(ticket.id, askPaths);
        this.apply(ticket.id, {
          type: 'run_aborted',
          reason: tr('시험용 파일 범위를 넓혀 다시 시작', 'Test files added to scope; restarting'),
        });
        const room = ticketChannelId(ticket.id);
        if (this.chat.channel(room))
          this.chat.post(
            room,
            'system',
            tr(
              `시험용 파일이라 바로 허용했습니다: ${askPaths.join(', ')} (다른 업무와 겹치지 않음)`,
              `Allowed test files right away: ${askPaths.join(', ')}`,
            ),
            'event',
          );
        return;
      }
      if (wr.needScope?.paths.length) {
        // 범위 밖 파일이 필요하다는 요청: 헛되이 다시 내지 않고 대표에게 한 번에 묻는다.
        // 실측(2026-09-30, T-27): 기존 보스 테스트 한 줄이 범위 밖이라 같은 실패로 세 번 제출하고 멈췄다.
        this.company.store.setSetting(`scope_request:${ticket.id}`, JSON.stringify(wr.needScope));
        this.apply(ticket.id, {
          type: 'run_aborted',
          reason: tr('범위 밖 파일 수정 허가 요청', 'Asked to edit files outside the write scope'),
          hold: {
            reason: 'needs_decision',
            note: tr(
              `이 파일도 고쳐야 한다고 요청했습니다: ${wr.needScope.paths.join(', ')}\n이유: ${wr.needScope.reason}`,
              `Asked to also edit: ${wr.needScope.paths.join(', ')}\nReason: ${wr.needScope.reason}`,
            ),
          },
        });
        return;
      }
      if (wr.status !== 'done') {
        this.apply(ticket.id, {
          type: 'run_aborted',
          reason: tr(
            `직원이 ${wr.status === 'blocked' ? tr('진행 불가', 'Blocked') : tr('대표 결정 필요', 'CEO decision needed')}를 보고`,
            `Employee reported: ${wr.status === 'blocked' ? tr('진행 불가', 'Blocked') : tr('대표 결정 필요', 'CEO decision needed')}`,
          ),
          hold: { reason: 'needs_decision', note: [wr.summary, ...wr.questions].join('\n').slice(0, 2000) },
        });
        // 대표가 업무 화면에서 바로 답할 수 있게 질문을 따로 남긴다.
        this.company.store.setSetting(`ticket_questions:${ticket.id}`, JSON.stringify(wr.questions));
        return;
      }
      this.apply(ticket.id, { type: 'submit' });
      return;
    }

    // 검수 실행
    if (ticket.status !== 'in_review') return;
    if (failure) {
      // 일시적 오류(토큰 갱신 경합 등)는 검수자 탓이 아니므로 실패 횟수에 넣지 않는다.
      const n = (this.reviewFailures.get(ticket.id) ?? 0) + (failure.failure === 'transient' ? 0 : 1);
      this.reviewFailures.set(ticket.id, n);
      if (n >= 2 || failure.failure === 'usage_limit' || failure.failure === 'auth_required' || failure.failure === 'model_unsupported') {
        this.apply(ticket.id, {
          type: 'hold',
          reason: failure.failure === 'usage_limit' ? 'usage_limit' : 'needs_decision',
          note: tr(
            `검수 실행 실패(${n}회): ${failure.detail.slice(0, 300)}`,
            `Review run failed (${n} attempts): ${failure.detail.slice(0, 300)}`,
          ),
        });
      }
      return;
    }
    this.reviewFailures.delete(ticket.id);
    const rr = run.report!;
    if (rr.kind !== 'review') return;
    const reviewer: Actor = { kind: 'employee', id: run.employeeId };
    const submission = this.records.latestSubmission(ticket);
    const evidence = this.records.evidenceFor(ticket.id, { submission: submission?.id });
    // 대표 직접 확인 요구만 남았다는 이유의 수정 요청은 승인으로 본다(그 확인은 대표 승인 단계에서 한다).
    const attestOnly = new Set(ticket.requirements.filter((r) => r.evidenceType === 'human_attest').map((r) => r.id));
    const unmetOthers = rr.requirements.filter((r) => !r.met && !attestOnly.has(r.id));
    if (rr.verdict === 'approve' || (attestOnly.size > 0 && unmetOthers.length === 0 && rr.requirements.length > 0)) {
      const checks = rr.requirements.map((r) => ({
        requirementId: r.id,
        met: r.met,
        verifiedEvidence: [
          // 인용 증거는 티켓 공통이거나 바로 이 요구사항 전용일 때만 인정한다(다른 요구사항의 대표 확인 전용 금지).
          ...r.evidenceIds.map(
            (id) => evidence.find((e) => e.id === id && e.passed && (!e.requirementId || e.requirementId === r.id))?.type,
          ),
          // 대표의 직접 확인은 검수자가 인용하지 않아도 그 요구사항의 증거가 된다.
          ...evidence.filter((e) => e.type === 'human_attest' && e.passed && e.requirementId === r.id).map((e) => e.type),
        ].filter((x): x is Evidence['type'] => Boolean(x)),
      }));
      try {
        this.apply(ticket.id, { type: 'review_approve', checks }, reviewer);
      } catch (error) {
        if (!(error instanceof DomainError)) throw error;
        this.apply(ticket.id, {
          type: 'hold',
          reason: 'needs_decision',
          note: tr(
            `검수자는 승인했지만 시스템이 거부했습니다: ${error.message}`,
            `Reviewer approved, but the system rejected it: ${error.message}`,
          ),
        });
      }
    } else {
      const reasons = unmetOthers.map((r) => `- ${r.id}: ${r.reason}`);
      this.apply(ticket.id, { type: 'review_request_changes', reason: [rr.summary, ...reasons].join('\n') }, reviewer);
    }
  }

  // ======================= 제출 검증 =======================

  private async verify(ticketId: string): Promise<void> {
    const ticket = this.company.requireTicket(ticketId);
    if (ticket.status !== 'verifying') return;
    const project = this.company.requireProject(ticket.projectId);
    const sub = this.records.latestSubmission(ticket);
    if (!sub) {
      this.apply(ticketId, { type: 'verification_failed', reason: tr('제출 기록이 없습니다.', 'No submission record.') });
      return;
    }
    if (sub.refViolations.length || sub.originChanged) {
      this.apply(ticketId, {
        type: 'scope_violation',
        paths: [
          ...sub.refViolations.map((r) => `ref:${r}`),
          ...(sub.originChanged ? [tr('원본 저장소 작업 트리', 'Original repository working tree')] : []),
        ],
      });
      return;
    }
    if (!sub.headSha) {
      if (ticket.type === 'impl' || ticket.type === 'doc') {
        this.apply(ticketId, {
          type: 'verification_failed',
          reason: tr(
            '변경된 파일이 없습니다. "완료" 보고와 달리 실제 변경이 없습니다.',
            'No files changed. The completion report has no actual changes.',
          ),
        });
        return;
      }
    } else {
      const scope = checkScope(sub.changedPaths, ticket.writeScope, project.protectedPaths);
      if (!scope.ok) {
        this.apply(ticketId, {
          type: 'scope_violation',
          paths: [...scope.outOfScope, ...scope.protectedTouched.map((p) => tr(`보호:${p}`, `Protected:${p}`))],
        });
        return;
      }
    }

    const head = sub.headSha ?? sub.baseSha ?? '';
    const now = () => new Date().toISOString();
    const diffEvidence: Evidence = {
      id: newId('EV'),
      ticketId,
      round: ticket.round,
      headSha: head,
      type: 'inspection',
      label: tr('diff (검수자 판단용)', 'diff (for reviewer assessment)'),
      argv: null,
      exitCode: null,
      passed: true,
      outputPath: null,
      summary: tr(
        `${sub.changedPaths.length}개 파일 변경`,
        `${sub.changedPaths.length} file${sub.changedPaths.length === 1 ? '' : 's'} changed`,
      ),
      createdAt: now(),
    };
    this.records.saveEvidence(diffEvidence, sub.id);

    const failures: string[] = [];
    if (project.verifyCommands.length && sub.headSha) {
      const paths = projectPaths(this.opts.dataDir, project.id);
      // 남은 이전 검증을 "먼저" 끝낸 뒤 작업공간을 초기화한다(종료 전에 초기화하면 이전 프로세스가 다시 파일을 바꿀 수 있다).
      await this.stopLeftoverVerify(ticketId);
      const vwt = await ensureDetachedWorktree(paths, 'verify', ticketId, sub.headSha);
      // 검증 명령은 제출된 코드를 실행한다(CI와 같음). 실행 전후로 원본 저장소와 미러 ref를 비교해 부작용을 잡는다.
      // 기준 스냅샷은 DB에 남겨, 검증 중 재시작해도 "이미 바뀐 원본"을 새 기준으로 삼지 않는다.
      const before = await this.verifyBaseline(`verify_base:${ticketId}`, project, paths);
      try {
        // 깨끗한 사본에는 의존성이 없다(실측: npm test가 항상 실패). 설치 명령이 따로 없으면 먼저 설치한다.
        const setup = dependencySetup(vwt, project.verifyCommands);
        const steps = setup ? [setup, ...project.verifyCommands] : project.verifyCommands;
        for (const [i, vc] of steps.entries()) {
          const ev = await this.runVerifyCommand(vc, vwt, path.join(sub.runDir, 'verify', String(i)), ticketId);
          const e: Evidence = {
            id: newId('EV'),
            ticketId,
            round: ticket.round,
            headSha: sub.headSha,
            type: vc.evidenceType,
            label: vc.label,
            argv: vc.argv,
            ...ev,
            createdAt: now(),
          };
          this.records.saveEvidence(e, sub.id);
          if (!e.passed)
            failures.push(
              tr(
                `${vc.label} 실패 (exit ${e.exitCode ?? '-'}):\n${e.summary}`,
                `${vc.label} failed (exit ${e.exitCode ?? '-'}):\n${e.summary}`,
              ),
            );
        }
      } finally {
        const violations = await this.withProjectLock(project.id, async () => {
          const out: string[] = [];
          if ((await originFingerprint(project.originPath)) !== before.origin)
            out.push(tr('검증 명령 실행 중 원본 저장소 변경', 'Original repository changed during verification'));
          for (const r of this.unexplained(project, 'mirror', before.refs, await snapshotRefs(paths.mirror), before.seq))
            out.push(tr(`검증 중 ref:${r}`, `Ref during verification:${r}`));
          for (const r of this.unexplained(project, 'origin', before.originRefs, await snapshotRefs(project.originPath), before.seq))
            out.push(tr(`검증 중 원본 ref:${r}`, `Original ref during verification:${r}`));
          return out;
        });
        if (violations.length) {
          // 기준 삭제와 격리 기록은 같은 트랜잭션: 사이에서 죽어도 "기준 없음 + 판정 없음" 상태가 남지 않는다.
          this.company.store.transact(() => {
            this.company.store.setSetting(`verify_base:${ticketId}`, '');
            this.apply(ticketId, { type: 'scope_violation', paths: violations });
          });
          return;
        }
      }
    }
    this.changed('ticket', ticketId);
    this.company.store.transact(() => {
      this.company.store.setSetting(`verify_base:${ticketId}`, '');
      if (failures.length)
        this.apply(ticketId, {
          type: 'verification_failed',
          reason: tr(`시스템 검증 실패:\n${failures.join('\n\n')}`, `System verification failed:\n${failures.join('\n\n')}`),
        });
      else this.apply(ticketId, { type: 'verification_passed' });
    });
  }

  /** 검증 기준 스냅샷: 중단된 이전 시도의 기준이 남아 있으면 그것을 쓴다(가장 이른 기준). */
  private async verifyBaseline(
    key: string,
    project: Project,
    paths: ReturnType<typeof projectPaths>,
    lock = true,
  ): Promise<{ origin: string; refs: Record<string, string>; originRefs: Record<string, string>; seq: number }> {
    const saved = this.company.store.getSetting(key);
    if (saved) return JSON.parse(saved);
    const take = async () => ({
      origin: await originFingerprint(project.originPath),
      refs: await snapshotRefs(paths.mirror),
      originRefs: await snapshotRefs(project.originPath),
      seq: this.records.currentMoveSeq(),
    });
    // 반영 중(이미 프로젝트 잠금 안)에는 잠금을 다시 잡지 않는다.
    const snap = lock ? await this.withProjectLock(project.id, take) : await take();
    this.company.store.setSetting(key, JSON.stringify(snap));
    return snap;
  }

  /** 이전 데몬이 남긴 검증 실행을 끝낸다: 셔틀 기록을 찾아 CLI 그룹까지 종료하고, 아직 시작 전이면 포기 표시로 막는다. */
  private async stopLeftoverVerify(ticketId: string): Promise<void> {
    const raw = this.company.store.getSetting(`verify_proc:${ticketId}`);
    if (!raw) return;
    const rec = JSON.parse(raw) as { runDir?: string };
    if (rec.runDir) await abandonAndTerminate(rec.runDir);
    this.company.store.setSetting(`verify_proc:${ticketId}`, '');
  }

  private async runVerifyCommand(
    vc: Project['verifyCommands'][number],
    cwd: string,
    baseRunDir: string,
    ticketId?: string,
  ): Promise<{ exitCode: number | null; passed: boolean; outputPath: string | null; summary: string }> {
    // 시도마다 고유 폴더: 이전 시도의 exit.json을 새 실행의 결과로 착각하지 않는다.
    const runDir = `${baseRunDir}-${Date.now()}-${randomBytes(3).toString('hex')}`;
    // 프로세스를 띄우기 전에 실행 폴더를 먼저 기록한다(띄운 직후 죽어도 복구가 셔틀 기록을 찾을 수 있게).
    if (ticketId) this.company.store.setSetting(`verify_proc:${ticketId}`, JSON.stringify({ runDir }));
    const [cmd, ...rest] = nodeTestArgs(vc.argv, cwd);
    const located = cmd ? await locateExecutable(cmd) : null;
    if (!located?.launch)
      return {
        exitCode: null,
        passed: false,
        outputPath: null,
        summary: tr(`실행 파일 ${cmd}을(를) 찾지 못했습니다.`, `Executable ${cmd} not found.`),
      };
    const proc = await startProcess({
      file: located.launch.file,
      args: [...located.launch.argsPrefix, ...rest],
      cwd,
      env: { ...process.env, CI: '1' },
      stdinText: null,
      runDir,
      timeoutMs: vc.timeoutMs ?? 15 * 60_000,
    });
    const o = await proc.done;
    if (ticketId) this.company.store.setSetting(`verify_proc:${ticketId}`, '');
    const tail = async (f: string) => (await readFile(f, 'utf8').catch(() => '')).slice(-1500);
    const summary = `${await tail(proc.stdoutPath)}\n${await tail(proc.stderrPath)}`.trim().slice(-1500);
    return {
      exitCode: o.exitCode,
      passed: o.exitCode === 0 && !o.timedOut,
      outputPath: proc.stdoutPath,
      summary: o.timedOut ? tr(`시간 초과\n${summary}`, `Timed out\n${summary}`) : summary,
    };
  }

  // ======================= 독립 검수 =======================

  private startReview(t: Ticket): void {
    const reviewer = this.company.requireEmployee(t.reviewerId!);
    if (!reviewer.active) {
      this.apply(t.id, {
        type: 'hold',
        reason: 'needs_decision',
        note: tr(`검수자 ${reviewer.name}이(가) 비활성 상태입니다.`, `Reviewer ${reviewer.name} is inactive.`),
      });
      return;
    }
    if (this.liveCountFor(reviewer.cli) >= (this.opts.concurrency[reviewer.cli] ?? 1)) return;
    this.runBusy(t.id, async () => {
      const project = this.company.requireProject(t.projectId);
      const sub = this.records.latestSubmission(t);
      const head = sub?.headSha ?? sub?.baseSha;
      if (!sub || !head || !sub.baseSha) return;
      const paths = projectPaths(this.opts.dataDir, project.id);
      const rwt = await ensureDetachedWorktree(paths, 'review', t.id, head);
      const nonce = randomBytes(6).toString('hex');
      const prompt = buildReviewPrompt({
        employee: reviewer,
        project,
        ticket: t,
        nonce,
        diff: sub.headSha
          ? await reviewDiffText(paths.mirror, sub.baseSha, sub.headSha)
          : tr('(파일 변경 없음: 조사·보고 업무)', '(No file changes: research/report task)'),
        changedPaths: sub.changedPaths,
        evidence: this.records.evidenceFor(t.id, { submission: sub.id }),
        assigneeSummary: sub.summary,
        decisions: this.records.decisions(project.id, 'current'),
        language: this.opts.language,
      });
      // 검수자는 항상 읽기 전용으로 실행한다.
      await this.launch({
        ticket: t,
        employee: reviewer,
        kind: 'review',
        cwd: rwt,
        prompt,
        nonce,
        accessLevel: 'read-only',
        baseSha: sub.baseSha,
      });
    });
  }

  // ======================= 대표 승인과 반영 =======================

  private integrationSubject(t: Ticket, sub: RunRecord): string {
    return [t.id, sub.baseSha, sub.headSha, sha256(sub.changedPaths.join('\n'))].join('|');
  }

  private ensureIntegrationApproval(t: Ticket): void {
    this.screens.maybeScreenCheck(t);
    if (this.records.pendingApprovalFor(t.id, 'integrate')) return;
    if (t.type === 'review') {
      const claims = this.roundClaims(t);
      const escalated = claims.filter((c) => c.status === 'escalated');
      this.records.createApproval({
        kind: 'integrate',
        ticketId: t.id,
        subject: this.reviewSubject(t),
        summary: tr(
          `${t.id} ${t.title} — 주장 ${claims.length}개, 미해결 ${escalated.length}개`,
          `${t.id} ${t.title} — ${claims.length} claims, ${escalated.length} unresolved`,
        ),
        detail: {
          mode: 'review',
          claims: claims.length,
          escalated: escalated.map((c) => ({ id: c.id, text: c.text, verdict: c.verdict, response: c.response })),
        },
        requestedBy: 'orchestrator',
      });
      this.changed('approval', t.id);
      return;
    }
    const sub = this.records.latestSubmission(t);
    if (!sub) return;
    const project = this.company.requireProject(t.projectId);
    this.records.createApproval({
      kind: 'integrate',
      ticketId: t.id,
      subject: this.integrationSubject(t, sub),
      summary: tr(
        `${t.id} ${t.title} — ${sub.changedPaths.length}개 파일 변경`,
        `${t.id} ${t.title} — ${sub.changedPaths.length} file${sub.changedPaths.length === 1 ? '' : 's'} changed`,
      ),
      detail: {
        headSha: sub.headSha,
        baseSha: sub.baseSha,
        changedPaths: sub.changedPaths,
        mode: project.integrationMode,
        summary: sub.summary,
        // 대표가 구현자 말만 보고 승인하지 않게: 이번 제출물을 본 검수자의 의견(검수를 건너뛰었으면 없음).
        review: (() => {
          const rv = this.records
            .runsForTicket(t.id)
            .filter((r) => r.kind === 'review' && r.status === 'succeeded' && r.round === t.round)
            .at(-1);
          return rv ? { by: rv.employeeId, summary: rv.summary } : null;
        })(),
      },
      requestedBy: 'orchestrator',
    });
    this.changed('approval', t.id);
  }

  /**
   * 검수 통과하면 자동 반영(프로젝트 설정). 실측(2026-09-30): 뒤 업무가 앞 업무의 대표 승인을 기다리며 멈췄다.
   * 대표 직접 확인 항목이 있거나, 검수를 건너뛰었거나, 하위 직급이 검수했으면 대표에게 남긴다.
   * tick에서만 부른다(상태 전이 안에서 또 전이하지 않게).
   */
  private maybeAutoApprove(t: Ticket): void {
    const project = this.company.requireProject(t.projectId);
    if (!project.autoApprove || t.hold || t.type === 'review' || t.reviewBelowRank) return;
    if (t.requirements.some((r) => r.evidenceType === 'human_attest')) return;
    const a = this.records.pendingApprovalFor(t.id, 'integrate');
    const reviewed = this.records
      .runsForTicket(t.id)
      .some(
        (r) =>
          r.kind === 'review' &&
          r.status === 'succeeded' &&
          r.round === t.round &&
          r.report?.kind === 'review' &&
          r.report.verdict === 'approve',
      );
    if (!a || !reviewed) return;
    try {
      this.decideIntegration(a.id, 'approved', { auto: true });
      const room = this.chat.ensureTicketChannel(t.id);
      if (room)
        this.chat.post(
          room.id,
          'system',
          tr(
            '검수를 통과해 대표 설정(검수 통과하면 자동 반영)에 따라 반영합니다.',
            'Review passed; merging automatically per the project setting.',
          ),
          'event',
        );
    } catch {
      // 승인 대상이 바뀌었으면 새 승인 요청이 생긴다: 다음 tick에 다시 본다.
    }
  }

  /** 대표의 승인·거부. mode를 주면 이번 반영에만 그 방식을 쓴다. */
  decideIntegration(
    approvalId: string,
    decision: 'approved' | 'rejected',
    opts: {
      mode?: Project['integrationMode'];
      reason?: string;
      attested?: string[];
      deferred?: string[];
      auto?: boolean;
      by?: string;
    } = {},
  ): Ticket {
    const t = this.decideIntegrationCore(approvalId, decision, opts);
    // 확인이 끝났으니 띄워 둔 미리보기를 끈다(반려 뒤 새 제출물이 오면 새로 띄운다).
    this.stopTicketPreview(t);
    return t;
  }

  private decideIntegrationCore(
    approvalId: string,
    decision: 'approved' | 'rejected',
    opts: { mode?: Project['integrationMode']; reason?: string; attested?: string[]; deferred?: string[]; auto?: boolean; by?: string },
  ): Ticket {
    const a = this.records.approval(approvalId);
    if (!a || a.kind !== 'integrate' || a.state !== 'pending' || !a.ticketId)
      throw new DomainError(tr('처리할 수 없는 승인입니다.', 'This approval cannot be processed.'));
    const t = this.company.requireTicket(a.ticketId);
    const sub = this.records.latestSubmission(t);
    const tx = <T>(fn: () => T): T => this.company.store.transact(fn);
    if (t.type === 'review' && decision === 'approved') {
      if (sha256(this.reviewSubject(t)) !== a.subjectHash)
        throw new DomainError(
          tr('검토 결과가 바뀌었습니다. 새 승인 요청을 확인하세요.', 'Review results changed. Check the new approval request.'),
        );
      return tx(() => {
        this.records.setApprovalState(approvalId, 'approved', 'ceo', { mode: 'review' });
        return this.apply(t.id, { type: 'ceo_approve' }, CEO);
      });
    }
    if (decision === 'rejected') {
      return tx(() => {
        this.records.setApprovalState(approvalId, 'rejected', opts.by ?? 'ceo', { reason: opts.reason ?? '' });
        return this.apply(t.id, { type: 'ceo_reject', reason: opts.reason || tr('대표가 반려했습니다.', 'Rejected by the CEO.') }, CEO);
      });
    }
    if (!sub || sha256(this.integrationSubject(t, sub)) !== a.subjectHash) {
      this.records.setApprovalState(approvalId, 'expired', 'orchestrator', {
        reason: tr('승인 대상이 바뀌었습니다.', 'Approval subject changed.'),
      });
      throw new DomainError(
        tr(
          '승인 요청 이후 제출물이 바뀌어 승인이 무효가 되었습니다. 새 승인 요청을 확인하세요.',
          'Submission changed after the approval request, invalidating approval. Check the new request.',
        ),
      );
    }
    // 대표 직접 확인 요구: 이번 제출물에 대해 대표가 확인했어야 한다(승인 화면의 체크 = 확인 기록).
    const attested = new Set(
      this.records
        .evidenceFor(t.id, { submission: sub.id })
        .filter((e) => e.type === 'human_attest' && e.passed && e.requirementId)
        .map((e) => e.requirementId!),
    );
    const missing = t.requirements.filter((r) => r.evidenceType === 'human_attest' && !attested.has(r.id));
    const checkedNow = missing.filter((r) => opts.attested?.includes(r.id));
    // "지금은 확인 못 함 → 나중에": 확인한 척 체크하지 않고 반영하되, 대표 할 일로 남긴다.
    // 실측(2026-10-01, 눈 휴식): 들어 볼 페이지가 없는 알림음을 "들어 보고 확인"에 체크해야 승인되어, 확인 못 한 채 체크했다.
    const deferred = missing.filter((r) => !opts.attested?.includes(r.id) && opts.deferred?.includes(r.id));
    if (checkedNow.length + deferred.length < missing.length)
      throw new DomainError(
        tr(
          `대표 직접 확인 항목을 확인하고 체크하세요: ${missing.map((r) => r.id).join(', ')}`,
          `Check the items that need your own confirmation first: ${missing.map((r) => r.id).join(', ')}`,
        ),
      );
    for (const r of checkedNow) this.attest(t.id, r.id, tr('승인하면서 대표가 직접 확인했습니다.', 'Confirmed by the CEO when approving.'));
    if (deferred.length) {
      this.company.store.setSetting(
        `later_checks:${t.id}`,
        JSON.stringify([...this.laterChecks(t.id), ...deferred.map((r) => ({ id: r.id, text: r.text, at: new Date().toISOString() }))]),
      );
      this.company.store.appendEvent('ceo', 'evidence.deferred', t.id, { requirementIds: deferred.map((r) => r.id) });
    }
    const mode = opts.mode ?? (a.detail as { mode: Project['integrationMode'] }).mode;
    return tx(() => {
      // 자동 반영은 대표가 켠 설정에 따른 것: 기록에는 'auto'로 남겨 대표가 직접 누른 승인과 구분한다.
      this.records.setApprovalState(approvalId, 'approved', opts.auto ? 'auto' : 'ceo', { mode, ...(opts.auto ? { auto: true } : {}) });
      return this.apply(t.id, { type: 'ceo_approve' }, CEO);
    });
  }

  private async integrate(ticketId: string): Promise<void> {
    const t = this.company.requireTicket(ticketId);
    if (t.status !== 'integrating') return;
    const approvalFor = () =>
      this.records
        .approvals('approved')
        .filter((a) => a.ticketId === ticketId && a.kind === 'integrate')
        .at(-1);
    const finishWithout = (commitSha: string) =>
      this.company.store.transact(() => {
        const a = approvalFor();
        if (a) this.records.setApprovalState(a.id, 'consumed', 'orchestrator', {});
        this.apply(ticketId, { type: 'integrated', commitSha });
      });
    if (t.type === 'review') return finishWithout('review-acknowledged');
    const project = this.company.requireProject(t.projectId);
    const sub = this.records.latestSubmission(t);
    const approval = approvalFor();
    if (sub && !sub.headSha && approval && t.type === 'research') return finishWithout('no-changes'); // 조사 결과는 반영할 파일이 없다
    if (!sub?.headSha || !approval) {
      this.apply(ticketId, {
        type: 'integration_failed',
        reason: tr('반영할 제출물 또는 승인 기록이 없습니다.', 'No submission or approval record for integration.'),
      });
      return;
    }
    const mode = (approval.detail as { mode?: Project['integrationMode'] }).mode ?? project.integrationMode;
    const paths = projectPaths(this.opts.dataDir, project.id);
    await this.withProjectLock(project.id, () => this.integrateLocked(t, project, sub, approval, mode, paths));
  }

  private async integrateLocked(
    t: Ticket,
    project: Project,
    sub: RunRecord,
    approval: NonNullable<ReturnType<Records['approval']>>,
    mode: Project['integrationMode'],
    paths: ReturnType<typeof projectPaths>,
  ): Promise<void> {
    const ticketId = t.id;
    if (!sub.headSha) return;
    // 잠금을 기다리는 동안 취소·보류되었거나 승인이 바뀌었으면 원본을 건드리지 않는다.
    const current = this.company.requireTicket(ticketId);
    if (current.status !== 'integrating' || current.hold || this.records.approval(approval.id)?.state !== 'approved') return;
    const mirrorBaseBefore =
      (await git(['rev-parse', '--verify', '-q', `refs/heads/${project.baseBranch}`], paths.mirror, { allowFail: true })).stdout.trim() ||
      null;
    const originBranchBefore =
      (
        await git(['rev-parse', '--verify', '-q', `refs/heads/${ticketBranch(ticketId)}`], project.originPath, { allowFail: true })
      ).stdout.trim() || null;
    try {
      const result =
        mode === 'auto_after_approval'
          ? await integrateWithMerge(project.originPath, paths, t.id, project.baseBranch, sub.headSha, t.title, async (mergeSha) => {
              if (!project.verifyCommands.length) return { ok: true };
              await this.stopLeftoverVerify(t.id);
              const vwt = await ensureDetachedWorktree(paths, 'verify', t.id, mergeSha);
              const base = await this.verifyBaseline(`mergeverify_base:${t.id}`, project, paths, false);
              const fp = base.origin;
              const originRefs = base.originRefs;
              const mirrorRefs = base.refs;
              const seq = base.seq;
              let failed: string | null = null;
              try {
                const setup = dependencySetup(vwt, project.verifyCommands);
                for (const [i, vc] of (setup ? [setup, ...project.verifyCommands] : project.verifyCommands).entries()) {
                  const r = await this.runVerifyCommand(vc, vwt, path.join(sub.runDir, `merge-verify-${Date.now()}`, String(i)), t.id);
                  if (!r.passed) {
                    failed = `${vc.label}: ${r.summary.slice(-300)}`;
                    break;
                  }
                }
              } finally {
                const touched =
                  (await originFingerprint(project.originPath)) !== fp ||
                  this.unexplained(project, 'origin', originRefs, await snapshotRefs(project.originPath), seq).length > 0 ||
                  this.unexplained(project, 'mirror', mirrorRefs, await snapshotRefs(paths.mirror), seq).length > 0;
                // 정책 위반은 일반 테스트 실패와 다르다: 브랜치 반영으로 강등하지 않고 반영 자체를 멈춘다.
                if (touched)
                  throw new Error(
                    tr(
                      '병합 재검증 명령이 원본 저장소나 미러를 변경했습니다. 반영을 중단했습니다.',
                      'Merge re-verification changed the original repository or mirror. Integration stopped.',
                    ),
                  );
              }
              if (failed) return { ok: false, reason: failed };
              return { ok: true };
            })
          : await integrateAsBranch(project.originPath, paths, t.id, sub.headSha);
      const baseRef = `refs/heads/${project.baseBranch}`;
      const baseNow = await headSha(paths.mirror, baseRef);
      const commit = result.kind === 'merged' ? result.mergeSha : result.sha;
      this.company.store.transact(() => {
        // 반영으로 생긴 ref 이동을 전이로 기록한다(미러 기준 브랜치 동기화, 원본 브랜치·기준 브랜치 이동).
        this.records.recordRefMove(project.id, 'mirror', baseRef, mirrorBaseBefore, baseNow);
        if (result.kind === 'merged')
          this.records.recordRefMove(project.id, 'origin', `refs/heads/${result.baseBranch}`, result.previousBaseSha, result.mergeSha);
        else this.records.recordRefMove(project.id, 'origin', `refs/heads/${result.branch}`, originBranchBefore, result.sha);
        this.records.setApprovalState(approval.id, 'consumed', 'orchestrator', { result });
        this.company.store.appendEvent('orchestrator', 'ticket.integration_result', ticketId, result);
        this.company.store.setSetting(`mergeverify_base:${ticketId}`, '');
        // 최신 기준과 충돌(또는 합친 결과 검사 실패)한 자동 반영은 완료가 아니다: 담당자에게 돌려보내고,
        // 다음 작업 시작 때 최신 기준을 업무 폴더에 합쳐 준다.
        // 실측(2026-10-01, 물 마시기): 충돌로 "따로 보관"되고도 완료 처리되어, 코드가 내 폴더에 없는데 뒤 업무가 시작했다.
        if (result.kind === 'downgraded' && result.sendBack) {
          this.company.store.setSetting(`catch_up:${ticketId}`, '1');
          this.apply(ticketId, {
            type: 'merge_conflict',
            reason: tr(
              `내 폴더에 반영하려는데 그사이 다른 업무가 바꾼 내용과 겹쳤습니다(${result.reason}). 이번 작업을 시작할 때 최신 기준을 업무 폴더에 합쳐 두었습니다: 충돌 표시(<<<<<<< ======= >>>>>>>)가 남은 파일을 정리해 양쪽 변경을 모두 살리고, 이미 기준에 들어온 것은 다시 만들지 마세요.`,
              `Merging into the CEO's folder collided with another ticket's changes (${result.reason}). The latest base is merged into your folder at the start of this run: resolve the conflict markers (<<<<<<< ======= >>>>>>>) keeping both sides, and do not rebuild what is already in the base.`,
            ),
          });
          return;
        }
        this.apply(ticketId, { type: 'integrated', commitSha: commit });
      });
      if (result.kind === 'merged') await this.recheckWaiting(project, paths, ticketId, result.mergeSha).catch(() => {});
      // 그 밖의 강등(예: 내 폴더에 커밋하지 않은 변경)은 완료로 두되 대표에게 알린다(조용히 따로 보관되지 않게).
      if (result.kind === 'downgraded' && !result.sendBack)
        this.desk.notice(
          tr(`${ticketId}를 내 폴더에 바로 반영하지 못했습니다`, `${ticketId} could not be merged into your folder`),
          tr(`따로 보관(${result.branch})했습니다: ${result.reason}`, `Kept on ${result.branch}: ${result.reason}`),
          `/tickets/${ticketId}`,
        );
      await this.autoVerifyCommands(project.id).catch(() => {});
    } catch (error) {
      this.company.store.transact(() => {
        this.company.store.setSetting(`mergeverify_base:${ticketId}`, '');
        this.apply(ticketId, { type: 'integration_failed', reason: String((error as Error).message ?? error) });
      });
    }
  }

  /**
   * 반영 대기열: 한 업무가 내 폴더에 들어가면, 검수·승인을 기다리는 같은 프로젝트의 다른 업무를 새 기준과 미리 합쳐 본다
   * (실제로 합치지 않고 git merge-tree로 계산만). 충돌이 예상되면 대표가 확인하기 전에 담당자에게 돌려보내고,
   * 다음 작업 때 최신 기준을 업무 폴더에 합쳐 준다. 대표 요청(2026-10-01): Gas Town의 병합 대기열(Refinery)처럼.
   */
  private async recheckWaiting(project: Project, paths: ReturnType<typeof projectPaths>, mergedId: string, base: string): Promise<void> {
    for (const t of this.company.tickets()) {
      if (t.id === mergedId || t.projectId !== project.id || !['in_review', 'awaiting_approval'].includes(t.status) || t.hold) continue;
      const head = this.records.latestSubmission(t)?.headSha;
      if (!head) continue;
      const r = await git(['merge-tree', '--write-tree', '--name-only', '--no-messages', base, head], paths.mirror, { allowFail: true });
      if (r.code !== 1) continue; // 0이면 깨끗하다. 그 밖(판단 불가)은 반영할 때 다시 본다.
      const files = r.stdout.trim().split('\n').slice(1).filter(Boolean);
      const pending = this.records.pendingApprovalFor(t.id, 'integrate');
      this.company.store.transact(() => {
        if (pending)
          this.records.setApprovalState(pending.id, 'expired', 'orchestrator', {
            reason: tr(`${mergedId} 반영으로 충돌 예상`, `Conflict expected after ${mergedId} merged`),
          });
        this.company.store.setSetting(`catch_up:${t.id}`, '1');
        this.apply(t.id, {
          type: 'base_conflict',
          reason: tr(
            `${mergedId}가 먼저 내 폴더에 들어가면서 이 업무와 같은 곳이 바뀌었습니다(${files.join(', ')}). 대표가 확인하기 전에 돌려보냅니다: 이번 작업을 시작할 때 최신 기준을 업무 폴더에 합쳐 두었으니, 충돌 표시(<<<<<<< ======= >>>>>>>)를 정리해 양쪽 변경을 모두 살려 주세요.`,
            `${mergedId} was merged first and changed the same places (${files.join(', ')}). Sent back before the CEO checks it: the latest base is merged into your folder at the start of this run; resolve the conflict markers keeping both sides.`,
          ),
        });
      });
      const room = ticketChannelId(t.id);
      if (this.chat.channel(room))
        this.chat.post(
          room,
          'system',
          tr(
            `🔀 ${mergedId}가 먼저 반영되어 충돌이 예상됩니다(${files.join(', ')}). 대표 확인 전에 담당자에게 돌려보냈습니다.`,
            `🔀 ${mergedId} merged first; a conflict is expected (${files.join(', ')}). Sent back before the CEO's check.`,
          ),
          'event',
        );
    }
  }

  // ======================= 실행 중 권한 요청(GUI 중계) =======================

  private async pollToolApprovals(): Promise<void> {
    for (const run of this.records.runsByStatus('running')) {
      if (!run.approvalDir) continue;
      const files = await readdir(run.approvalDir).catch(() => [] as string[]);
      for (const f of files.filter((x) => x.endsWith('.request.json'))) {
        const reqId = f.replace('.request.json', '');
        const exists = this.records
          .approvals()
          .some((a) => a.kind === 'tool_permission' && (a.detail as { requestId?: string }).requestId === reqId);
        if (exists || files.includes(`${reqId}.decision.json`)) continue;
        const req = JSON.parse(await readFile(path.join(run.approvalDir, f), 'utf8')) as { kind: string; detail: unknown };
        this.records.createApproval({
          kind: 'tool_permission',
          ticketId: run.ticketId,
          subject: `${run.id}|${reqId}|${JSON.stringify(req.detail)}`,
          summary: tr(`${run.ticketId}: ${req.kind} 실행 허가 요청`, `${run.ticketId}: permission requested for ${req.kind}`),
          detail: { requestId: reqId, runId: run.id, approvalDir: run.approvalDir, tool: req.kind, input: req.detail },
          requestedBy: run.employeeId,
        });
        this.changed('approval', run.ticketId);
      }
    }
    await this.delegateToolApprovals();
  }

  /** 권한 요청 위임 처리자: 활성 직원 중 전체 자동(4) 등급, 직급이 가장 높은 직원. 없으면 대표가 처리한다. */
  permissionDelegate(): Employee | null {
    return (
      this.company
        .activeEmployees()
        .filter((e) => e.accessLevel === 'full-auto')
        .sort((a, b) => RANK_ORDER[rankOf(b)] - RANK_ORDER[rankOf(a)])[0] ?? null
    );
  }

  /** 대기 중인 권한 요청을 위임 처리자가 대신 결정한다: 치명적인 것만 막고 나머지는 허용(대표 결정, 2026-09-30). */
  private async delegateToolApprovals(): Promise<void> {
    const delegate = this.permissionDelegate();
    if (!delegate) return;
    for (const a of this.records.approvals('pending').filter((x) => x.kind === 'tool_permission')) {
      const d = a.detail as { requestId: string; runId: string; approvalDir: string; tool: string; input: unknown };
      const run = this.records.run(d.runId);
      const verdict = judgeToolRequest({ tool: d.tool, input: d.input, workspace: run?.worktreePath ?? '' });
      await writeDecision(d.approvalDir, d.requestId, {
        decision: verdict.allow ? 'allow' : 'deny',
        ...(verdict.allow
          ? {}
          : { message: tr(`${delegate.name}이(가) 차단: ${verdict.reason}`, `Blocked by ${delegate.name}: ${verdict.reason}`) }),
      });
      this.records.setApprovalState(a.id, verdict.allow ? 'approved' : 'rejected', delegate.id, {
        delegated: true,
        reason: verdict.reason ?? null,
      });
      this.company.store.appendEvent(delegate.id, 'approval.delegated', a.ticketId ?? a.id, {
        allow: verdict.allow,
        tool: d.tool,
        reason: verdict.reason ?? null,
        summary: a.summary,
        // 대표가 나중에 무엇이 허용됐는지 볼 수 있게 실제 명령(앞부분)을 남긴다.
        command: commandOf(d.input)?.slice(0, 300) ?? null,
      });
      this.changed('approval', a.ticketId ?? a.id);
    }
  }

  async decideToolPermission(approvalId: string, allow: boolean, message?: string): Promise<void> {
    const a = this.records.approval(approvalId);
    if (!a || a.kind !== 'tool_permission' || a.state !== 'pending')
      throw new DomainError(tr('처리할 수 없는 권한 요청입니다.', 'This permission request cannot be processed.'));
    const d = a.detail as { requestId: string; approvalDir: string };
    await writeDecision(d.approvalDir, d.requestId, { decision: allow ? 'allow' : 'deny', ...(message ? { message } : {}) });
    this.records.setApprovalState(approvalId, allow ? 'approved' : 'rejected', 'ceo');
    this.changed('approval', a.ticketId ?? approvalId);
  }

  private expireToolApprovals(run: RunRecord): void {
    for (const a of this.records.approvals('pending')) {
      if (a.kind === 'tool_permission' && (a.detail as { runId?: string }).runId === run.id) {
        this.records.setApprovalState(a.id, 'expired', 'orchestrator', { reason: tr('실행이 끝났습니다.', 'Run has ended.') });
      }
    }
  }

  // ======================= 검토형 업무: 블라인드 교차 검토 =======================

  private reviewSubject(t: Ticket): string {
    return `${t.id}|review|${t.round}|${this.roundClaims(t)
      .map((c) => `${c.id}:${c.verdict}:${c.response}:${c.status}`)
      .join(',')}`;
  }

  /** 이번 회차의 주장만. 대표가 반려하면 새 회차에서 처음부터 다시 분석한다. */
  private roundClaims(t: Ticket): Claim[] {
    return this.records.claimsFor(t.id).filter((c) => (c.round ?? 1) === t.round);
  }

  private participants(t: Ticket): Employee[] {
    const key = `delib:${t.id}:participants`;
    const saved = this.company.store.getSetting(key);
    if (saved) return (JSON.parse(saved) as string[]).map((id) => this.company.requireEmployee(id));
    const list = pickPanel(this.company.activeEmployees(), 4);
    this.company.store.setSetting(key, JSON.stringify(list.map((e) => e.id)));
    return list;
  }

  private phaseRuns(t: Ticket, phase: DeliberationPhase, employeeId: string): RunRecord[] {
    return this.records.runsForTicket(t.id).filter((r) => r.phase === phase && r.employeeId === employeeId && r.round === t.round);
  }

  /** 한 단계의 한 직원 실행을 관리한다. 끝났으면 true. 두 번 실패하면 대표 결정으로 보류. */
  private async phaseStep(
    t: Ticket,
    phase: DeliberationPhase,
    e: Employee,
    needed: boolean,
    launch: () => Promise<unknown>,
  ): Promise<boolean> {
    if (!needed) return true;
    const runs = this.phaseRuns(t, phase, e.id);
    if (runs.some((r) => r.status === 'running' && this.liveRuns.has(r.id))) return false;
    if (runs.filter((r) => r.status === 'failed' || r.status === 'orphaned').length >= 2) {
      this.apply(t.id, {
        type: 'hold',
        reason: 'needs_decision',
        note: tr(
          `${e.name}의 ${phase} 단계 실행이 두 번 실패했습니다: ${runs.at(-1)?.reportError ?? ''}`,
          `${e.name} failed the ${phase} phase twice: ${runs.at(-1)?.reportError ?? ''}`,
        ).slice(0, 1500),
      });
      return false;
    }
    if (!e.active) {
      this.apply(t.id, {
        type: 'hold',
        reason: 'needs_decision',
        note: tr(`검토 참여자 ${e.name}이(가) 비활성 상태입니다.`, `Review participant ${e.name} is inactive.`),
      });
      return false;
    }
    if (this.liveCountFor(e.cli) >= (this.opts.concurrency[e.cli] ?? 1)) return false;
    await launch();
    return false;
  }

  private async deliberate(t: Ticket): Promise<void> {
    const people = this.participants(t);
    if (people.length < 2) {
      this.apply(t.id, {
        type: 'hold',
        reason: 'needs_decision',
        note: tr('교차 검토에는 활성 직원이 2명 이상 필요합니다.', 'Cross-review requires at least two active employees.'),
      });
      return;
    }
    const project = this.company.requireProject(t.projectId);
    const paths = projectPaths(this.opts.dataDir, project.id);
    const cwd = async () =>
      this.withProjectLock(project.id, async () => {
        const base = await this.syncMirrorRecorded(project, paths);
        return ensureDetachedWorktree(paths, 'review', `${t.id}-delib`, base);
      });
    const launchPhase = async (e: Employee, phase: DeliberationPhase, prompt: string, nonce: string, claimIds: string[] = []) =>
      this.launch({
        ticket: t,
        employee: e,
        kind: 'analysis',
        cwd: await cwd(),
        prompt,
        nonce,
        accessLevel: 'read-only',
        baseSha: null,
        phase,
        claimIds,
      });
    const nonce = () => randomBytes(6).toString('hex');

    // 1) 블라인드 분석: 모든 참여자가 서로의 결과를 보지 않고 주장을 낸다.
    let allDone = true;
    for (const e of people) {
      const done = this.phaseRuns(t, 'blind', e.id).some((r) => r.status === 'succeeded');
      const n = nonce();
      const ok = await this.phaseStep(t, 'blind', e, !done, () =>
        launchPhase(e, 'blind', blindPrompt(e, project, t, n, this.opts.language, this.lastFeedback(t)), n),
      );
      allDone &&= ok;
    }
    if (!allDone || this.company.requireTicket(t.id).hold) return;

    // 2) 교차 판정: 작성자가 아닌 다른 참여자(가능하면 다른 CLI)에게 배정. 작성자는 가린다.
    let claims = this.roundClaims(t);
    const load = new Map<string, number>();
    for (const c of claims) {
      if (c.reviewerId) continue;
      const author = people.find((p) => p.id === c.authorId);
      const candidates = people.filter((p) => p.id !== c.authorId);
      const pick = [...candidates].sort(
        (a, b) => (a.cli !== author?.cli ? 0 : 1) - (b.cli !== author?.cli ? 0 : 1) || (load.get(a.id) ?? 0) - (load.get(b.id) ?? 0),
      )[0]!;
      load.set(pick.id, (load.get(pick.id) ?? 0) + 1);
      this.records.saveClaim({ ...c, reviewerId: pick.id, status: 'under_review' });
    }
    claims = this.roundClaims(t);
    allDone = true;
    for (const e of people) {
      const mine = claims.filter((c) => c.reviewerId === e.id && c.verdict === null);
      const n = nonce();
      const ok = await this.phaseStep(t, 'cross', e, mine.length > 0, () =>
        launchPhase(
          e,
          'cross',
          crossPrompt(e, project, t, n, mine, this.opts.language),
          n,
          mine.map((c) => c.id),
        ),
      );
      allDone &&= ok;
    }
    if (!allDone || this.company.requireTicket(t.id).hold) return;

    // 3) 재답변: 동의가 아닌 모든 판정에 원 작성자가 답해야 다음으로 넘어간다.
    claims = this.roundClaims(t);
    allDone = true;
    for (const e of people) {
      const mine = claims.filter((c) => c.authorId === e.id && c.verdict !== 'agree' && c.response === null);
      const n = nonce();
      const ok = await this.phaseStep(t, 'rebuttal', e, mine.length > 0, () =>
        launchPhase(
          e,
          'rebuttal',
          rebuttalPrompt(e, project, t, n, mine, this.opts.language),
          n,
          mine.map((c) => c.id),
        ),
      );
      allDone &&= ok;
    }
    if (!allDone || this.company.requireTicket(t.id).hold) return;

    // 4) 코드 종합: 미해결 이견은 삭제하지 않고 대표에게 올린다.
    claims = this.roundClaims(t);
    const { resolved, escalated } = synthesize(claims);
    this.company.store.transact(() => {
      for (const c of [...resolved, ...escalated]) this.records.saveClaim(c);
    });
    this.apply(t.id, { type: 'deliberation_done', claims: claims.length, escalated: escalated.length });
  }

  private async finishDeliberationRun(run: RunRecord, finalText: string | null, failDetail: string): Promise<void> {
    const t = this.company.requireTicket(run.ticketId);
    let error: string | null = null;
    if (run.phase === 'blind') {
      const r = parseClaims(finalText, run.nonce);
      if (r.ok) {
        for (const c of r.claims) {
          // 직원이 보낸 필드는 명시적으로 골라 담고, 시스템 식별자(id·작성자·회차)는 덮어쓸 수 없게 뒤에 둔다.
          const claim: Claim = {
            text: c.text,
            impact: c.impact,
            confidence: c.confidence,
            sources: c.sources,
            id: newId('C'),
            ticketId: t.id,
            round: t.round,
            authorId: run.employeeId,
            reviewerId: null,
            verdict: null,
            verdictReason: null,
            response: null,
            responseText: null,
            status: 'proposed',
          };
          this.records.saveClaim(claim);
        }
        run.summary = tr(`주장 ${r.claims.length}개`, `${r.claims.length} claims`);
      } else error = r.detail;
    } else if (run.phase === 'cross') {
      const r = parseVerdicts(finalText, run.nonce, run.claimIds ?? []);
      if (r.ok) {
        for (const v of r.verdicts) {
          const c = this.records.claimsFor(t.id).find((x) => x.id === v.claimId);
          if (c && c.reviewerId === run.employeeId)
            this.records.saveClaim({ ...c, verdict: v.verdict, verdictReason: v.reason, status: 'reviewed' });
        }
        run.summary = tr(`판정 ${r.verdicts.length}개`, `${r.verdicts.length} verdicts`);
      } else error = r.detail;
    } else if (run.phase === 'rebuttal') {
      const r = parseResponses(finalText, run.nonce, run.claimIds ?? []);
      if (r.ok) {
        for (const v of r.responses) {
          const c = this.records.claimsFor(t.id).find((x) => x.id === v.claimId);
          if (c && c.authorId === run.employeeId)
            this.records.saveClaim({ ...c, response: v.response, responseText: v.text, status: 'responded' });
        }
        run.summary = tr(`재답변 ${r.responses.length}개`, `${r.responses.length} responses`);
      } else error = r.detail;
    }
    if (!finalText && !error) error = failDetail || tr('응답 없음', 'No response');
    run.endedAt = new Date().toISOString();
    run.status = error ? 'failed' : 'succeeded';
    run.reportError = error ? `${error}${failDetail && failDetail !== error ? `\n${failDetail.slice(-500)}` : ''}` : null;
    this.records.saveRun(run);
    this.company.store.appendEvent(run.employeeId, `deliberation.${run.phase}.${run.status}`, t.id, {
      runId: run.id,
      summary: run.summary,
      error,
    });
    this.changed('ticket', t.id);
  }

  // ======================= 대표 요청 → 비서실장 초안 =======================

  chiefOfStaff(): Employee | null {
    return this.company.activeEmployees().find((e) => e.roles.includes('chief-of-staff')) ?? null;
  }

  /** 대표 요청을 비서실장에게 보낸다. 비서실장은 읽기 전용으로 저장소를 보고 티켓 초안만 낸다. */
  /** 실패한 초안 요청을 같은 내용으로 다시 보낸다(예전 요청은 버린 것으로 남긴다). */
  async retryRequest(requestId: string): Promise<CeoRequest> {
    const old = this.records.request(requestId);
    if (!old || old.status !== 'failed')
      throw new DomainError(tr('다시 시도할 수 있는 요청이 아닙니다.', 'This request cannot be retried.'));
    this.records.saveRequest({ ...old, status: 'dismissed' });
    const next = await this.submitRequest(old.projectId, old.text);
    const saved = { ...this.records.request(next.id)!, retriedFrom: old.id };
    this.records.saveRequest(saved);
    this.changed('request', next.id);
    return saved;
  }

  async submitRequest(projectId: string, text: string): Promise<CeoRequest> {
    const project = this.company.requireProject(projectId);
    const chief = this.chiefOfStaff();
    if (!chief)
      throw new DomainError(
        tr(
          '비서실장 역할의 활성 직원이 없습니다. 직원에게 비서실장 역할을 주거나 업무를 직접 만드세요.',
          'No active chief of staff. Assign that role to an employee or create a ticket directly.',
        ),
      );
    if (!text.trim()) throw new DomainError(tr('요청 내용이 비어 있습니다.', 'Request is empty.'));
    const req: CeoRequest = {
      id: newId('Q'),
      projectId,
      text: text.trim(),
      status: 'drafting',
      employeeId: chief.id,
      runId: null,
      summary: '',
      drafts: [],
      questions: [],
      error: null,
      ticketIds: [],
      createdAt: new Date().toISOString(),
    };
    this.records.saveRequest(req);
    this.company.store.appendEvent('ceo', 'request.submitted', req.id, { text: req.text.slice(0, 300), chief: chief.id });
    const paths = projectPaths(this.opts.dataDir, project.id);
    const cwd = await this.withProjectLock(project.id, async () => {
      const base = await this.syncMirrorRecorded(project, paths);
      return ensureDetachedWorktree(paths, 'review', `_request-${req.id}`, base);
    });
    const nonce = randomBytes(6).toString('hex');
    const prompt = buildDraftPrompt({
      employee: chief,
      project,
      requestId: req.id,
      request: req.text,
      nonce,
      decisions: this.records.decisions(project.id, 'current'),
      language: this.opts.language,
      team: this.company.activeEmployees().map((e) => `- ${e.name}: ${rankOf(e)}, ${e.roles.join('/')}`),
      // 실측(첫 사용): Antigravity 읽기 전용은 폴더 목록을 볼 수단이 없어, 빈 새 폴더에서 헤매다 빈 답을 냈다.
      files: (await git(['ls-files'], cwd, { allowFail: true })).stdout.split('\n').filter(Boolean),
    });
    await this.launch({
      ticket: { id: req.id, round: 1, budget: DEFAULT_BUDGET },
      employee: chief,
      kind: 'analysis',
      cwd,
      prompt,
      nonce,
      accessLevel: 'read-only',
      baseSha: null,
    });
    const run = this.records.runsForTicket(req.id).at(-1);
    const saved = this.records.request(req.id)!;
    if (run && saved.status === 'drafting') this.records.saveRequest({ ...saved, runId: run.id });
    this.changed('request', req.id);
    return this.records.request(req.id)!;
  }

  private async finishDrafts(
    run: RunRecord,
    finalText: string | null,
    outcome: { timedOut: boolean } | null,
    stderr: string,
  ): Promise<void> {
    const req = this.records.request(run.ticketId);
    const transient = !outcome?.timedOut && isTransient(finalText);
    const parsed = outcome?.timedOut
      ? ({ ok: false, reason: 'timeout', detail: tr('시간 초과', 'Timed out') } as const)
      : parseDrafts(finalText, run.nonce);
    run.endedAt = new Date().toISOString();
    run.status = parsed.ok ? 'succeeded' : 'failed';
    run.reportError = parsed.ok ? null : `${parsed.detail}${stderr ? `\n${stderr.slice(-500)}` : ''}`;
    run.summary = parsed.ok ? parsed.report.summary : '';
    this.records.saveRun(run);
    if (req) {
      this.records.saveRequest({
        ...req,
        runId: run.id,
        status: parsed.ok ? 'drafted' : 'failed',
        summary: parsed.ok ? parsed.report.summary : '',
        drafts: parsed.ok ? parsed.report.tickets : [],
        questions: parsed.ok ? parsed.report.questions : [],
        proposals: parsed.ok ? parsed.report.proposals : [],
        answers: parsed.ok ? parsed.report.questions.map(() => null) : [],
        verifySuggestions: parsed.ok ? parsed.report.verifySuggestions : [],
        profile: parsed.ok ? (parsed.report.profile ?? null) : null,
        error: parsed.ok
          ? null
          : transient && !req.retriedFrom
            ? tr(
                `일시적인 오류라 1분 뒤 자동으로 다시 시도합니다: ${String(finalText).slice(0, 200)}`,
                `Transient error; retrying automatically in a minute: ${String(finalText).slice(0, 200)}`,
              )
            : /auto-denied|cannot prompt for/i.test(stderr)
              ? // 실측(첫 사용): 영어 오류만 보여서 대표가 무엇을 해야 할지 몰랐다.
                tr(
                  `비서실장이 읽기만 하는 실행에서 명령을 쓰려다 막혀 답을 내지 못했습니다. "다시 시도"를 누르거나, 다른 AI 직원에게 비서실장 역할을 맡기세요.\n\n${run.reportError}`,
                  `The chief of staff tried a blocked command in a read-only run and gave no answer. Retry, or give the chief-of-staff role to an employee on another AI.\n\n${run.reportError}`,
                )
              : run.reportError,
      });
      // 일시적 오류(실측: Claude 로그인 토큰 갱신 경합)는 한 번 자동으로 다시 요청한다.
      if (transient && !req.retriedFrom) setTimeout(() => void this.retryRequest(req.id).catch(() => {}), 60_000).unref?.();
      this.company.store.appendEvent(run.employeeId, parsed.ok ? 'request.drafted' : 'request.failed', req.id, {
        count: parsed.ok ? parsed.report.tickets.length : 0,
      });
    }
    this.changed('request', run.ticketId);
  }

  /**
   * 비서실장 질문에 답한다. answer가 null이면 비서실장 제안을 그대로 받아들인다.
   * 답은 프로젝트의 현재 결정으로도 기록되어 이후 모든 직원(검수자 포함)에게 전달된다.
   */
  answerQuestions(requestId: string, items: { index: number; answer: string | null }[]): CeoRequest {
    const req = this.records.request(requestId);
    if (!req) throw new DomainError(tr('요청이 없습니다.', 'Request not found.'));
    const answers = req.questions.map((_, i) => req.answers?.[i] ?? null);
    const lines: string[] = [];
    for (const it of items) {
      const q = req.questions[it.index];
      if (q === undefined || answers[it.index]) continue;
      const a = (it.answer ?? req.proposals?.[it.index] ?? '').trim();
      if (!a)
        throw new DomainError(
          tr(
            `질문 ${it.index + 1}에는 제안된 답이 없습니다. 직접 답해 주세요.`,
            `Question ${it.index + 1} has no proposal. Answer it yourself.`,
          ),
        );
      answers[it.index] = a;
      lines.push(`${q} → ${a}`);
    }
    if (!lines.length) return req;
    this.records.recordDecision(req.projectId, lines.join('\n'), [req.id]);
    const next = { ...req, answers };
    this.records.saveRequest(next);
    this.changed('request', requestId);
    return next;
  }

  /** 대표가 초안을 확정한다(고친 초안을 넘길 수 있음). 티켓은 대표 명의로 만들어진다. */
  acceptRequest(requestId: string, drafts?: TicketDraft[]): Ticket[] {
    const req = this.records.request(requestId);
    if (!req || req.status !== 'drafted') throw new DomainError(tr('확정할 수 있는 초안이 없습니다.', 'No draft available to confirm.'));
    // 답하지 않은 질문은 비서실장 제안대로 간다(실측: "기록이 없으면 0을 보여 줄까요?"처럼 뻔한 질문에 대표가 매번 멈췄다).
    const pending = req.questions.map((_, i) => i).filter((i) => !req.answers?.[i] && req.proposals?.[i]?.trim());
    if (pending.length)
      this.answerQuestions(
        requestId,
        pending.map((index) => ({ index, answer: null })),
      );
    const list = drafts ?? req.drafts;
    const created: Ticket[] = [];
    this.company.store.transact(() => {
      for (const d of list) {
        const deps = d.dependsOn.map((i) => created[i]?.id).filter((x): x is string => Boolean(x));
        created.push(
          this.company.createTicket(
            {
              projectId: req.projectId,
              type: d.type,
              title: d.title,
              purpose: d.purpose,
              requirements: d.requirements.map((r) => ({ text: r.text, evidenceType: r.evidenceType as Evidence['type'] })),
              doneCriteria: d.doneCriteria,
              writeScope: d.writeScope,
              // 대표가 확정 화면에서 보낸 값도 여기서 정리한다(모르는 값은 보통).
              difficulty: (DIFFICULTIES as readonly string[]).includes(String(d.difficulty)) ? d.difficulty : 'normal',
              dependsOn: deps,
            },
            CEO,
          ),
        );
      }
      this.records.saveRequest({ ...this.records.request(requestId)!, status: 'accepted', ticketIds: created.map((t) => t.id) });
      this.company.store.appendEvent('ceo', 'request.accepted', req.id, { tickets: created.map((t) => t.id) });
    });
    this.changed('request', requestId);
    return created;
  }

  dismissRequest(requestId: string): void {
    const req = this.records.request(requestId);
    if (!req) throw new DomainError(tr('요청이 없습니다.', 'Request not found.'));
    this.records.saveRequest({ ...req, status: 'dismissed' });
    this.company.store.appendEvent('ceo', 'request.dismissed', req.id, {});
    this.changed('request', requestId);
  }

  // ======================= 대표 조작 =======================

  /**
   * 대표 직접 확인: 자동 검증할 수 없는 요구(런타임 플레이, 시각 검수 등)를 대표가 확인한다.
   * 현재 제출 커밋에 묶인다. 검수 중 증거 부족으로 보류된 업무면 보류를 풀고 검수를 다시 돌린다.
   */
  attest(ticketId: string, requirementId: string, note: string): Evidence {
    const t = this.company.requireTicket(ticketId);
    if (!t.requirements.some((r) => r.id === requirementId))
      throw new DomainError(tr(`요구사항 ${requirementId}이(가) 없습니다.`, `Requirement ${requirementId} not found.`));
    const sub = this.records.latestSubmission(t);
    if (!sub) throw new DomainError(tr('확인할 제출물이 아직 없습니다.', 'No submission to confirm yet.'));
    const e: Evidence = {
      id: newId('EV'),
      ticketId,
      round: t.round,
      headSha: sub.headSha ?? sub.baseSha ?? '',
      type: 'human_attest',
      label: tr('대표 직접 확인', 'CEO confirmation'),
      argv: null,
      exitCode: null,
      passed: true,
      outputPath: null,
      summary: note || tr('대표가 직접 확인했습니다.', 'Confirmed directly by the CEO.'),
      requirementId,
      runId: sub.id,
      createdAt: new Date().toISOString(),
    };
    this.records.saveEvidence(e, sub.id);
    this.company.store.appendEvent('ceo', 'evidence.attested', ticketId, { requirementId, submission: sub.id, headSha: e.headSha, note });
    if (t.hold?.reason === 'needs_decision' && t.status === 'in_review') this.releaseHold(ticketId);
    this.changed('ticket', ticketId);
    return e;
  }

  /** 검수가 막혔을 때(회차 초과 등) 대표가 검수를 건너뛰고 승인 단계로 보낸다. 시스템 검증을 통과한 제출물만. */
  /**
   * 다시 검증: 검증 명령을 바꾼 뒤 등, 직원에게 한 회차 더 시키지 않고(토큰 없이) 마지막 제출물을 검증·검수부터 다시 한다.
   * 직원이 이미 다음 회차 작업을 시작했으면 거부한다.
   */
  reverify(ticketId: string): Ticket {
    const t = this.company.requireTicket(ticketId);
    if (this.records.runsByStatus('running').some((r) => r.ticketId === t.id && r.kind === 'work'))
      throw new DomainError(
        tr(
          '직원이 이미 다음 회차 작업을 시작했습니다. 끝난 뒤 검증됩니다.',
          'The employee already started the next round; it will be verified when done.',
        ),
      );
    const sub = this.records
      .runsForTicket(t.id)
      .filter((r) => r.kind === 'work' && r.status === 'succeeded' && r.headSha)
      .at(-1);
    if (!sub) throw new DomainError(tr('다시 검증할 제출물이 없습니다.', 'There is no submission to verify.'));
    return this.apply(t.id, { type: 'ceo_reverify', round: sub.round }, CEO);
  }

  skipReview(ticketId: string): Ticket {
    const t = this.company.requireTicket(ticketId);
    const project = this.company.requireProject(t.projectId);
    // 수정 요청 뒤에는 회차가 이미 넘어가 있으므로 회차와 상관없이 마지막 제출물을 쓴다.
    const sub = this.records
      .runsForTicket(t.id)
      .filter((r) => r.kind === 'work' && r.status === 'succeeded' && r.headSha)
      .at(-1);
    if (!sub?.headSha) throw new DomainError(tr('승인할 제출물이 없습니다.', 'There is no submission to approve.'));
    const ev = this.records.evidenceFor(t.id, { submission: sub.id });
    const verified = project.verifyCommands.every((vc) => ev.some((e) => e.label === vc.label && e.passed));
    if (!verified)
      throw new DomainError(
        tr(
          '이 제출물은 시스템 검증을 통과하지 못했습니다. 검증 실패는 건너뛸 수 없습니다.',
          'This submission did not pass system verification, which cannot be skipped.',
        ),
      );
    return this.apply(
      t.id,
      { type: 'ceo_skip_review', reason: tr('대표가 검수를 건너뛰었습니다.', 'The CEO skipped review.'), round: sub.round },
      CEO,
    );
  }

  /**
   * 직원이 "대표 결정 필요"로 멈췄을 때: 대표가 답하거나(answer) 직원 판단에 맡기고(null) 바로 재개한다.
   * 답은 프로젝트의 현재 결정으로 기록되어 다음 실행부터 모든 직원에게 전달된다.
   */
  answerTicket(ticketId: string, answer: string | null): Ticket {
    const t = this.company.requireTicket(ticketId);
    if (t.hold?.reason !== 'needs_decision')
      throw new DomainError(tr('대표 결정을 기다리는 업무가 아닙니다.', 'This ticket is not waiting for a decision.'));
    const raw = this.company.store.getSetting(`ticket_questions:${t.id}`);
    const questions: string[] = raw ? (JSON.parse(raw) as string[]) : [];
    // 프로젝트 규칙(모든 직원·모든 업무에 전달)은 "질문 → 대표 답"만 남긴다. 위임이나 질문 없이 멈춘 경우의 답은
    // 이 업무에만 전하는 업무방 메모로 남긴다(다음 작업 지시에 들어간다).
    // 실측(2026-09-30): 보류 메모(작업 보고 전문)가 통째로 "규칙"이 되어 이후 모든 업무 지시에 섞였다.
    const listed = questions.map((q) => `- ${q}`).join('\n');
    if (answer?.trim() && questions.length)
      this.records.recordDecision(t.projectId, questions.map((q) => `${q} → ${answer.trim()}`).join('\n'), [t.id]);
    else {
      const room = this.chat.ensureTicketChannel(t.id);
      if (room)
        this.chat.post(
          room.id,
          'ceo',
          answer?.trim() ||
            tr(
              `질문한 것은 담당 직원이 합리적인 값으로 정하고, 정한 값과 근거를 문서에 남기세요.${listed ? `\n${listed}` : ''}`,
              `Decide these yourself with sensible values and document the values and reasoning.${listed ? `\n${listed}` : ''}`,
            ),
          'chat',
        );
    }
    this.company.store.setSetting(`ticket_questions:${t.id}`, '');
    return this.releaseHold(t.id);
  }

  /** 회사 전체 일시정지 여부(설정에 저장: 재시작해도 유지). */
  get paused(): boolean {
    return Boolean(this.company.store.getSetting('company_paused'));
  }

  /** 대표가 회사 전체를 멈추거나 다시 돌린다. 진행 중인 실행은 끝까지 마무리한다. */
  setPaused(paused: boolean): { paused: boolean; running: number } {
    if (!paused) {
      // 하루 한도로 멈춘 날 대표가 직접 풀면 그날은 다시 멈추지 않는다.
      const reason = this.company.store.getSetting('paused_reason') ?? '';
      if (reason.startsWith('daily:')) this.company.store.setSetting('daily_override', reason.slice(6));
      this.company.store.setSetting('paused_reason', '');
    }
    this.company.store.setSetting('company_paused', paused ? new Date().toISOString() : '');
    this.company.store.appendEvent('ceo', paused ? 'company.paused' : 'company.resumed', 'company', {});
    this.changed('company', 'company');
    return { paused, running: this.records.runsByStatus('running').filter((r) => this.liveRuns.has(r.id)).length };
  }

  /** 업무 하나를 멈춘다(대표 보류). 실행 중이면 끝난 뒤에 멈추도록 거부한다. 재개는 "보류 해제". */
  pauseTicket(ticketId: string): Ticket {
    const t = this.company.requireTicket(ticketId);
    if (this.busy.has(t.id) || this.records.runsForTicket(t.id).some((r) => r.status === 'running' && this.liveRuns.has(r.id)))
      throw new DomainError(
        tr(
          '지금 직원이 실행 중입니다. 끝난 뒤 멈추거나, 회사 전체 일시정지로 새 실행을 막으세요.',
          'An employee is running this now. Pause after it finishes, or pause the whole company.',
        ),
      );
    return this.apply(t.id, { type: 'hold', reason: 'on_hold', note: tr('대표가 멈췄습니다.', 'Paused by the CEO.') }, CEO);
  }

  releaseHold(ticketId: string): Ticket {
    return this.apply(ticketId, { type: 'release_hold' }, CEO);
  }

  /** 대표가 쓰기 범위에 파일을 더한다(요청 받은 파일 허용 포함). 범위 요청으로 멈춘 업무면 바로 다시 돌린다. */
  addWriteScope(ticketId: string, paths: string[]): Ticket {
    const t = this.company.requireTicket(ticketId);
    const clean = paths.map((p) => p.trim().replaceAll('\\', '/')).filter((p) => p && !p.startsWith('/') && !p.split('/').includes('..'));
    if (!clean.length) throw new DomainError(tr('추가할 경로가 없습니다.', 'No path to add.'));
    const project = this.company.requireProject(t.projectId);
    const protectedHit = checkScope(clean, clean, project.protectedPaths).protectedTouched;
    if (protectedHit.length)
      throw new DomainError(
        tr(`보호된 파일은 더할 수 없습니다: ${protectedHit.join(', ')}`, `Protected paths cannot be added: ${protectedHit.join(', ')}`),
      );
    let out = this.company.extendWriteScope(t.id, clean);
    // 다른 진행 중 업무가 같은 파일을 쓰고 있으면, 그 업무가 끝난 뒤 차례로 이어서 한다(동시에 쓰면 반영 때 충돌한다).
    const busyWith = this.company
      .tickets()
      .find((x) => x.id !== t.id && x.projectId === t.projectId && LOCK_HOLDING.includes(x.status) && scopesOverlap(x.writeScope, clean));
    if (busyWith && this.chat.channel(ticketChannelId(t.id)))
      this.chat.post(
        ticketChannelId(t.id),
        'system',
        tr(
          `${busyWith.id}가 같은 파일을 쓰고 있어, 그 업무가 끝나면 차례로 이어서 합니다(동시에 고치면 반영 때 충돌합니다).`,
          `${busyWith.id} is using the same files; this ticket continues after it finishes.`,
        ),
        'event',
      );
    const requested = this.company.store.getSetting(`scope_request:${t.id}`);
    if (requested && out.hold?.reason === 'needs_decision') {
      this.company.store.setSetting(`scope_request:${t.id}`, '');
      out = this.releaseHold(t.id);
    }
    this.changed('ticket', t.id);
    return out;
  }

  scopeRequestOf(ticketId: string): { paths: string[]; reason: string } | null {
    const raw = this.company.store.getSetting(`scope_request:${ticketId}`);
    return raw ? (JSON.parse(raw) as { paths: string[]; reason: string }) : null;
  }

  /**
   * 범위 밖 수정으로 멈춘 업무를 대표가 정리한다(실측: "보류 해제"만 있어 누르면 같은 검사로 다시 멈췄다).
   * allow: 그 파일들을 쓰기 범위에 더하고 검증을 이어간다(보호 경로·git 조작은 허용할 수 없다).
   * revert: 직원에게 그 변경을 되돌리라고 수정 요청한다.
   */
  resolveScopeHold(ticketId: string, allow: boolean): Ticket {
    const t = this.company.requireTicket(ticketId);
    if (t.hold?.reason !== 'needs_permission' || t.status !== 'verifying')
      throw new DomainError(tr('범위 밖 수정으로 멈춘 업무가 아닙니다.', 'This ticket is not held for out-of-scope changes.'));
    const sub = this.records.latestSubmission(t);
    const project = this.company.requireProject(t.projectId);
    const scope = checkScope(sub?.changedPaths ?? [], t.writeScope, project.protectedPaths);
    if (allow) {
      if (sub?.refViolations.length || sub?.originChanged || scope.protectedTouched.length)
        throw new DomainError(
          tr(
            '보호 경로나 원본 저장소·git 기록을 건드린 변경은 허용할 수 없습니다. 되돌리게 하세요.',
            'Changes to protected paths, the original repo or git refs cannot be allowed. Ask for a revert.',
          ),
        );
      if (scope.outOfScope.length) this.company.extendWriteScope(t.id, scope.outOfScope);
      return this.releaseHold(t.id);
    }
    const files = [...scope.outOfScope, ...scope.protectedTouched];
    this.releaseHold(t.id);
    return this.apply(t.id, {
      type: 'verification_failed',
      reason: tr(
        `대표 지시: 쓰기 범위 밖 변경을 되돌리세요${files.length ? `: ${files.join(', ')}` : ''}. 허용된 범위(${t.writeScope.join(', ')}) 안에서만 고치세요.`,
        `CEO: revert the out-of-scope changes${files.length ? `: ${files.join(', ')}` : ''}. Only change files within ${t.writeScope.join(', ')}.`,
      ),
    });
  }

  /** 직원 삭제: 실행 중인 작업이나 작성 중인 초안이 있으면 거부한다(업무 확인은 Company가 한다). */
  removeEmployee(employeeId: string): Employee {
    const running = this.records.runsByStatus('running').filter((r) => r.employeeId === employeeId);
    if (running.length)
      throw new DomainError(
        tr(
          `이 직원의 실행이 아직 진행 중입니다(${running.map((r) => r.ticketId).join(', ')}). 끝난 뒤 삭제하세요.`,
          `This employee still has running work (${running.map((r) => r.ticketId).join(', ')}). Remove after it finishes.`,
        ),
      );
    if (this.records.requests().some((q) => q.employeeId === employeeId && q.status === 'drafting'))
      throw new DomainError(
        tr('이 직원이 업무 초안을 작성 중입니다. 끝난 뒤 삭제하세요.', 'This employee is drafting tickets. Remove after it finishes.'),
      );
    const e = this.company.removeEmployee(employeeId);
    this.changed('employee', employeeId);
    return e;
  }

  cancel(ticketId: string, reason: string): Ticket {
    const t = this.apply(ticketId, { type: 'cancel', reason }, CEO);
    this.stopTicketPreview(t);
    return t;
  }

  assign(ticketId: string, assigneeId: string, reviewerId: string): Ticket {
    const active = this.company.activeEmployees();
    const ranks = Object.fromEntries(active.map((e) => [e.id, rankOf(e)]));
    // 책임자: 담당자를 뺀 가장 높은 직급(담당자보다 낮으면 담당자 본인).
    const top = active.filter((e) => e.id !== assigneeId).sort((a, b) => RANK_ORDER[rankOf(b)] - RANK_ORDER[rankOf(a)])[0];
    const ownerId = top && ranks[assigneeId] && RANK_ORDER[rankOf(top)] >= RANK_ORDER[ranks[assigneeId]!] ? top.id : assigneeId;
    return this.apply(
      ticketId,
      // 하위 직급 검수 표시는 상태기계가 "같은 직급 이상이 아무도 없음"을 다시 확인한다.
      {
        type: 'assign',
        assigneeId,
        reviewerId,
        ownerId,
        reviewBelowRank: RANK_ORDER[ranks[reviewerId] ?? 'senior'] < RANK_ORDER[ranks[assigneeId] ?? 'senior'],
        activeEmployeeIds: active.map((e) => e.id),
        ranks,
      },
      CEO,
    );
  }
}

/** 실행 폴더의 셔틀 기록(run.json의 shimPid 또는 셔틀이 직접 쓴 pid.json). */
async function findShim(runDir: string): Promise<{ pid: number; startedAtMs: number | null } | null> {
  const read = async (f: string) => JSON.parse(await readFile(path.join(runDir, f), 'utf8')) as Record<string, unknown>;
  const meta = await read('run.json').catch(() => null);
  if (typeof meta?.shimPid === 'number')
    return { pid: meta.shimPid, startedAtMs: typeof meta.startedAt === 'string' ? Date.parse(meta.startedAt) : null };
  const pid = await read('pid.json').catch(() => null);
  if (typeof pid?.shimPid === 'number')
    return { pid: pid.shimPid, startedAtMs: typeof pid.startedAtMs === 'number' ? pid.startedAtMs : null };
  return null;
}

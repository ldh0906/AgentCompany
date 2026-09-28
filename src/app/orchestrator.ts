// 오케스트레이터: 결정적 코드로 티켓을 진행시킨다. LLM은 여기서 명령을 내리지 못한다.
// 흐름: 접수 → 대기 목록 → 배정 → 작업 실행 → 제출 검증(범위·증거) → 독립 검수 → 대표 승인 → 반영
import { tr } from '../core/i18n.ts';

import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { adapterFor } from '../adapters/index.ts';
import { buildDraftPrompt, buildReviewPrompt, buildWorkPrompt } from '../agents/prompt.ts';
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
import { parseDrafts, parseReport, type TicketDraft, type WorkReport } from '../agents/report.ts';
import { writeDecision } from '../approvals/file-queue.ts';
import type { Actor } from '../core/ticket-machine.ts';
import type { Claim, Employee, Evidence, FailureClass, Project, Ticket, TicketStatus } from '../core/types.ts';
import { DEFAULT_BUDGET, TERMINAL_STATUSES } from '../core/types.ts';
import { readAllJsonl } from '../runner/jsonl.ts';
import { locateExecutable } from '../runner/locate.ts';
import { abandonAndTerminate, isSameProcessAlive, readExitRecord, reapGroup, startProcess, waitForExit } from '../runner/process.ts';
import { git } from '../workspace/git.ts';
import {
  changedPaths,
  checkScope,
  commitWorktree,
  diffText,
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

const ORCH: Actor = { kind: 'orchestrator' };
const CEO: Actor = { kind: 'ceo' };

export interface OrchestratorOptions {
  dataDir: string;
  language?: string;
  /** 앱 전용 CLI 프로필 루트. null이면 사용자 기본 프로필을 쓴다. */
  profileRoot?: string | null;
  concurrency?: Partial<Record<string, number>>;
  /** 저장된 상태 변경 알림(대시보드 실시간 갱신용). */
  onChange?: (kind: string, id: string) => void;
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
  private readonly opts: Required<Omit<OrchestratorOptions, 'onChange'>> & Pick<OrchestratorOptions, 'onChange'>;
  private readonly busy = new Set<string>(); // 티켓 단위 비동기 작업 중
  private readonly liveRuns = new Map<string, Promise<void>>();
  private readonly reviewFailures = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(company: Company, opts: OrchestratorOptions) {
    this.company = company;
    this.records = new Records(company.store);
    this.opts = {
      dataDir: opts.dataDir,
      language: opts.language ?? 'ko',
      profileRoot: opts.profileRoot ?? null,
      concurrency: { claude: 1, codex: 1, agy: 1, fake: 4, ...opts.concurrency },
      onChange: opts.onChange,
    };
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
      const head = await commitWorktree(wt, `${ticket.id} round ${run.round}`);
      if (head) this.records.recordRefMove(project.id, 'mirror', branchRef, prevHead, head);
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
      for (const t of this.company.tickets()) {
        if (t.hold?.reason === 'waiting_dependency' && t.dependsOn.every((d) => this.company.requireTicket(d).status === 'done')) {
          this.apply(t.id, { type: 'release_hold' }); // 선행 업무가 끝나면 오케스트레이터가 스스로 해제
          continue;
        }
        if (TERMINAL_STATUSES.includes(t.status) || t.hold || this.busy.has(t.id)) continue;
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
        return;
      case 'integrating':
        this.runBusy(t.id, () => this.integrate(t.id));
        return;
    }
  }

  private apply(ticketId: string, cmd: Parameters<Company['applyTicket']>[1], actor: Actor = ORCH): Ticket {
    const t = this.company.applyTicket(ticketId, cmd, actor);
    if (TERMINAL_STATUSES.includes(t.status)) this.records.releaseLocks(ticketId);
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
    if (active.length < 2) {
      this.apply(t.id, {
        type: 'hold',
        reason: 'needs_decision',
        note: tr(
          '담당자와 검수자를 나누려면 활성 직원이 2명 이상 필요합니다.',
          'At least two active employees are needed for separate assignee and reviewer roles.',
        ),
      });
      return;
    }
    const wants =
      t.type === 'impl' ? ['implementer'] : t.type === 'doc' ? ['planner', 'recorder', 'architect'] : ['architect', 'planner', 'qa'];
    const load = (e: Employee) =>
      this.company.tickets().filter((x) => x.assigneeId === e.id && !TERMINAL_STATUSES.includes(x.status)).length;
    const byLoad = (a: Employee, b: Employee) => load(a) - load(b);
    const assignee = [...active].sort(byLoad).find((e) => e.roles.some((r) => wants.includes(r))) ?? [...active].sort(byLoad)[0]!;
    const others = active.filter((e) => e.id !== assignee.id);
    const reviewer =
      others.find((e) => e.roles.includes('qa') && e.cli !== assignee.cli) ??
      others.find((e) => e.roles.includes('qa')) ??
      others.find((e) => e.cli !== assignee.cli) ??
      others[0]!;
    this.apply(t.id, { type: 'assign', assigneeId: assignee.id, reviewerId: reviewer.id, activeEmployeeIds: active.map((e) => e.id) });
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
      return {
        wt,
        refsBefore: await snapshotRefs(paths.mirror),
        originBefore: await originFingerprint(project.originPath),
        originRefsBefore: await snapshotRefs(project.originPath),
        moveSeqBefore: this.records.currentMoveSeq(),
      };
    });

    const nonce = randomBytes(6).toString('hex');
    const feedback = this.lastFeedback(next);
    const prompt = buildWorkPrompt({
      employee,
      project,
      ticket: next,
      nonce,
      decisions: this.records.decisions(project.id, 'current'),
      feedback,
      language: this.opts.language,
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
  }

  private lastFeedback(t: Ticket): string | null {
    if (t.round <= 1) return null;
    const ev = this.company.store
      .events(t.id)
      .filter((e) => e.type === 'ticket.changes_requested')
      .at(-1);
    return ev ? String((ev.payload as { reason?: string }).reason ?? '') : null;
  }

  private profileEnv(employee: Employee): Record<string, string> {
    const v = adapterFor(employee.cli).capabilities.profileEnvVar;
    return v && this.opts.profileRoot ? { [v]: path.join(this.opts.profileRoot, employee.cli) } : {};
  }

  private async launch(p: {
    ticket: Pick<Ticket, 'id' | 'round' | 'budget'>;
    employee: Employee;
    kind: 'work' | 'review' | 'analysis';
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
  }): Promise<void> {
    const adapter = adapterFor(p.employee.cli);
    const runId = newId('R');
    const runDir = path.join(this.opts.dataDir, 'runs', runId);
    const approvalDir = adapter.capabilities.permissionRelay ? path.join(runDir, 'approvals') : null;
    const inv = adapter.buildInvocation({
      prompt: p.prompt,
      cwd: p.cwd,
      model: p.employee.model,
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
    });

    if (!located?.launch) {
      await this.finishRun(run, {
        failure: 'spawn_failed',
        detail: tr(
          `${adapter.displayName} 실행 파일(${inv.file})을 찾지 못했습니다.`,
          `${adapter.displayName} executable (${inv.file}) not found.`,
        ),
      });
      return;
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
    run.exitCode = outcome?.exitCode ?? null;

    const fresh = run;
    if (run.kind === 'analysis' && run.phase)
      return this.finishDeliberationRun(
        run,
        outcome?.timedOut ? null : parsed.finalText,
        outcome?.timedOut ? tr('시간 초과', 'Timed out') : stderr,
      );
    if (run.kind === 'analysis') return this.finishDrafts(run, parsed.finalText, outcome, stderr);

    const ticket = this.company.requireTicket(run.ticketId);
    const report = parseReport(parsed.finalText, {
      kind: run.kind === 'review' ? 'review' : 'work',
      nonce: run.nonce,
      requirementIds: ticket.requirements.map((r) => r.id),
    });
    if (outcome?.timedOut) return this.finishRun(fresh, { failure: 'timeout', detail: tr('실행 시간 초과', 'Run timed out') });
    if (!report.ok) {
      const cls: FailureClass =
        report.reason === 'nonce_mismatch'
          ? 'nonce_mismatch'
          : parsed.finalText
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
    // 실행 결과·이벤트·티켓 전이를 한 트랜잭션으로: 중간에 죽어도 "성공했는데 제출 안 됨" 상태가 남지 않는다.
    this.company.store.transact(() => this.finishRunTx(run, failure));
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
                  '구독 사용량 한도에 도달했습니다. 한도가 풀린 뒤 대표가 재개하세요.',
                  'Subscription usage limit reached. The CEO can resume after the limit resets.',
                ),
              }
            : failure.failure === 'auth_required'
              ? { reason: 'needs_permission' as const, note: tr('직원 CLI 로그인이 필요합니다.', 'Employee CLI login required.') }
              : failure.failure === 'spawn_failed'
                ? { reason: 'needs_decision' as const, note: failure.detail }
                : undefined;
        this.apply(ticket.id, {
          type: 'run_aborted',
          reason: `${failure.failure}: ${failure.detail.slice(0, 300)}`,
          ...(hold ? { hold } : {}),
        });
        return;
      }
      const wr = run.report as WorkReport;
      if (wr.status !== 'done') {
        this.apply(ticket.id, {
          type: 'run_aborted',
          reason: tr(
            `직원이 ${wr.status === 'blocked' ? tr('진행 불가', 'Blocked') : tr('대표 결정 필요', 'CEO decision needed')}를 보고`,
            `Employee reported: ${wr.status === 'blocked' ? tr('진행 불가', 'Blocked') : tr('대표 결정 필요', 'CEO decision needed')}`,
          ),
          hold: { reason: 'needs_decision', note: [wr.summary, ...wr.questions].join('\n').slice(0, 2000) },
        });
        return;
      }
      this.apply(ticket.id, { type: 'submit' });
      return;
    }

    // 검수 실행
    if (ticket.status !== 'in_review') return;
    if (failure) {
      const n = (this.reviewFailures.get(ticket.id) ?? 0) + 1;
      this.reviewFailures.set(ticket.id, n);
      if (n >= 2 || failure.failure === 'usage_limit' || failure.failure === 'auth_required') {
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
    if (rr.verdict === 'approve') {
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
      const reasons = rr.requirements.filter((r) => !r.met).map((r) => `- ${r.id}: ${r.reason}`);
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
      const vwt = await ensureDetachedWorktree(paths, 'verify', ticketId, sub.headSha);
      // 검증 명령은 제출된 코드를 실행한다(CI와 같음). 실행 전후로 원본 저장소와 미러 ref를 비교해 부작용을 잡는다.
      // 남은 이전 검증부터 끝낸다. 기준 스냅샷은 DB에 남겨, 검증 중 재시작해도 "이미 바뀐 원본"을 새 기준으로 삼지 않는다.
      await this.stopLeftoverVerify(ticketId);
      const before = await this.verifyBaseline(`verify_base:${ticketId}`, project, paths);
      try {
        for (const [i, vc] of project.verifyCommands.entries()) {
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
    const [cmd, ...rest] = vc.argv;
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
          ? await diffText(paths.mirror, sub.baseSha, sub.headSha)
          : tr('(파일 변경 없음: 조사·보고 업무)', '(No file changes: research/report task)'),
        changedPaths: sub.changedPaths,
        evidence: this.records.evidenceFor(t.id, { submission: sub.id }),
        assigneeSummary: sub.summary,
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
      },
      requestedBy: 'orchestrator',
    });
    this.changed('approval', t.id);
  }

  /** 대표의 승인·거부. mode를 주면 이번 반영에만 그 방식을 쓴다. */
  decideIntegration(
    approvalId: string,
    decision: 'approved' | 'rejected',
    opts: { mode?: Project['integrationMode']; reason?: string } = {},
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
        this.records.setApprovalState(approvalId, 'rejected', 'ceo', { reason: opts.reason ?? '' });
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
    const mode = opts.mode ?? (a.detail as { mode: Project['integrationMode'] }).mode;
    return tx(() => {
      this.records.setApprovalState(approvalId, 'approved', 'ceo', { mode });
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
                for (const [i, vc] of project.verifyCommands.entries()) {
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
        this.apply(ticketId, { type: 'integrated', commitSha: commit });
      });
    } catch (error) {
      this.company.store.transact(() => {
        this.company.store.setSetting(`mergeverify_base:${ticketId}`, '');
        this.apply(ticketId, { type: 'integration_failed', reason: String((error as Error).message ?? error) });
      });
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
    const list = this.company.activeEmployees().slice(0, 4);
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
    launch: () => Promise<void>,
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
          const claim: Claim = {
            id: newId('C'),
            ticketId: t.id,
            round: t.round,
            authorId: run.employeeId,
            ...c,
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
        error: parsed.ok ? null : run.reportError,
      });
      this.company.store.appendEvent(run.employeeId, parsed.ok ? 'request.drafted' : 'request.failed', req.id, {
        count: parsed.ok ? parsed.report.tickets.length : 0,
      });
    }
    this.changed('request', run.ticketId);
  }

  /** 대표가 초안을 확정한다(고친 초안을 넘길 수 있음). 티켓은 대표 명의로 만들어진다. */
  acceptRequest(requestId: string, drafts?: TicketDraft[]): Ticket[] {
    const req = this.records.request(requestId);
    if (!req || req.status !== 'drafted') throw new DomainError(tr('확정할 수 있는 초안이 없습니다.', 'No draft available to confirm.'));
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
              dependsOn: deps,
            },
            CEO,
          ),
        );
      }
      this.records.saveRequest({ ...req, status: 'accepted', ticketIds: created.map((t) => t.id) });
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

  releaseHold(ticketId: string): Ticket {
    return this.apply(ticketId, { type: 'release_hold' }, CEO);
  }

  cancel(ticketId: string, reason: string): Ticket {
    return this.apply(ticketId, { type: 'cancel', reason }, CEO);
  }

  assign(ticketId: string, assigneeId: string, reviewerId: string): Ticket {
    return this.apply(
      ticketId,
      { type: 'assign', assigneeId, reviewerId, activeEmployeeIds: this.company.activeEmployees().map((e) => e.id) },
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

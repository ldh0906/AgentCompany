// 오케스트레이터: 결정적 코드로 티켓을 진행시킨다. LLM은 여기서 명령을 내리지 못한다.
// 흐름: 접수 → 대기 목록 → 배정 → 작업 실행 → 제출 검증(범위·증거) → 독립 검수 → 대표 승인 → 반영

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { adapterFor } from '../adapters/index.ts';
import { buildReviewPrompt, buildWorkPrompt } from '../agents/prompt.ts';
import { parseReport, type WorkReport } from '../agents/report.ts';
import { writeDecision } from '../approvals/file-queue.ts';
import type { Actor } from '../core/ticket-machine.ts';
import type { Employee, Evidence, FailureClass, Project, Ticket, TicketStatus } from '../core/types.ts';
import { TERMINAL_STATUSES } from '../core/types.ts';
import { readAllJsonl } from '../runner/jsonl.ts';
import { locateExecutable } from '../runner/locate.ts';
import { isSameProcessAlive, readExitRecord, startProcess, waitForExit } from '../runner/process.ts';
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
import { newId, Records, sha256, type RunRecord } from './records.ts';

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

const LOCK_HOLDING: TicketStatus[] = ['in_progress', 'verifying', 'in_review', 'changes_requested', 'awaiting_approval', 'integrating', 'assigned'];

export class Orchestrator {
  readonly company: Company;
  readonly records: Records;
  private readonly opts: Required<Omit<OrchestratorOptions, 'onChange'>> & Pick<OrchestratorOptions, 'onChange'>;
  private readonly busy = new Set<string>();         // 티켓 단위 비동기 작업 중
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
      chainDetail: chain.ok ? `이벤트 ${chain.count}개 검증` : `이벤트 #${chain.brokenAt}에서 변조 탐지: ${chain.reason}`,
      reattached: [],
      ingestedAfterRestart: [],
      orphaned: [],
    };
    for (const run of this.records.runsByStatus('running')) {
      const finished = await readExitRecord(run.runDir);
      const alive = !finished && run.pid !== null && run.processStartMs !== null && (await isSameProcessAlive(run.pid, run.processStartMs));
      if (alive) {
        // 셔틀이 살아 있다: 같은 실행에 재연결해 종료 기록(exit.json)을 기다린다.
        report.reattached.push(run.id);
        this.track(run.id, waitForExit(run.runDir, run.pid).then((o) => this.completeRun(run.id, o)));
      } else {
        report.ingestedAfterRestart.push(run.id);
        const outcome = finished ? { exitCode: finished.exitCode, timedOut: finished.timedOut } : null;
        await this.completeRun(run.id, outcome);
        if (this.records.run(run.id)?.status === 'orphaned') report.orphaned.push(run.id);
      }
    }
    this.company.store.appendEvent('orchestrator', 'orchestrator.recovered', 'system', report);
    return report;
  }

  /** 실행 종료 후 처리: 작업이면 오케스트레이터가 커밋하고 범위를 계산한 뒤 결과를 수거한다. */
  private async completeRun(runId: string, outcome: { exitCode: number | null; timedOut: boolean } | null): Promise<void> {
    const run = this.records.run(runId);
    if (!run || run.status !== 'running') return;
    if (run.kind === 'work' && !run.postProcessed && !outcome?.timedOut) {
      try {
        await this.postWork(run);
      } catch (error) {
        run.reportError = `실행 후 처리 실패: ${String(error)}`;
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
      const head = await commitWorktree(wt, `${ticket.id} round ${run.round}`);
      const branchRef = `refs/heads/${ticketBranch(ticket.id)}`;
      if (head) this.records.setExpectedRef(project.id, branchRef, head);
      run.headSha = head;
      run.changedPaths = head && run.baseSha ? await changedPaths(paths.mirror, run.baseSha, head) : [];
      if (run.refsBefore) {
        const after = await snapshotRefs(paths.mirror);
        // 오케스트레이터 자신이 바꾼 ref(다른 티켓 커밋·미러 동기화)는 위반이 아니다. 기록과 다른 변경만 잡는다.
        run.refViolations = refChanges(run.refsBefore, after, [branchRef]).filter(
          (ref) => !ref.startsWith('refs/ac-merge/') && this.records.expectedRef(project.id, ref) !== after[ref],
        );
      }
      if (run.originBefore !== null) run.originChanged = (await originFingerprint(project.originPath)) !== run.originBefore;
    });
  }

  private readonly projectLocks = new Map<string, Promise<unknown>>();

  /** 같은 프로젝트 미러의 git 작업(동기화·커밋·ref 비교)을 순서대로 실행한다. */
  private withProjectLock<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.projectLocks.get(projectId) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    this.projectLocks.set(projectId, next.catch(() => {}));
    return next;
  }

  private track(runId: string, p: Promise<void>): void {
    const wrapped = p.catch((error) => {
      this.company.store.appendEvent('orchestrator', 'orchestrator.error', runId, { error: String(error) });
    }).finally(() => this.liveRuns.delete(runId));
    this.liveRuns.set(runId, wrapped);
  }

  // ======================= 한 번의 진행 =======================

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.pollToolApprovals();
      for (const t of this.company.tickets()) {
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
          this.apply(t.id, { type: 'hold', reason: 'needs_decision', note: `티켓 정보 보완 필요: ${String((error as Error).message)}` });
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
        if (!this.hasLiveRun(t.id, 'work')) {
          // 데몬 재시작 후 추적 중인 실행이 없으면 중단 처리(예산은 이미 소모됨).
          this.apply(t.id, { type: 'run_aborted', reason: '실행 추적이 끊겼습니다(재시작 복구).' });
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
    this.changed('ticket', ticketId);
    return t;
  }

  private runBusy(ticketId: string, fn: () => Promise<void>): void {
    if (this.busy.has(ticketId)) return;
    this.busy.add(ticketId);
    const id = `busy:${ticketId}`;
    this.track(id, fn().finally(() => this.busy.delete(ticketId)));
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
      this.apply(t.id, { type: 'hold', reason: 'needs_decision', note: '담당자와 검수자를 나누려면 활성 직원이 2명 이상 필요합니다.' });
      return;
    }
    const wants = t.type === 'impl' ? ['implementer'] : t.type === 'doc' ? ['planner', 'recorder', 'architect'] : ['architect', 'planner', 'qa'];
    const load = (e: Employee) => this.company.tickets().filter((x) => x.assigneeId === e.id && !TERMINAL_STATUSES.includes(x.status)).length;
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
      this.apply(t.id, { type: 'hold', reason: 'needs_decision', note: `담당자 ${employee.name}이(가) 비활성 상태입니다.` });
      return;
    }
    if (this.liveCountFor(employee.cli) >= (this.opts.concurrency[employee.cli] ?? 1)) return;
    const deps = t.dependsOn.every((d) => this.company.requireTicket(d).status === 'done');
    const locks = deps ? this.records.acquireLocks(t, this.company.tickets().filter((x) => LOCK_HOLDING.includes(x.status))) : { ok: true as const };
    if (!locks.ok) {
      // 다른 업무와 쓰기 범위가 겹친다: 오류가 아니라 대기. 같은 사유로는 한 번만 기록한다.
      this.noteOnce(t.id, 'ticket.waiting_lock', { conflictWith: locks.conflictWith });
      return;
    }
    const next = this.apply(t.id, { type: 'start_work', dependenciesDone: deps, locksAcquired: true });
    if (next.status !== 'in_progress') return;

    const project = this.company.requireProject(t.projectId);
    const paths = projectPaths(this.opts.dataDir, project.id);
    const { wt, refsBefore, originBefore } = await this.withProjectLock(project.id, async () => {
      const baseSha = await syncMirror(project.originPath, paths, project.baseBranch);
      this.records.setExpectedRef(project.id, `refs/heads/${project.baseBranch}`, baseSha);
      const wt = await ensureTicketWorktree(paths, t.id, project.baseBranch);
      this.records.setExpectedRef(project.id, `refs/heads/${ticketBranch(t.id)}`, await headSha(wt.path));
      return { wt, refsBefore: await snapshotRefs(paths.mirror), originBefore: await originFingerprint(project.originPath) };
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
    ticket: Ticket;
    employee: Employee;
    kind: 'work' | 'review';
    cwd: string;
    prompt: string;
    nonce: string;
    accessLevel: Employee['accessLevel'];
    baseSha: string | null;
    refsBefore?: Record<string, string>;
    originBefore?: string;
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

    const located = inv.file === process.execPath ? { launch: { file: inv.file, argsPrefix: [] as string[] } } : await locateExecutable(inv.file, inv.env);
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
      postProcessed: false,
      report: null,
      reportError: null,
      finalText: null,
      summary: '',
    };
    this.records.saveRun(run); // 먼저 기록하고 나중에 실행(write-ahead)
    this.company.store.appendEvent(p.employee.id, `run.${p.kind}.prepared`, p.ticket.id, { runId, cli: p.employee.cli, model: p.employee.model });

    if (!located?.launch) {
      await this.finishRun(run, { failure: 'spawn_failed', detail: `${adapter.displayName} 실행 파일(${inv.file})을 찾지 못했습니다.` });
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

    const ticket = this.company.requireTicket(run.ticketId);
    const report = parseReport(parsed.finalText, { kind: run.kind === 'review' ? 'review' : 'work', nonce: run.nonce, requirementIds: ticket.requirements.map((r) => r.id) });
    if (outcome?.timedOut) return this.finishRun(fresh, { failure: 'timeout', detail: '실행 시간 초과' });
    if (!report.ok) {
      const cls: FailureClass = report.reason === 'nonce_mismatch' ? 'nonce_mismatch' : parsed.finalText ? 'schema_invalid' : adapter.classifyFailure({ exitCode: run.exitCode, timedOut: false, stderr, finalText: parsed.errorText ?? parsed.finalText });
      return this.finishRun(fresh, { failure: outcome === null && !parsed.finalText ? 'unknown' : cls, detail: `${report.detail}${stderr ? `\nstderr: ${stderr.slice(-800)}` : ''}`, orphan: outcome === null && !parsed.finalText });
    }
    fresh.report = report.report;
    fresh.summary = report.report.summary;
    await this.finishRun(fresh, null);
  }

  private async finishRun(run: RunRecord, failure: { failure: FailureClass; detail: string; orphan?: boolean } | null): Promise<void> {
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
            ? { reason: 'usage_limit' as const, note: '구독 사용량 한도에 도달했습니다. 한도가 풀린 뒤 대표가 재개하세요.' }
            : failure.failure === 'auth_required'
              ? { reason: 'needs_permission' as const, note: '직원 CLI 로그인이 필요합니다.' }
              : failure.failure === 'spawn_failed'
                ? { reason: 'needs_decision' as const, note: failure.detail }
                : undefined;
        this.apply(ticket.id, { type: 'run_aborted', reason: `${failure.failure}: ${failure.detail.slice(0, 300)}`, ...(hold ? { hold } : {}) });
        return;
      }
      const wr = run.report as WorkReport;
      if (wr.status !== 'done') {
        this.apply(ticket.id, {
          type: 'run_aborted',
          reason: `직원이 ${wr.status === 'blocked' ? '진행 불가' : '대표 결정 필요'}를 보고`,
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
        this.apply(ticket.id, { type: 'hold', reason: failure.failure === 'usage_limit' ? 'usage_limit' : 'needs_decision', note: `검수 실행 실패(${n}회): ${failure.detail.slice(0, 300)}` });
      }
      return;
    }
    this.reviewFailures.delete(ticket.id);
    const rr = run.report!;
    if (rr.kind !== 'review') return;
    const reviewer: Actor = { kind: 'employee', id: run.employeeId };
    const submission = this.records.latestSubmission(ticket);
    const evidence = this.records.evidenceFor(ticket.id, submission?.headSha ?? undefined);
    if (rr.verdict === 'approve') {
      const checks = rr.requirements.map((r) => ({
        requirementId: r.id,
        met: r.met,
        verifiedEvidence: [
          ...r.evidenceIds.map((id) => evidence.find((e) => e.id === id && e.passed)?.type),
          // 대표의 직접 확인은 검수자가 인용하지 않아도 그 요구사항의 증거가 된다.
          ...evidence.filter((e) => e.type === 'human_attest' && e.passed && e.requirementId === r.id).map((e) => e.type),
        ].filter((x): x is Evidence['type'] => Boolean(x)),
      }));
      try {
        this.apply(ticket.id, { type: 'review_approve', checks }, reviewer);
      } catch (error) {
        if (!(error instanceof DomainError)) throw error;
        this.apply(ticket.id, { type: 'hold', reason: 'needs_decision', note: `검수자는 승인했지만 시스템이 거부했습니다: ${error.message}` });
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
      this.apply(ticketId, { type: 'verification_failed', reason: '제출 기록이 없습니다.' });
      return;
    }
    if (sub.refViolations.length || sub.originChanged) {
      this.apply(ticketId, {
        type: 'scope_violation',
        paths: [...sub.refViolations.map((r) => `ref:${r}`), ...(sub.originChanged ? ['원본 저장소 작업 트리'] : [])],
      });
      return;
    }
    if (!sub.headSha) {
      if (ticket.type === 'impl' || ticket.type === 'doc') {
        this.apply(ticketId, { type: 'verification_failed', reason: '변경된 파일이 없습니다. "완료" 보고와 달리 실제 변경이 없습니다.' });
        return;
      }
    } else {
      const scope = checkScope(sub.changedPaths, ticket.writeScope, project.protectedPaths);
      if (!scope.ok) {
        this.apply(ticketId, { type: 'scope_violation', paths: [...scope.outOfScope, ...scope.protectedTouched.map((p) => `보호:${p}`)] });
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
      label: 'diff (검수자 판단용)',
      argv: null,
      exitCode: null,
      passed: true,
      outputPath: null,
      summary: `${sub.changedPaths.length}개 파일 변경`,
      createdAt: now(),
    };
    this.records.saveEvidence(diffEvidence, sub.id);

    const failures: string[] = [];
    if (project.verifyCommands.length && sub.headSha) {
      const paths = projectPaths(this.opts.dataDir, project.id);
      const vwt = await ensureDetachedWorktree(paths, 'verify', ticketId, sub.headSha);
      for (const [i, vc] of project.verifyCommands.entries()) {
        const ev = await this.runVerifyCommand(vc, vwt, path.join(sub.runDir, 'verify', String(i)));
        const e: Evidence = { id: newId('EV'), ticketId, round: ticket.round, headSha: sub.headSha, type: vc.evidenceType, label: vc.label, argv: vc.argv, ...ev, createdAt: now() };
        this.records.saveEvidence(e, sub.id);
        if (!e.passed) failures.push(`${vc.label} 실패 (exit ${e.exitCode ?? '-'}):\n${e.summary}`);
      }
    }
    this.changed('ticket', ticketId);
    if (failures.length) this.apply(ticketId, { type: 'verification_failed', reason: `시스템 검증 실패:\n${failures.join('\n\n')}` });
    else this.apply(ticketId, { type: 'verification_passed' });
  }

  private async runVerifyCommand(
    vc: Project['verifyCommands'][number],
    cwd: string,
    runDir: string,
  ): Promise<{ exitCode: number | null; passed: boolean; outputPath: string | null; summary: string }> {
    const [cmd, ...rest] = vc.argv;
    const located = cmd ? await locateExecutable(cmd) : null;
    if (!located?.launch) return { exitCode: null, passed: false, outputPath: null, summary: `실행 파일 ${cmd}을(를) 찾지 못했습니다.` };
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
    const tail = async (f: string) => (await readFile(f, 'utf8').catch(() => '')).slice(-1500);
    const summary = `${await tail(proc.stdoutPath)}\n${await tail(proc.stderrPath)}`.trim().slice(-1500);
    return { exitCode: o.exitCode, passed: o.exitCode === 0 && !o.timedOut, outputPath: proc.stdoutPath, summary: o.timedOut ? `시간 초과\n${summary}` : summary };
  }

  // ======================= 독립 검수 =======================

  private startReview(t: Ticket): void {
    const reviewer = this.company.requireEmployee(t.reviewerId!);
    if (!reviewer.active) {
      this.apply(t.id, { type: 'hold', reason: 'needs_decision', note: `검수자 ${reviewer.name}이(가) 비활성 상태입니다.` });
      return;
    }
    if (this.liveCountFor(reviewer.cli) >= (this.opts.concurrency[reviewer.cli] ?? 1)) return;
    this.runBusy(t.id, async () => {
      const project = this.company.requireProject(t.projectId);
      const sub = this.records.latestSubmission(t);
      if (!sub?.headSha || !sub.baseSha) return;
      const paths = projectPaths(this.opts.dataDir, project.id);
      const rwt = await ensureDetachedWorktree(paths, 'review', t.id, sub.headSha);
      const nonce = randomBytes(6).toString('hex');
      const prompt = buildReviewPrompt({
        employee: reviewer,
        project,
        ticket: t,
        nonce,
        diff: await diffText(paths.mirror, sub.baseSha, sub.headSha),
        changedPaths: sub.changedPaths,
        evidence: this.records.evidenceFor(t.id, sub.headSha),
        assigneeSummary: sub.summary,
        language: this.opts.language,
      });
      // 검수자는 항상 읽기 전용으로 실행한다.
      await this.launch({ ticket: t, employee: reviewer, kind: 'review', cwd: rwt, prompt, nonce, accessLevel: 'read-only', baseSha: sub.baseSha });
    });
  }

  // ======================= 대표 승인과 반영 =======================

  private integrationSubject(t: Ticket, sub: RunRecord): string {
    return [t.id, sub.baseSha, sub.headSha, sha256(sub.changedPaths.join('\n'))].join('|');
  }

  private ensureIntegrationApproval(t: Ticket): void {
    if (this.records.pendingApprovalFor(t.id, 'integrate')) return;
    const sub = this.records.latestSubmission(t);
    if (!sub) return;
    const project = this.company.requireProject(t.projectId);
    this.records.createApproval({
      kind: 'integrate',
      ticketId: t.id,
      subject: this.integrationSubject(t, sub),
      summary: `${t.id} ${t.title} — ${sub.changedPaths.length}개 파일 변경`,
      detail: { headSha: sub.headSha, baseSha: sub.baseSha, changedPaths: sub.changedPaths, mode: project.integrationMode, summary: sub.summary },
      requestedBy: 'orchestrator',
    });
    this.changed('approval', t.id);
  }

  /** 대표의 승인·거부. mode를 주면 이번 반영에만 그 방식을 쓴다. */
  decideIntegration(approvalId: string, decision: 'approved' | 'rejected', opts: { mode?: Project['integrationMode']; reason?: string } = {}): Ticket {
    const a = this.records.approval(approvalId);
    if (!a || a.kind !== 'integrate' || a.state !== 'pending' || !a.ticketId) throw new DomainError('처리할 수 없는 승인입니다.');
    const t = this.company.requireTicket(a.ticketId);
    const sub = this.records.latestSubmission(t);
    if (decision === 'rejected') {
      this.records.setApprovalState(approvalId, 'rejected', 'ceo', { reason: opts.reason ?? '' });
      return this.apply(t.id, { type: 'ceo_reject', reason: opts.reason || '대표가 반려했습니다.' }, CEO);
    }
    if (!sub || sha256(this.integrationSubject(t, sub)) !== a.subjectHash) {
      this.records.setApprovalState(approvalId, 'expired', 'orchestrator', { reason: '승인 대상이 바뀌었습니다.' });
      throw new DomainError('승인 요청 이후 제출물이 바뀌어 승인이 무효가 되었습니다. 새 승인 요청을 확인하세요.');
    }
    const mode = opts.mode ?? (a.detail as { mode: Project['integrationMode'] }).mode;
    this.records.setApprovalState(approvalId, 'approved', 'ceo', { mode });
    return this.apply(t.id, { type: 'ceo_approve' }, CEO);
  }

  private async integrate(ticketId: string): Promise<void> {
    const t = this.company.requireTicket(ticketId);
    if (t.status !== 'integrating') return;
    const project = this.company.requireProject(t.projectId);
    const sub = this.records.latestSubmission(t);
    const approval = this.records.approvals('approved').filter((a) => a.ticketId === ticketId && a.kind === 'integrate').at(-1);
    if (!sub?.headSha || !approval) {
      this.apply(ticketId, { type: 'integration_failed', reason: '반영할 제출물 또는 승인 기록이 없습니다.' });
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
    try {
      const result =
        mode === 'auto_after_approval'
          ? await integrateWithMerge(project.originPath, paths, t.id, project.baseBranch, sub.headSha, t.title, async (mergeSha) => {
              if (!project.verifyCommands.length) return { ok: true };
              const vwt = await ensureDetachedWorktree(paths, 'verify', t.id, mergeSha);
              for (const [i, vc] of project.verifyCommands.entries()) {
                const r = await this.runVerifyCommand(vc, vwt, path.join(sub.runDir, 'merge-verify', String(i)));
                if (!r.passed) return { ok: false, reason: `${vc.label}: ${r.summary.slice(-300)}` };
              }
              return { ok: true };
            })
          : await integrateAsBranch(project.originPath, paths, t.id, sub.headSha);
      // 반영 중 미러의 기준 브랜치가 동기화됐으므로 예상 ref를 갱신한다.
      this.records.setExpectedRef(project.id, `refs/heads/${project.baseBranch}`, await headSha(paths.mirror, `refs/heads/${project.baseBranch}`));
      this.records.setApprovalState(approval.id, 'consumed', 'orchestrator', { result });
      const commit = result.kind === 'merged' ? result.mergeSha : result.sha;
      this.company.store.appendEvent('orchestrator', 'ticket.integration_result', ticketId, result);
      this.apply(ticketId, { type: 'integrated', commitSha: commit });
    } catch (error) {
      this.apply(ticketId, { type: 'integration_failed', reason: String((error as Error).message ?? error) });
    }
  }

  // ======================= 실행 중 권한 요청(GUI 중계) =======================

  private async pollToolApprovals(): Promise<void> {
    for (const run of this.records.runsByStatus('running')) {
      if (!run.approvalDir) continue;
      const files = await readdir(run.approvalDir).catch(() => [] as string[]);
      for (const f of files.filter((x) => x.endsWith('.request.json'))) {
        const reqId = f.replace('.request.json', '');
        const exists = this.records.approvals().some((a) => a.kind === 'tool_permission' && (a.detail as { requestId?: string }).requestId === reqId);
        if (exists || files.includes(`${reqId}.decision.json`)) continue;
        const req = JSON.parse(await readFile(path.join(run.approvalDir, f), 'utf8')) as { kind: string; detail: unknown };
        this.records.createApproval({
          kind: 'tool_permission',
          ticketId: run.ticketId,
          subject: `${run.id}|${reqId}|${JSON.stringify(req.detail)}`,
          summary: `${run.ticketId}: ${req.kind} 실행 허가 요청`,
          detail: { requestId: reqId, runId: run.id, approvalDir: run.approvalDir, tool: req.kind, input: req.detail },
          requestedBy: run.employeeId,
        });
        this.changed('approval', run.ticketId);
      }
    }
  }

  async decideToolPermission(approvalId: string, allow: boolean, message?: string): Promise<void> {
    const a = this.records.approval(approvalId);
    if (!a || a.kind !== 'tool_permission' || a.state !== 'pending') throw new DomainError('처리할 수 없는 권한 요청입니다.');
    const d = a.detail as { requestId: string; approvalDir: string };
    await writeDecision(d.approvalDir, d.requestId, { decision: allow ? 'allow' : 'deny', ...(message ? { message } : {}) });
    this.records.setApprovalState(approvalId, allow ? 'approved' : 'rejected', 'ceo');
    this.changed('approval', a.ticketId ?? approvalId);
  }

  private expireToolApprovals(run: RunRecord): void {
    for (const a of this.records.approvals('pending')) {
      if (a.kind === 'tool_permission' && (a.detail as { runId?: string }).runId === run.id) {
        this.records.setApprovalState(a.id, 'expired', 'orchestrator', { reason: '실행이 끝났습니다.' });
      }
    }
  }

  // ======================= 대표 조작 =======================

  /**
   * 대표 직접 확인: 자동 검증할 수 없는 요구(런타임 플레이, 시각 검수 등)를 대표가 확인한다.
   * 현재 제출 커밋에 묶인다. 검수 중 증거 부족으로 보류된 업무면 보류를 풀고 검수를 다시 돌린다.
   */
  attest(ticketId: string, requirementId: string, note: string): Evidence {
    const t = this.company.requireTicket(ticketId);
    if (!t.requirements.some((r) => r.id === requirementId)) throw new DomainError(`요구사항 ${requirementId}이(가) 없습니다.`);
    const sub = this.records.latestSubmission(t);
    if (!sub?.headSha) throw new DomainError('확인할 제출물이 아직 없습니다.');
    const e: Evidence = {
      id: newId('EV'),
      ticketId,
      round: t.round,
      headSha: sub.headSha,
      type: 'human_attest',
      label: '대표 직접 확인',
      argv: null,
      exitCode: null,
      passed: true,
      outputPath: null,
      summary: note || '대표가 직접 확인했습니다.',
      requirementId,
      createdAt: new Date().toISOString(),
    };
    this.records.saveEvidence(e, sub.id);
    this.company.store.appendEvent('ceo', 'evidence.attested', ticketId, { requirementId, headSha: sub.headSha, note });
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

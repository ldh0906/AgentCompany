// REST API. 모든 변경은 Company/Orchestrator를 거친다(상태기계와 권한 규칙이 그대로 적용됨).
import { tr } from '../core/i18n.ts';

import { readFile, stat } from 'node:fs/promises';
import { readAllJsonl } from '../runner/jsonl.ts';
import { activityFrom } from '../app/activity.ts';
import path from 'node:path';
import { ADAPTERS } from '../adapters/index.ts';
import type { Orchestrator } from '../app/orchestrator.ts';
import { diffText, projectPaths } from '../workspace/workspace.ts';
import { DIFFICULTIES, RANKS } from '../core/types.ts';
import type { AccessLevel, CliKind, EvidenceType, RoleTemplate, TicketType, VerifyCommand } from '../core/types.ts';
import { doctor, type DoctorReport, installInfo, openLoginWindow } from '../app/doctor.ts';
import { listModels } from '../app/models.ts';
import { createRepo, inspectRepo, listDirs, trackedDirs } from '../app/repo-inspect.ts';

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const CLIS: CliKind[] = ['claude', 'codex', 'agy', 'fake'];
const ROLES: RoleTemplate[] = ['chief-of-staff', 'planner', 'architect', 'implementer', 'ux', 'qa', 'recorder'];
const LEVELS: AccessLevel[] = ['read-only', 'write-ask', 'write-allowlist', 'full-auto'];
const TYPES: TicketType[] = ['impl', 'doc', 'review', 'research'];
const EVIDENCE: EvidenceType[] = ['mockup', 'inspection', 'static_check', 'unit_test', 'runtime', 'human_attest'];

type Body = Record<string, unknown>;

function str(b: Body, key: string, opts: { optional?: boolean; max?: number } = {}): string {
  const v = b[key];
  if (v === undefined || v === null || v === '') {
    if (opts.optional) return '';
    throw new ApiError(400, tr(`${key} 값이 필요합니다.`, `${key} is required.`));
  }
  if (typeof v !== 'string') throw new ApiError(400, tr(`${key}는 문자열이어야 합니다.`, `${key} must be a string.`));
  if (v.length > (opts.max ?? 20_000)) throw new ApiError(400, tr(`${key}가 너무 깁니다.`, `${key} is too long.`));
  return v;
}

function oneOf<T extends string>(b: Body, key: string, allowed: readonly T[], fallback?: T): T {
  const v = b[key] ?? fallback;
  if (typeof v !== 'string' || !allowed.includes(v as T))
    throw new ApiError(400, tr(`${key} 값이 올바르지 않습니다: ${String(v)}`, `Invalid ${key}: ${String(v)}`));
  return v as T;
}

function strList(b: Body, key: string): string[] {
  const v = b[key];
  if (v === undefined) return [];
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string'))
    throw new ApiError(400, tr(`${key}는 문자열 배열이어야 합니다.`, `${key} must be an array of strings.`));
  return (v as string[]).map((s) => s.trim()).filter(Boolean);
}

function verifyCommands(b: Body): VerifyCommand[] | undefined {
  const v = b.verifyCommands;
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) throw new ApiError(400, tr('verifyCommands는 배열이어야 합니다.', 'verifyCommands must be an array.'));
  return v.map((x, i) => {
    const o = x as Body;
    const argv = o.argv;
    if (!Array.isArray(argv) || !argv.length || !argv.every((a) => typeof a === 'string'))
      throw new ApiError(400, tr(`검증 명령 ${i + 1}의 argv가 올바르지 않습니다.`, `Invalid argv for verification command ${i + 1}.`));
    return { label: str(o, 'label'), argv: argv as string[], evidenceType: oneOf(o, 'evidenceType', EVIDENCE, 'unit_test') };
  });
}

export class Api {
  readonly orch: Orchestrator;
  readonly dataDir: string;
  private doctorCache: { at: number; report: DoctorReport } | null = null;
  /** 대시보드의 "종료" 버튼. 앱을 창 없이 켰을 때 끌 방법이 필요하다. */
  onShutdown: (() => void) | null = null;

  constructor(orch: Orchestrator, dataDir: string) {
    this.orch = orch;
    this.dataDir = dataDir;
  }

  private get company() {
    return this.orch.company;
  }

  async handle(method: string, pathname: string, query: URLSearchParams, body: unknown): Promise<unknown> {
    const b = (body && typeof body === 'object' ? body : {}) as Body;
    // 대화방 ID처럼 ':'가 든 경로 조각은 인코딩되어 온다(t%3AT-14).
    const parts = pathname
      .replace(/^\/api\/?/, '')
      .split('/')
      .filter(Boolean)
      .map((x) => {
        try {
          return decodeURIComponent(x);
        } catch {
          return x;
        }
      });
    const [head, id, action] = parts;
    const route = `${method} ${head ?? ''}${id ? '/:id' : ''}${action ? `/${action}` : ''}`;

    switch (route) {
      case 'GET state':
        return this.state();
      case 'GET tickets/:id':
        return this.ticketDetail(id!);
      case 'GET tickets/:id/diff':
        return this.ticketDiff(id!);
      case 'GET tickets/:id/clips':
        return this.orch.screens.screenClip(this.company.requireTicket(id!).id, Number(query.get('n') ?? 0));
      case 'GET tickets/:id/screens':
        return this.orch.screens.screenImages(this.company.requireTicket(id!).id);
      case 'GET runs/:id/log':
        return this.runLog(id!, query.get('stream') === 'stderr' ? 'stderr' : 'stdout');
      case 'GET runs/:id/activity':
        return this.runActivity(id!);
      case 'POST runs/:id/steer':
        return { delivered: await this.orch.steerRun(id!, str(b, 'text', { max: 4000 })) };

      // ---- 사내 대화 ----
      case 'GET channels': {
        this.orch.chat.ensureGeneral();
        this.orch.chat.backfill(this.company.store.events(undefined, 5000));
        // 기능이 생기기 전에 만든 업무도 업무방을 갖게 한다.
        for (const t of this.company.tickets()) if (!['cancelled'].includes(t.status)) this.orch.chat.ensureTicketChannel(t.id);
        return this.orch.chat.channels();
      }
      case 'GET channels/:id/messages':
        return this.orch.chat.messages(id!, Math.min(Number(query.get('limit') ?? 300), 1000));
      case 'POST channels/:id/messages':
        return this.orch.ceoMessage(id!, str(b, 'text', { max: 8000 }));
      case 'POST channels': {
        const c = this.orch.chat.createGroup({
          name: str(b, 'name', { max: 60 }),
          members: strList(b, 'members'),
          createdBy: 'ceo',
          topic: str(b, 'topic', { optional: true, max: 300 }),
          projectId: str(b, 'projectId', { optional: true }) || null,
        });
        this.orch.chat.post(c.id, 'system', tr('대표가 방을 열었습니다.', 'The CEO opened this room.'), 'event');
        return c;
      }
      case 'POST channels/:id/members':
        return this.orch.chat.addMembers(id!, strList(b, 'members'));
      case 'POST dm/:id':
        return this.orch.chat.ensureDm(id!);
      case 'POST chat/:id/followup':
        return this.orch.followUpToRequest(id!);
      case 'GET events':
        return this.company.store.events(query.get('entity') ?? undefined, Math.min(Number(query.get('limit') ?? 200), 1000));
      case 'GET doctor':
        return this.doctor(query.get('refresh') === '1');
      case 'GET install':
        return installInfo(this.dataDir);
      case 'POST cli-login':
        // 대표가 누를 때만 로그인 창을 연다. 끝나면 화면이 다시 점검하도록 캐시를 비운다.
        this.doctorCache = null;
        await openLoginWindow(this.dataDir, String(b.cli ?? '')).catch((e: Error) => {
          throw new ApiError(400, e.message);
        });
        return { ok: true };
      case 'POST shutdown':
        if (!this.onShutdown) throw new ApiError(400, tr('이 실행에서는 종료할 수 없습니다.', 'Shutdown is not available here.'));
        setTimeout(() => this.onShutdown?.(), 300);
        return { ok: true };
      case 'GET models':
        return listModels(this.dataDir, oneOf(Object.fromEntries(query), 'cli', CLIS));
      case 'GET dirs':
        return listDirs(query.get('path') ?? '').catch((error) => {
          throw new ApiError(
            400,
            tr(`폴더를 열 수 없습니다: ${(error as Error).message}`, `Cannot open folder: ${(error as Error).message}`),
          );
        });
      case 'POST repos':
        return {
          path: await createRepo(str(b, 'parent', { max: 1000 }), str(b, 'name', { max: 200 })).catch((error) => {
            throw new ApiError(400, (error as Error).message);
          }),
        };
      case 'GET inspect':
        return inspectRepo(str(Object.fromEntries(query), 'path', { max: 1000 }));
      case 'GET projects/:id/dirs': {
        const p = this.company.requireProject(id!);
        return trackedDirs(p.originPath, p.baseBranch, query.get('sub') ?? '');
      }

      case 'POST employees': {
        const cli = oneOf(b, 'cli', CLIS);
        const level = oneOf(b, 'accessLevel', LEVELS, 'write-ask');
        if (!ADAPTERS[cli].capabilities.accessLevels.includes(level)) {
          throw new ApiError(
            400,
            tr(
              `${ADAPTERS[cli].displayName}는 '${level}' 등급을 지원하지 않습니다.`,
              `${ADAPTERS[cli].displayName} does not support '${level}' access.`,
            ),
          );
        }
        const roles = strList(b, 'roles') as RoleTemplate[];
        if (!roles.length || !roles.every((r) => ROLES.includes(r)))
          throw new ApiError(400, tr('역할을 하나 이상 골라야 합니다.', 'Select at least one role.'));
        return this.company.hireEmployee({
          name: str(b, 'name', { max: 60 }),
          roles,
          cli,
          model: str(b, 'model', { optional: true, max: 100 }) || null,
          effort: str(b, 'effort', { optional: true, max: 20 }) || null,
          rank: oneOf(b, 'rank', RANKS, 'senior'),
          accessLevel: level,
          allowedCommands: Array.isArray(b.allowedCommands) ? (b.allowedCommands as string[][]) : [],
        });
      }
      case 'POST employees/:id/model':
        return this.company.setEmployeeModel(
          id!,
          str(b, 'model', { optional: true, max: 100 }) || null,
          str(b, 'effort', { optional: true, max: 20 }) || null,
        );
      case 'POST employees/:id/profile':
        return this.company.updateEmployeeProfile(id!, {
          ...(b.name !== undefined ? { name: str(b, 'name', { max: 60 }) } : {}),
          ...(b.roles !== undefined
            ? {
                roles: (() => {
                  const roles = strList(b, 'roles') as RoleTemplate[];
                  if (!roles.every((r) => ROLES.includes(r))) throw new ApiError(400, tr('알 수 없는 담당 업무입니다.', 'Unknown duty.'));
                  return roles;
                })(),
              }
            : {}),
        });
      case 'POST employees/:id/rank':
        return this.company.setEmployeeRank(id!, oneOf(b, 'rank', RANKS));
      case 'POST employees/:id/remove':
        return this.orch.removeEmployee(id!);
      case 'POST employees/:id/active':
        return this.company.setEmployeeActive(id!, Boolean(b.active));
      case 'POST employees/:id/access': {
        const level = oneOf(b, 'accessLevel', LEVELS);
        const e = this.company.requireEmployee(id!);
        if (!ADAPTERS[e.cli].capabilities.accessLevels.includes(level))
          throw new ApiError(400, tr('이 CLI가 지원하지 않는 등급입니다.', 'This CLI does not support this access level.'));
        if (level === 'full-auto' && b.confirm !== 'full-auto')
          throw new ApiError(400, tr('전체 자동 등급은 확인 문구가 필요합니다.', 'Full-auto access requires confirmation text.'));
        // 허용 목록: 한 줄에 명령 하나("npm test") → argv 접두사
        const allowed = Array.isArray(b.allowedCommands)
          ? (b.allowedCommands as unknown[]).map((x) => String(x).trim().split(/\s+/).filter(Boolean)).filter((a) => a.length)
          : undefined;
        return this.company.setAccessLevel(id!, level, { kind: 'ceo' }, allowed);
      }

      case 'POST projects':
        return this.company.registerProject({
          name: str(b, 'name', { max: 80 }),
          originPath: path.resolve(str(b, 'originPath', { max: 1000 })),
          baseBranch: str(b, 'baseBranch', { optional: true }) || 'main',
          integrationMode: oneOf(b, 'integrationMode', ['manual', 'auto_after_approval'] as const, 'manual'),
          protectedPaths: strList(b, 'protectedPaths'),
          verifyCommands: verifyCommands(b) ?? [],
          docRules: str(b, 'docRules', { optional: true }),
          autoApprove: b.autoApprove === true,
          qaAutoReject: b.qaAutoReject !== false,
          autoPlaytest: b.autoPlaytest === true,
          ...(b.profile && typeof b.profile === 'object' && str(b.profile as Body, 'summary', { optional: true, max: 500 })
            ? {
                profile: {
                  summary: str(b.profile as Body, 'summary', { max: 500 }),
                  mobile: (b.profile as Body).mobile === true,
                  game: (b.profile as Body).game === true,
                },
              }
            : {}),
        });
      case 'POST projects/:id/preview':
        return this.orch.preview(id!, str(b, 'ticketId', { optional: true }) || null);
      case 'POST projects/:id/preview-stop':
        this.orch.previews.stop(`${id}:${str(b, 'ticketId', { optional: true }) || 'base'}`);
        return { ok: true };
      case 'POST projects/:id/remove':
        return this.company.removeProject(id!);
      case 'PATCH projects/:id': {
        const patch: Record<string, unknown> = {};
        if (b.integrationMode !== undefined)
          patch.integrationMode = oneOf(b, 'integrationMode', ['manual', 'auto_after_approval'] as const);
        if (b.protectedPaths !== undefined) patch.protectedPaths = strList(b, 'protectedPaths');
        if (b.verifyCommands !== undefined) patch.verifyCommands = verifyCommands(b);
        if (b.docRules !== undefined) patch.docRules = str(b, 'docRules', { optional: true });
        if (b.baseBranch !== undefined) patch.baseBranch = str(b, 'baseBranch');
        if (b.autoApprove !== undefined) patch.autoApprove = b.autoApprove === true;
        if (b.qaAutoReject !== undefined) patch.qaAutoReject = b.qaAutoReject === true;
        if (b.autoPlaytest !== undefined) patch.autoPlaytest = b.autoPlaytest === true;
        if (b.profile !== undefined) {
          const pr = (b.profile ?? {}) as Body;
          patch.profile = { summary: str(pr, 'summary', { optional: true, max: 500 }), mobile: pr.mobile === true, game: pr.game === true };
        }
        return this.company.updateProject(id!, patch);
      }

      case 'POST tickets': {
        const reqs = b.requirements;
        if (!Array.isArray(reqs) || !reqs.length)
          throw new ApiError(400, tr('요구사항을 하나 이상 적어야 합니다.', 'Provide at least one requirement.'));
        const requirements = reqs.map((r) => ({
          text: str(r as Body, 'text', { max: 2000 }),
          evidenceType: oneOf(r as Body, 'evidenceType', EVIDENCE, 'inspection'),
        }));
        return this.company.createTicket({
          projectId: str(b, 'projectId'),
          type: oneOf(b, 'type', TYPES, 'impl'),
          title: str(b, 'title', { max: 200 }),
          purpose: str(b, 'purpose', { optional: true }),
          requirements,
          doneCriteria: str(b, 'doneCriteria'),
          writeScope: strList(b, 'writeScope'),
          priority: ([1, 2, 3] as const).find((p) => p === b.priority) ?? 2,
          difficulty: oneOf(b, 'difficulty', DIFFICULTIES, 'normal'),
          dependsOn: strList(b, 'dependsOn'),
        });
      }
      case 'POST tickets/:id/assign':
        return this.orch.assign(id!, str(b, 'assigneeId'), str(b, 'reviewerId'));
      case 'POST tickets/:id/pause':
        return this.orch.pauseTicket(id!);
      case 'POST tickets/:id/budget':
        return this.orch.raiseTokenBudget(id!, typeof b.maxTokens === 'number' ? b.maxTokens : undefined);
      case 'POST daily-limit':
        return this.orch.setDailyTokenLimit(Number(b.tokens ?? 0));
      case 'POST pause':
        return this.orch.setPaused(b.paused !== false);
      case 'POST tickets/:id/answer':
        return this.orch.answerTicket(id!, str(b, 'answer', { optional: true, max: 4000 }) || null);
      case 'POST tickets/:id/reverify':
        return this.orch.reverify(id!);
      case 'POST tickets/:id/skip-review':
        return this.orch.skipReview(id!);
      case 'POST toast':
        return this.orch.desk.setToast(b.on === true);
      case 'POST tickets/:id/scope-add':
        return this.orch.addWriteScope(id!, strList(b, 'paths'));
      case 'POST tickets/:id/scope':
        return this.orch.resolveScopeHold(id!, b.allow === true);
      case 'POST tickets/:id/screen-check':
        this.orch.screens.rerunScreenCheck(id!);
        return { ok: true };
      case 'POST tickets/:id/attest':
        return this.orch.attest(id!, str(b, 'requirementId'), str(b, 'note', { optional: true, max: 2000 }));
      case 'POST tickets/:id/release':
        return this.orch.releaseHold(id!);
      case 'POST tickets/:id/cancel':
        return this.orch.cancel(id!, str(b, 'reason', { optional: true }) || tr('대표가 취소했습니다.', 'Canceled by the CEO.'));

      case 'POST approvals/:id/decide': {
        const a = this.orch.records.approval(id!);
        if (!a) throw new ApiError(404, tr('승인 요청을 찾을 수 없습니다.', 'Approval request not found.'));
        const decision = oneOf(b, 'decision', ['approved', 'rejected'] as const);
        if (a.kind === 'tool_permission') {
          await this.orch.decideToolPermission(id!, decision === 'approved', str(b, 'reason', { optional: true }) || undefined);
          return this.orch.records.approval(id!);
        }
        if (a.kind === 'integrate') {
          const mode = b.mode === undefined ? undefined : oneOf(b, 'mode', ['manual', 'auto_after_approval'] as const);
          return this.orch.decideIntegration(id!, decision, {
            ...(mode ? { mode } : {}),
            reason: str(b, 'reason', { optional: true }),
            attested: strList(b, 'attested'),
          });
        }
        throw new ApiError(
          400,
          tr('이 승인 종류는 아직 대시보드에서 처리할 수 없습니다.', 'This approval type is not yet supported in the dashboard.'),
        );
      }

      case 'POST requests':
        return this.orch.submitRequest(str(b, 'projectId'), str(b, 'text', { max: 10_000 }));
      case 'POST requests/:id/accept':
        return this.orch.acceptRequest(id!, Array.isArray(b.drafts) ? (b.drafts as never) : undefined);
      case 'POST requests/:id/answer': {
        const items = Array.isArray(b.items) ? (b.items as Record<string, unknown>[]) : [];
        return this.orch.answerQuestions(
          id!,
          items.map((x) => ({
            index: Number(x?.index),
            answer: typeof x?.answer === 'string' && x.answer.trim() ? x.answer.slice(0, 2000) : null,
          })),
        );
      }
      case 'POST requests/:id/playtest':
        return this.orch.playtests.startPlaytest({ requestId: id! }, 'ceo');
      case 'POST tickets/:id/playtest':
        return this.orch.playtests.startPlaytest({ ticketId: this.company.requireTicket(id!).id }, 'ceo');
      case 'GET playtests/:id/shots':
        return this.orch.playtests.playtestShots(id!);
      case 'POST requests/:id/retry':
        return this.orch.retryRequest(id!);
      case 'POST requests/:id/dismiss':
        this.orch.dismissRequest(id!);
        return { ok: true };

      case 'POST decisions':
        return this.orch.records.recordDecision(
          str(b, 'projectId'),
          str(b, 'text', { max: 5000 }),
          strList(b, 'sourceRefs'),
          str(b, 'supersedes', { optional: true }) || null,
        );
      case 'POST decisions/:id/status':
        this.orch.records.setDecisionStatus(
          id!,
          oneOf(b, 'status', ['current', 'past', 'superseded', 'withdrawn', 'needs_verification', 'draft'] as const),
        );
        return { ok: true };
    }
    throw new ApiError(404, tr(`알 수 없는 API: ${method} ${pathname}`, `Unknown API: ${method} ${pathname}`));
  }

  state() {
    const r = this.orch.records;
    return {
      employees: this.company.employees(),
      projects: this.company.projects().filter((p) => !p.removedAt),
      tickets: this.company.tickets(),
      approvals: r.approvals('pending'),
      recentApprovals: r.approvals().slice(0, 50),
      runs: r.recentRuns(50).map(({ report, finalText, refsBefore, ...rest }) => ({ ...rest, hasReport: Boolean(report) })),
      decisions: this.company
        .projects()
        .filter((p) => !p.removedAt)
        .flatMap((p) => r.decisions(p.id)),
      adapters: Object.values(ADAPTERS).map((a) => ({ kind: a.kind, displayName: a.displayName, capabilities: a.capabilities })),
      events: this.company.store.events(undefined, 60),
      requests: r.requests(),
      chiefOfStaff: this.orch.chiefOfStaff()?.id ?? null,
      permissionDelegate: this.orch.permissionDelegate()?.id ?? null,
      usage: r.usageSummary(),
      previews: this.orch.previewList(),
      // 대표 알림: 지금 할 일, 최근 알림, 윈도우 토스트 켬 여부
      ceoTodos: this.orch.desk.ceoTodos(),
      // 고급 QA(직접 플레이) 기록: 업무별·요청별(Q:요청 ID)
      playtests: Object.fromEntries(
        [...this.company.tickets().map((t) => t.id), ...r.requests(30).map((q) => `Q:${q.id}`)]
          .map((k) => [k, this.orch.playtests.playtestOf(k)] as const)
          .filter(([, v]) => v)
          .map(([k, v]) => [k, { state: v!.state, at: v!.at, by: v!.by, qaBy: v!.qaBy, opinion: v!.opinion, note: v!.note }]),
      ),
      notices: this.orch.desk.notices(),
      toast: this.orch.desk.toastOn,
      // 승인 대기 업무의 자동 화면 점검(사진은 tickets/:id/screens로 따로)
      screenChecks: Object.fromEntries(
        this.company
          .tickets()
          .filter((t) => t.status === 'awaiting_approval')
          .map((t) => [t.id, this.orch.screens.screenCheckView(t.id)])
          .filter(([, v]) => v),
      ),
      paused: this.orch.paused,
      pausedReason: this.company.store.getSetting('paused_reason') ?? '',
      dailyLimit: Number(this.company.store.getSetting('daily_token_limit') ?? 0),
      estimates: this.orch.tokenEstimates(),
      verifySuggest: Object.fromEntries(this.company.projects().map((p) => [p.id, this.orch.verifySuggestions(p.id)])),
      budgets: Object.fromEntries(this.company.tickets().map((t) => [t.id, this.orch.ticketBudget(t)])),
      channels: this.orch.chat.channels(),
      // 직원이 대표를 부른 최근 메시지(알림·배지용)
      mentions: this.orch.chat
        .recent(300)
        .filter((m) => m.mentions.includes('ceo') && m.author !== 'ceo')
        .slice(-20),
    };
  }

  ticketDetail(id: string) {
    const t = this.company.requireTicket(id);
    const r = this.orch.records;
    return {
      ticket: t,
      runs: r.runsForTicket(id).map(({ refsBefore, ...rest }) => rest),
      evidence: r.evidenceFor(id),
      claims: r.claimsFor(id),
      approvals: r.approvals().filter((a) => a.ticketId === id),
      scopeRequest: this.orch.scopeRequestOf(id),
      events: this.company.store.events(id, 500),
    };
  }

  async ticketDiff(id: string) {
    const t = this.company.requireTicket(id);
    const sub =
      this.orch.records.latestSubmission(t) ??
      this.orch.records
        .runsForTicket(id)
        .filter((x) => x.kind === 'work' && x.headSha)
        .at(-1);
    if (!sub?.headSha || !sub.baseSha) return { diff: '', changedPaths: [] };
    const paths = projectPaths(this.dataDir, t.projectId);
    return { diff: await diffText(paths.mirror, sub.baseSha, sub.headSha, 400_000), changedPaths: sub.changedPaths, headSha: sub.headSha };
  }

  async runLog(id: string, stream: 'stdout' | 'stderr') {
    const run = this.orch.records.run(id);
    if (!run) throw new ApiError(404, tr('실행 기록이 없습니다.', 'Run record not found.'));
    const text = await readFile(path.join(run.runDir, `${stream}.log`), 'utf8').catch(() => '');
    return {
      text: text.slice(-200_000),
      truncated: text.length > 200_000,
      report: run.report,
      finalText: run.finalText,
      reportError: run.reportError,
    };
  }

  /** 작업 로그: 사람이 읽는 타임라인과 마지막 출력 시각(멈춤 감지용). */
  async runActivity(id: string) {
    const run = this.orch.records.run(id);
    if (!run) throw new ApiError(404, tr('실행 기록이 없습니다.', 'Run record not found.'));
    const file = path.join(run.runDir, 'stdout.log');
    const { events } = await readAllJsonl(file);
    const items = activityFrom(events);
    const lastOutputAt = await stat(file)
      .then((s) => s.mtime.toISOString())
      .catch(() => null);
    const { report, finalText, refsBefore, ...rest } = run;
    // 마지막 줄이 생성 중 신호면 지금 무엇을 하는지(생각·파일 작성·답 쓰기) 알려 준다.
    const lastEv = events.at(-1) as { type?: string; what?: string } | undefined;
    const busy = lastEv?.type === 'heartbeat' ? (lastEv.what ?? null) : null;
    return { run: rest, items: items.slice(-400), total: items.length, lastOutputAt, busy };
  }

  async doctor(refresh: boolean): Promise<DoctorReport> {
    if (!refresh && this.doctorCache && Date.now() - this.doctorCache.at < 60_000) return this.doctorCache.report;
    const report = await doctor(this.dataDir);
    this.doctorCache = { at: Date.now(), report };
    return report;
  }
}

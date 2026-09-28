// REST API. 모든 변경은 Company/Orchestrator를 거친다(상태기계와 권한 규칙이 그대로 적용됨).

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ADAPTERS } from '../adapters/index.ts';
import type { Orchestrator } from '../app/orchestrator.ts';
import { diffText, projectPaths } from '../workspace/workspace.ts';
import type { AccessLevel, CliKind, EvidenceType, RoleTemplate, TicketType, VerifyCommand } from '../core/types.ts';
import { doctor, type DoctorReport, installInfo } from '../app/doctor.ts';

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
    throw new ApiError(400, `${key} 값이 필요합니다.`);
  }
  if (typeof v !== 'string') throw new ApiError(400, `${key}는 문자열이어야 합니다.`);
  if (v.length > (opts.max ?? 20_000)) throw new ApiError(400, `${key}가 너무 깁니다.`);
  return v;
}

function oneOf<T extends string>(b: Body, key: string, allowed: readonly T[], fallback?: T): T {
  const v = b[key] ?? fallback;
  if (typeof v !== 'string' || !allowed.includes(v as T)) throw new ApiError(400, `${key} 값이 올바르지 않습니다: ${String(v)}`);
  return v as T;
}

function strList(b: Body, key: string): string[] {
  const v = b[key];
  if (v === undefined) return [];
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) throw new ApiError(400, `${key}는 문자열 배열이어야 합니다.`);
  return (v as string[]).map((s) => s.trim()).filter(Boolean);
}

function verifyCommands(b: Body): VerifyCommand[] | undefined {
  const v = b.verifyCommands;
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) throw new ApiError(400, 'verifyCommands는 배열이어야 합니다.');
  return v.map((x, i) => {
    const o = x as Body;
    const argv = o.argv;
    if (!Array.isArray(argv) || !argv.length || !argv.every((a) => typeof a === 'string')) throw new ApiError(400, `검증 명령 ${i + 1}의 argv가 올바르지 않습니다.`);
    return { label: str(o, 'label'), argv: argv as string[], evidenceType: oneOf(o, 'evidenceType', EVIDENCE, 'unit_test') };
  });
}

export class Api {
  readonly orch: Orchestrator;
  readonly dataDir: string;
  private doctorCache: { at: number; report: DoctorReport } | null = null;

  constructor(orch: Orchestrator, dataDir: string) {
    this.orch = orch;
    this.dataDir = dataDir;
  }

  private get company() {
    return this.orch.company;
  }

  async handle(method: string, pathname: string, query: URLSearchParams, body: unknown): Promise<unknown> {
    const b = (body && typeof body === 'object' ? body : {}) as Body;
    const parts = pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean);
    const [head, id, action] = parts;
    const route = `${method} ${head ?? ''}${id ? '/:id' : ''}${action ? `/${action}` : ''}`;

    switch (route) {
      case 'GET state':
        return this.state();
      case 'GET tickets/:id':
        return this.ticketDetail(id!);
      case 'GET tickets/:id/diff':
        return this.ticketDiff(id!);
      case 'GET runs/:id/log':
        return this.runLog(id!, query.get('stream') === 'stderr' ? 'stderr' : 'stdout');
      case 'GET events':
        return this.company.store.events(query.get('entity') ?? undefined, Math.min(Number(query.get('limit') ?? 200), 1000));
      case 'GET doctor':
        return this.doctor(query.get('refresh') === '1');
      case 'GET install':
        return installInfo(this.dataDir);

      case 'POST employees': {
        const cli = oneOf(b, 'cli', CLIS);
        const level = oneOf(b, 'accessLevel', LEVELS, 'write-ask');
        if (!ADAPTERS[cli].capabilities.accessLevels.includes(level)) {
          throw new ApiError(400, `${ADAPTERS[cli].displayName}는 '${level}' 등급을 지원하지 않습니다.`);
        }
        const roles = strList(b, 'roles') as RoleTemplate[];
        if (!roles.length || !roles.every((r) => ROLES.includes(r))) throw new ApiError(400, '역할을 하나 이상 골라야 합니다.');
        return this.company.hireEmployee({
          name: str(b, 'name', { max: 60 }),
          roles,
          cli,
          model: str(b, 'model', { optional: true, max: 100 }) || null,
          accessLevel: level,
          allowedCommands: Array.isArray(b.allowedCommands) ? (b.allowedCommands as string[][]) : [],
        });
      }
      case 'POST employees/:id/active':
        return this.company.setEmployeeActive(id!, Boolean(b.active));
      case 'POST employees/:id/access': {
        const level = oneOf(b, 'accessLevel', LEVELS);
        const e = this.company.requireEmployee(id!);
        if (!ADAPTERS[e.cli].capabilities.accessLevels.includes(level)) throw new ApiError(400, '이 CLI가 지원하지 않는 등급입니다.');
        if (level === 'full-auto' && b.confirm !== 'full-auto') throw new ApiError(400, '전체 자동 등급은 확인 문구가 필요합니다.');
        return this.company.setAccessLevel(id!, level, { kind: 'ceo' });
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
        });
      case 'PATCH projects/:id': {
        const patch: Record<string, unknown> = {};
        if (b.integrationMode !== undefined) patch.integrationMode = oneOf(b, 'integrationMode', ['manual', 'auto_after_approval'] as const);
        if (b.protectedPaths !== undefined) patch.protectedPaths = strList(b, 'protectedPaths');
        if (b.verifyCommands !== undefined) patch.verifyCommands = verifyCommands(b);
        if (b.docRules !== undefined) patch.docRules = str(b, 'docRules', { optional: true });
        if (b.baseBranch !== undefined) patch.baseBranch = str(b, 'baseBranch');
        return this.company.updateProject(id!, patch);
      }

      case 'POST tickets': {
        const reqs = b.requirements;
        if (!Array.isArray(reqs) || !reqs.length) throw new ApiError(400, '요구사항을 하나 이상 적어야 합니다.');
        const requirements = reqs.map((r) => ({ text: str(r as Body, 'text', { max: 2000 }), evidenceType: oneOf(r as Body, 'evidenceType', EVIDENCE, 'inspection') }));
        return this.company.createTicket({
          projectId: str(b, 'projectId'),
          type: oneOf(b, 'type', TYPES, 'impl'),
          title: str(b, 'title', { max: 200 }),
          purpose: str(b, 'purpose', { optional: true }),
          requirements,
          doneCriteria: str(b, 'doneCriteria'),
          writeScope: strList(b, 'writeScope'),
          priority: ([1, 2, 3] as const).find((p) => p === b.priority) ?? 2,
          dependsOn: strList(b, 'dependsOn'),
        });
      }
      case 'POST tickets/:id/assign':
        return this.orch.assign(id!, str(b, 'assigneeId'), str(b, 'reviewerId'));
      case 'POST tickets/:id/release':
        return this.orch.releaseHold(id!);
      case 'POST tickets/:id/cancel':
        return this.orch.cancel(id!, str(b, 'reason', { optional: true }) || '대표가 취소했습니다.');

      case 'POST approvals/:id/decide': {
        const a = this.orch.records.approval(id!);
        if (!a) throw new ApiError(404, '승인 요청을 찾을 수 없습니다.');
        const decision = oneOf(b, 'decision', ['approved', 'rejected'] as const);
        if (a.kind === 'tool_permission') {
          await this.orch.decideToolPermission(id!, decision === 'approved', str(b, 'reason', { optional: true }) || undefined);
          return this.orch.records.approval(id!);
        }
        if (a.kind === 'integrate') {
          const mode = b.mode === undefined ? undefined : oneOf(b, 'mode', ['manual', 'auto_after_approval'] as const);
          return this.orch.decideIntegration(id!, decision, { ...(mode ? { mode } : {}), reason: str(b, 'reason', { optional: true }) });
        }
        throw new ApiError(400, '이 승인 종류는 아직 대시보드에서 처리할 수 없습니다.');
      }

      case 'POST decisions':
        return this.orch.records.recordDecision(str(b, 'projectId'), str(b, 'text', { max: 5000 }), strList(b, 'sourceRefs'), str(b, 'supersedes', { optional: true }) || null);
      case 'POST decisions/:id/status':
        this.orch.records.setDecisionStatus(id!, oneOf(b, 'status', ['current', 'past', 'superseded', 'withdrawn', 'needs_verification', 'draft'] as const));
        return { ok: true };
    }
    throw new ApiError(404, `알 수 없는 API: ${method} ${pathname}`);
  }

  state() {
    const r = this.orch.records;
    return {
      employees: this.company.employees(),
      projects: this.company.projects(),
      tickets: this.company.tickets(),
      approvals: r.approvals('pending'),
      recentApprovals: r.approvals().slice(0, 50),
      runs: r.recentRuns(50).map(({ report, finalText, refsBefore, ...rest }) => ({ ...rest, hasReport: Boolean(report) })),
      decisions: this.company.projects().flatMap((p) => r.decisions(p.id)),
      adapters: Object.values(ADAPTERS).map((a) => ({ kind: a.kind, displayName: a.displayName, capabilities: a.capabilities })),
      events: this.company.store.events(undefined, 60),
    };
  }

  ticketDetail(id: string) {
    const t = this.company.requireTicket(id);
    const r = this.orch.records;
    return {
      ticket: t,
      runs: r.runsForTicket(id).map(({ refsBefore, ...rest }) => rest),
      evidence: r.evidenceFor(id),
      approvals: r.approvals().filter((a) => a.ticketId === id),
      events: this.company.store.events(id, 500),
    };
  }

  async ticketDiff(id: string) {
    const t = this.company.requireTicket(id);
    const sub = this.orch.records.latestSubmission(t) ?? this.orch.records.runsForTicket(id).filter((x) => x.kind === 'work' && x.headSha).at(-1);
    if (!sub?.headSha || !sub.baseSha) return { diff: '', changedPaths: [] };
    const paths = projectPaths(this.dataDir, t.projectId);
    return { diff: await diffText(paths.mirror, sub.baseSha, sub.headSha, 400_000), changedPaths: sub.changedPaths, headSha: sub.headSha };
  }

  async runLog(id: string, stream: 'stdout' | 'stderr') {
    const run = this.orch.records.run(id);
    if (!run) throw new ApiError(404, '실행 기록이 없습니다.');
    const text = await readFile(path.join(run.runDir, `${stream}.log`), 'utf8').catch(() => '');
    return { text: text.slice(-200_000), truncated: text.length > 200_000, report: run.report, finalText: run.finalText, reportError: run.reportError };
  }

  async doctor(refresh: boolean): Promise<DoctorReport> {
    if (!refresh && this.doctorCache && Date.now() - this.doctorCache.at < 60_000) return this.doctorCache.report;
    const report = await doctor(this.dataDir);
    this.doctorCache = { at: Date.now(), report };
    return report;
  }
}

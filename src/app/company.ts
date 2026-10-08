// 회사 서비스: 저장소 위에서 직원·프로젝트·티켓을 다룬다.
// 티켓 상태 변경은 반드시 applyTicketCommand를 거치고, 결과와 이벤트를 한 트랜잭션에 저장한다.
import { tr } from '../core/i18n.ts';

import { randomUUID } from 'node:crypto';
import { Store } from '../store/db.ts';
import { applyTicketCommand, type Actor, type TicketCommand } from '../core/ticket-machine.ts';
import {
  DEFAULT_BUDGET,
  MAX_ACTIVE_EMPLOYEES,
  TERMINAL_STATUSES,
  RANKS,
  rankOf,
  type AccessLevel,
  type CliKind,
  type Difficulty,
  type Rank,
  type Employee,
  type Project,
  type Requirement,
  type RoleTemplate,
  type Ticket,
  type TicketType,
  type VerifyCommand,
} from '../core/types.ts';

export class DomainError extends Error {}

export function actorId(actor: Actor): string {
  return actor.kind === 'employee' ? actor.id : actor.kind;
}

export interface NewEmployee {
  name: string;
  roles: RoleTemplate[];
  cli: CliKind;
  model: string | null;
  effort?: string | null;
  rank?: Rank;
  accessLevel?: AccessLevel;
  allowedCommands?: string[][];
}

export interface NewProject {
  name: string;
  originPath: string;
  baseBranch?: string;
  integrationMode?: Project['integrationMode'];
  protectedPaths?: string[];
  verifyCommands?: VerifyCommand[];
  docRules?: string;
  autoApprove?: boolean;
  profile?: Project['profile'];
  qaAutoReject?: boolean;
  autoPlaytest?: boolean;
  acceptanceTests?: boolean;
}

export interface NewTicket {
  projectId: string;
  type: TicketType;
  title: string;
  purpose: string;
  requirements: Omit<Requirement, 'id'>[];
  doneCriteria: string;
  writeScope?: string[];
  readScope?: string[];
  priority?: 1 | 2 | 3;
  difficulty?: Difficulty;
  dependsOn?: string[];
}

export class Company {
  readonly store: Store;
  private readonly clock: () => string;

  constructor(store: Store, clock: () => string = () => new Date().toISOString()) {
    this.store = store;
    this.clock = clock;
  }

  // ---- 직원 ----

  employees(): Employee[] {
    return this.store.list<Employee>('employees', 'ORDER BY created_at');
  }

  activeEmployees(): Employee[] {
    return this.store.list<Employee>('employees', 'WHERE active = 1 ORDER BY created_at');
  }

  hireEmployee(input: NewEmployee, actor: Actor = { kind: 'ceo' }): Employee {
    if (actor.kind !== 'ceo') throw new DomainError(tr('직원 추가는 대표만 할 수 있습니다.', 'Only the CEO can add employees.'));
    if (!input.name.trim()) throw new DomainError(tr('직원 이름이 비어 있습니다.', 'Employee name is empty.'));
    if (input.roles.length === 0) throw new DomainError(tr('역할을 하나 이상 골라야 합니다.', 'Select at least one role.'));
    const accessLevel = input.accessLevel ?? 'write-ask';
    if (accessLevel === 'full-auto') {
      throw new DomainError(
        tr(
          '전체 자동 등급은 직원을 만든 뒤 대표 승인 절차로만 올릴 수 있습니다.',
          'Full-auto access requires CEO approval after creating the employee.',
        ),
      );
    }
    return this.store.transact(() => {
      if (this.activeEmployees().length >= MAX_ACTIVE_EMPLOYEES) {
        throw new DomainError(
          tr(
            `활성 직원은 최대 ${MAX_ACTIVE_EMPLOYEES}명입니다. 다른 직원을 비활성화한 뒤 추가하세요.`,
            `At most ${MAX_ACTIVE_EMPLOYEES} employees can be active. Deactivate another employee first.`,
          ),
        );
      }
      const employee: Employee = {
        id: `E-${randomUUID().slice(0, 8)}`,
        name: input.name.trim(),
        roles: input.roles,
        rank: input.rank ?? 'senior',
        cli: input.cli,
        model: input.model,
        effort: input.effort ?? null,
        accessLevel,
        allowedCommands: input.allowedCommands ?? [],
        active: true,
        createdAt: this.clock(),
      };
      this.saveEmployee(employee);
      this.store.appendEvent(
        actorId(actor),
        'employee.hired',
        employee.id,
        {
          name: employee.name,
          cli: employee.cli,
          model: employee.model,
          effort: employee.effort,
          roles: employee.roles,
          rank: employee.rank,
        },
        this.clock(),
      );
      return employee;
    });
  }

  setEmployeeModel(id: string, model: string | null, effort: string | null, actor: Actor = { kind: 'ceo' }): Employee {
    if (actor.kind !== 'ceo') throw new DomainError(tr('모델은 대표만 바꿀 수 있습니다.', 'Only the CEO can change models.'));
    return this.store.transact(() => {
      const e = this.requireEmployee(id);
      const updated = { ...e, model, effort };
      this.saveEmployee(updated);
      this.store.appendEvent('ceo', 'employee.model_changed', id, { from: [e.model, e.effort ?? null], to: [model, effort] }, this.clock());
      return updated;
    });
  }

  updateEmployeeProfile(id: string, patch: { name?: string; roles?: RoleTemplate[] }, actor: Actor = { kind: 'ceo' }): Employee {
    if (actor.kind !== 'ceo') throw new DomainError(tr('직원 정보는 대표만 바꿀 수 있습니다.', 'Only the CEO can edit employees.'));
    if (patch.name !== undefined && !patch.name.trim()) throw new DomainError(tr('직원 이름이 비어 있습니다.', 'Employee name is empty.'));
    if (patch.roles !== undefined && patch.roles.length === 0)
      throw new DomainError(tr('담당 업무를 하나 이상 골라야 합니다.', 'Select at least one duty.'));
    return this.store.transact(() => {
      const e = this.requireEmployee(id);
      const updated = {
        ...e,
        ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
        ...(patch.roles ? { roles: patch.roles } : {}),
      };
      this.saveEmployee(updated);
      this.store.appendEvent('ceo', 'employee.profile_changed', id, { name: updated.name, roles: updated.roles }, this.clock());
      return updated;
    });
  }

  /** 직원의 한 달 토큰 한도(0이면 없음). 대표만. */
  setEmployeeMonthlyLimit(id: string, tokens: number, actor: Actor = { kind: 'ceo' }): Employee {
    if (actor.kind !== 'ceo') throw new DomainError(tr('예산은 대표만 정할 수 있습니다.', 'Only the CEO can set budgets.'));
    const v = Math.max(0, Math.round(Number(tokens) || 0));
    return this.store.transact(() => {
      const e = this.requireEmployee(id);
      const updated = { ...e, monthlyTokenLimit: v || null };
      this.saveEmployee(updated);
      this.store.appendEvent('ceo', 'employee.budget_changed', id, { from: e.monthlyTokenLimit ?? null, to: v || null }, this.clock());
      return updated;
    });
  }

  setEmployeeRank(id: string, rank: Rank, actor: Actor = { kind: 'ceo' }): Employee {
    if (actor.kind !== 'ceo') throw new DomainError(tr('직급은 대표만 바꿀 수 있습니다.', 'Only the CEO can change ranks.'));
    if (!RANKS.includes(rank)) throw new DomainError(tr('알 수 없는 직급입니다.', 'Unknown rank.'));
    return this.store.transact(() => {
      const e = this.requireEmployee(id);
      const updated = { ...e, rank };
      this.saveEmployee(updated);
      this.store.appendEvent('ceo', 'employee.rank_changed', id, { from: rankOf(e), to: rank }, this.clock());
      return updated;
    });
  }

  /**
   * 직원 삭제(퇴사). 과거 업무·실행 기록이 이 직원을 가리키므로 행은 남기고 removedAt으로 표시한다.
   * 진행 중인 업무 확인은 호출하는 쪽(오케스트레이터)이 한다.
   */
  removeEmployee(id: string, actor: Actor = { kind: 'ceo' }): Employee {
    if (actor.kind !== 'ceo') throw new DomainError(tr('직원 삭제는 대표만 할 수 있습니다.', 'Only the CEO can remove employees.'));
    return this.store.transact(() => {
      const e = this.requireEmployee(id);
      if (e.removedAt) throw new DomainError(tr('이미 삭제된 직원입니다.', 'This employee was already removed.'));
      const open = this.tickets().filter(
        (t) => !TERMINAL_STATUSES.includes(t.status) && (t.assigneeId === id || t.reviewerId === id || t.ownerId === id),
      );
      if (open.length)
        throw new DomainError(
          tr(
            `${e.name}이(가) 맡은 진행 중 업무가 있습니다: ${open.map((t) => t.id).join(', ')}. 먼저 재배정하거나 취소하세요.`,
            `${e.name} still has open tickets: ${open.map((t) => t.id).join(', ')}. Reassign or cancel them first.`,
          ),
        );
      const updated = { ...e, active: false, removedAt: this.clock() };
      this.saveEmployee(updated);
      this.store.appendEvent(actorId(actor), 'employee.removed', id, { name: e.name }, this.clock());
      return updated;
    });
  }

  setEmployeeActive(id: string, active: boolean, actor: Actor = { kind: 'ceo' }): Employee {
    if (actor.kind !== 'ceo')
      throw new DomainError(tr('직원 활성 상태는 대표만 바꿀 수 있습니다.', 'Only the CEO can change employee active status.'));
    return this.store.transact(() => {
      const e = this.requireEmployee(id);
      if (active && e.removedAt)
        throw new DomainError(
          tr('삭제된 직원은 다시 활성화할 수 없습니다. 새로 채용하세요.', 'Removed employees cannot be reactivated. Hire again instead.'),
        );
      if (active && !e.active && this.activeEmployees().length >= MAX_ACTIVE_EMPLOYEES) {
        throw new DomainError(
          tr(`활성 직원은 최대 ${MAX_ACTIVE_EMPLOYEES}명입니다.`, `At most ${MAX_ACTIVE_EMPLOYEES} employees can be active.`),
        );
      }
      const updated = { ...e, active };
      this.saveEmployee(updated);
      this.store.appendEvent('ceo', active ? 'employee.activated' : 'employee.deactivated', id, {}, this.clock());
      return updated;
    });
  }

  /** 접근 등급 변경. full-auto로 올리는 것은 승인 절차(approvals)에서만 호출된다. */
  setAccessLevel(id: string, level: AccessLevel, actor: Actor, allowedCommands?: string[][]): Employee {
    if (actor.kind !== 'ceo') throw new DomainError(tr('접근 등급은 대표만 바꿀 수 있습니다.', 'Only the CEO can change access levels.'));
    // 허용 목록은 argv 접두사다. 셸 연결·치환 문자가 든 항목은 받지 않는다(중계기도 이런 명령은 자동 허용하지 않는다).
    if (allowedCommands?.some((argv) => !argv.length || argv.some((a) => !a.trim() || /[;&|`$<>()\n]/.test(a))))
      throw new DomainError(
        tr(
          '허용 목록에는 셸 연결 문자(; & | ` $ < > 괄호) 없는 명령만 넣을 수 있습니다.',
          'Allowlist entries must be plain commands without shell operators.',
        ),
      );
    return this.store.transact(() => {
      const e = this.requireEmployee(id);
      const updated = { ...e, accessLevel: level, ...(allowedCommands ? { allowedCommands } : {}) };
      this.saveEmployee(updated);
      this.store.appendEvent('ceo', 'employee.access_changed', id, { from: e.accessLevel, to: level }, this.clock());
      return updated;
    });
  }

  requireEmployee(id: string): Employee {
    const e = this.store.get<Employee>('employees', id);
    if (!e) throw new DomainError(tr(`직원 ${id}을(를) 찾을 수 없습니다.`, `Employee ${id} not found.`));
    return e;
  }

  private saveEmployee(e: Employee): void {
    this.store.put('employees', e.id, e, { active: e.active ? 1 : 0, created_at: e.createdAt });
  }

  // ---- 프로젝트 ----

  projects(): Project[] {
    return this.store.list<Project>('projects', 'ORDER BY created_at');
  }

  /** 프로젝트 삭제: 진행 중인 업무가 있으면 거부. 기록용으로 행은 남기고 removedAt으로 표시한다. */
  removeProject(id: string, actor: Actor = { kind: 'ceo' }): Project {
    if (actor.kind !== 'ceo') throw new DomainError(tr('프로젝트 삭제는 대표만 할 수 있습니다.', 'Only the CEO can remove projects.'));
    return this.store.transact(() => {
      const p = this.requireProject(id);
      if (p.removedAt) throw new DomainError(tr('이미 삭제된 프로젝트입니다.', 'This project was already removed.'));
      const open = this.tickets().filter((t) => t.projectId === id && !TERMINAL_STATUSES.includes(t.status));
      if (open.length)
        throw new DomainError(
          tr(
            `진행 중인 업무가 있습니다: ${open.map((t) => t.id).join(', ')}. 먼저 끝내거나 취소하세요.`,
            `Open tickets remain: ${open.map((t) => t.id).join(', ')}. Finish or cancel them first.`,
          ),
        );
      const updated = { ...p, removedAt: this.clock() };
      this.store.put('projects', id, updated, { created_at: p.createdAt });
      this.store.appendEvent(actorId(actor), 'project.removed', id, { name: p.name }, this.clock());
      return updated;
    });
  }

  registerProject(input: NewProject): Project {
    const project: Project = {
      id: `P-${randomUUID().slice(0, 8)}`,
      name: input.name.trim(),
      originPath: input.originPath,
      baseBranch: input.baseBranch ?? 'main',
      integrationMode: input.integrationMode ?? 'manual',
      protectedPaths: input.protectedPaths ?? [],
      verifyCommands: input.verifyCommands ?? [],
      docRules: input.docRules ?? '',
      autoApprove: input.autoApprove ?? false,
      ...(input.profile ? { profile: input.profile } : {}),
      qaAutoReject: input.qaAutoReject ?? true,
      autoPlaytest: input.autoPlaytest ?? false,
      acceptanceTests: input.acceptanceTests ?? true,
      createdAt: this.clock(),
    };
    return this.store.transact(() => {
      this.store.put('projects', project.id, project, { created_at: project.createdAt });
      this.store.appendEvent('ceo', 'project.registered', project.id, { name: project.name, originPath: project.originPath }, this.clock());
      return project;
    });
  }

  updateProject(id: string, patch: Partial<Omit<Project, 'id' | 'createdAt'>>): Project {
    return this.store.transact(() => {
      const p = this.requireProject(id);
      const updated = { ...p, ...patch };
      this.store.put('projects', id, updated, { created_at: p.createdAt });
      this.store.appendEvent('ceo', 'project.updated', id, { fields: Object.keys(patch) }, this.clock());
      return updated;
    });
  }

  requireProject(id: string): Project {
    const p = this.store.get<Project>('projects', id);
    if (!p) throw new DomainError(tr(`프로젝트 ${id}을(를) 찾을 수 없습니다.`, `Project ${id} not found.`));
    return p;
  }

  // ---- 티켓 ----

  tickets(projectId?: string): Ticket[] {
    return projectId
      ? this.store.list<Ticket>('tickets', 'WHERE project_id = ? ORDER BY created_at', projectId)
      : this.store.list<Ticket>('tickets', 'ORDER BY created_at');
  }

  requireTicket(id: string): Ticket {
    const t = this.store.get<Ticket>('tickets', id);
    if (!t) throw new DomainError(tr(`티켓 ${id}을(를) 찾을 수 없습니다.`, `Ticket ${id} not found.`));
    return t;
  }

  createTicket(input: NewTicket, actor: Actor = { kind: 'ceo' }): Ticket {
    if (actor.kind === 'employee') {
      // 직원(비서실장 포함)은 티켓을 직접 만들지 않는다. 초안을 내면 오케스트레이터가 검증해 만든다.
      throw new DomainError(
        tr(
          '직원은 티켓을 직접 만들 수 없습니다. 티켓 초안을 제출하세요.',
          'Employees cannot create tickets directly. Submit ticket drafts instead.',
        ),
      );
    }
    if (this.requireProject(input.projectId).removedAt)
      throw new DomainError(tr('삭제된 프로젝트에는 업무를 만들 수 없습니다.', 'Cannot create tickets in a removed project.'));
    if (!input.title.trim()) throw new DomainError(tr('티켓 제목이 비어 있습니다.', 'Ticket title is empty.'));
    const now = this.clock();
    return this.store.transact(() => {
      const ticket: Ticket = {
        id: `T-${this.nextTicketNumber()}`,
        projectId: input.projectId,
        type: input.type,
        title: input.title.trim(),
        purpose: input.purpose,
        requesterId: actorId(actor),
        assigneeId: null,
        reviewerId: null,
        priority: input.priority ?? 2,
        difficulty: input.difficulty ?? 'normal',
        status: 'received',
        hold: null,
        writeScope: input.writeScope ?? [],
        readScope: input.readScope ?? ['**'],
        requirements: input.requirements.map((r, i) => ({ ...r, id: `R${i + 1}` })),
        doneCriteria: input.doneCriteria,
        round: 1,
        runCount: 0,
        budget: DEFAULT_BUDGET,
        dependsOn: input.dependsOn ?? [],
        createdAt: now,
        updatedAt: now,
      };
      this.saveTicket(ticket);
      this.store.appendEvent(actorId(actor), 'ticket.created', ticket.id, { title: ticket.title, type: ticket.type }, now);
      return ticket;
    });
  }

  /** 상태 전이의 유일한 통로. */
  applyTicket(id: string, cmd: TicketCommand, actor: Actor): Ticket {
    return this.store.transact(() => {
      const current = this.requireTicket(id);
      const now = this.clock();
      const result = applyTicketCommand(current, cmd, actor, now);
      if (!result.ok) throw new DomainError(result.error);
      this.saveTicket(result.ticket);
      for (const e of result.events) this.store.appendEvent(actorId(actor), e.type, id, e.payload, now);
      return result.ticket;
    });
  }

  /** 업무의 토큰 예산을 바꾼다(대표). */
  setTicketTokenBudget(id: string, maxTokens: number): Ticket {
    const t = this.requireTicket(id);
    if (!Number.isFinite(maxTokens) || maxTokens < 100_000)
      throw new DomainError(tr('예산은 10만 토큰 이상이어야 합니다.', 'Budget must be at least 100k tokens.'));
    const next = { ...t, budget: { ...t.budget, maxTokens: Math.round(maxTokens) }, updatedAt: this.clock() };
    this.store.transact(() => {
      this.saveTicket(next);
      this.store.appendEvent('ceo', 'ticket.budget_changed', id, { maxTokens: next.budget.maxTokens }, this.clock());
    });
    return next;
  }

  /** 업무를 나눴을 때: 나눈 업무들이 끝나야 이 업무가 다시 돈다. */
  addDependencies(id: string, deps: string[]): Ticket {
    const t = this.requireTicket(id);
    const next = { ...t, dependsOn: [...new Set([...t.dependsOn, ...deps])], updatedAt: this.clock() };
    this.store.transact(() => {
      this.saveTicket(next);
      this.store.appendEvent('orchestrator', 'ticket.split', id, { parts: deps }, this.clock());
    });
    return next;
  }

  /** 대표가 범위 밖 수정을 허용할 때: 그 경로를 이 업무의 쓰기 범위에 더한다. */
  extendWriteScope(id: string, paths: string[]): Ticket {
    const t = this.requireTicket(id);
    const add = paths.filter((p) => !t.writeScope.includes(p));
    const next = { ...t, writeScope: [...t.writeScope, ...add], updatedAt: this.clock() };
    this.store.transact(() => {
      this.saveTicket(next);
      this.store.appendEvent('ceo', 'ticket.scope_extended', id, { paths: add }, this.clock());
    });
    return next;
  }

  private saveTicket(t: Ticket): void {
    this.store.put('tickets', t.id, t, { project_id: t.projectId, status: t.status, created_at: t.createdAt, updated_at: t.updatedAt });
  }

  private nextTicketNumber(): number {
    const raw = this.store.getSetting('ticket_seq');
    const next = (raw ? Number(raw) : 0) + 1;
    this.store.setSetting('ticket_seq', String(next));
    return next;
  }
}

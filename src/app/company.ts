// 회사 서비스: 저장소 위에서 직원·프로젝트·티켓을 다룬다.
// 티켓 상태 변경은 반드시 applyTicketCommand를 거치고, 결과와 이벤트를 한 트랜잭션에 저장한다.

import { randomUUID } from 'node:crypto';
import { Store } from '../store/db.ts';
import { applyTicketCommand, type Actor, type TicketCommand } from '../core/ticket-machine.ts';
import {
  DEFAULT_BUDGET,
  MAX_ACTIVE_EMPLOYEES,
  type AccessLevel,
  type CliKind,
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
    if (actor.kind !== 'ceo') throw new DomainError('직원 추가는 대표만 할 수 있습니다.');
    if (!input.name.trim()) throw new DomainError('직원 이름이 비어 있습니다.');
    if (input.roles.length === 0) throw new DomainError('역할을 하나 이상 골라야 합니다.');
    const accessLevel = input.accessLevel ?? 'write-ask';
    if (accessLevel === 'full-auto') {
      throw new DomainError('전체 자동 등급은 직원을 만든 뒤 대표 승인 절차로만 올릴 수 있습니다.');
    }
    return this.store.transact(() => {
      if (this.activeEmployees().length >= MAX_ACTIVE_EMPLOYEES) {
        throw new DomainError(`활성 직원은 최대 ${MAX_ACTIVE_EMPLOYEES}명입니다. 다른 직원을 비활성화한 뒤 추가하세요.`);
      }
      const employee: Employee = {
        id: `E-${randomUUID().slice(0, 8)}`,
        name: input.name.trim(),
        roles: input.roles,
        cli: input.cli,
        model: input.model,
        accessLevel,
        allowedCommands: input.allowedCommands ?? [],
        active: true,
        createdAt: this.clock(),
      };
      this.saveEmployee(employee);
      this.store.appendEvent(actorId(actor), 'employee.hired', employee.id, { name: employee.name, cli: employee.cli, model: employee.model, roles: employee.roles }, this.clock());
      return employee;
    });
  }

  setEmployeeActive(id: string, active: boolean, actor: Actor = { kind: 'ceo' }): Employee {
    if (actor.kind !== 'ceo') throw new DomainError('직원 활성 상태는 대표만 바꿀 수 있습니다.');
    return this.store.transact(() => {
      const e = this.requireEmployee(id);
      if (active && !e.active && this.activeEmployees().length >= MAX_ACTIVE_EMPLOYEES) {
        throw new DomainError(`활성 직원은 최대 ${MAX_ACTIVE_EMPLOYEES}명입니다.`);
      }
      const updated = { ...e, active };
      this.saveEmployee(updated);
      this.store.appendEvent('ceo', active ? 'employee.activated' : 'employee.deactivated', id, {}, this.clock());
      return updated;
    });
  }

  /** 접근 등급 변경. full-auto로 올리는 것은 승인 절차(approvals)에서만 호출된다. */
  setAccessLevel(id: string, level: AccessLevel, actor: Actor): Employee {
    if (actor.kind !== 'ceo') throw new DomainError('접근 등급은 대표만 바꿀 수 있습니다.');
    return this.store.transact(() => {
      const e = this.requireEmployee(id);
      const updated = { ...e, accessLevel: level };
      this.saveEmployee(updated);
      this.store.appendEvent('ceo', 'employee.access_changed', id, { from: e.accessLevel, to: level }, this.clock());
      return updated;
    });
  }

  requireEmployee(id: string): Employee {
    const e = this.store.get<Employee>('employees', id);
    if (!e) throw new DomainError(`직원 ${id}을(를) 찾을 수 없습니다.`);
    return e;
  }

  private saveEmployee(e: Employee): void {
    this.store.put('employees', e.id, e, { active: e.active ? 1 : 0, created_at: e.createdAt });
  }

  // ---- 프로젝트 ----

  projects(): Project[] {
    return this.store.list<Project>('projects', 'ORDER BY created_at');
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
    if (!p) throw new DomainError(`프로젝트 ${id}을(를) 찾을 수 없습니다.`);
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
    if (!t) throw new DomainError(`티켓 ${id}을(를) 찾을 수 없습니다.`);
    return t;
  }

  createTicket(input: NewTicket, actor: Actor = { kind: 'ceo' }): Ticket {
    if (actor.kind === 'employee') {
      // 직원(비서실장 포함)은 티켓을 직접 만들지 않는다. 초안을 내면 오케스트레이터가 검증해 만든다.
      throw new DomainError('직원은 티켓을 직접 만들 수 없습니다. 티켓 초안을 제출하세요.');
    }
    this.requireProject(input.projectId);
    if (!input.title.trim()) throw new DomainError('티켓 제목이 비어 있습니다.');
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

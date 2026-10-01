import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/store/db.ts';
import { Company } from '../../src/app/company.ts';
import { Orchestrator, type OrchestratorOptions } from '../../src/app/orchestrator.ts';
import { AGENT_IDENTITY, git } from '../../src/workspace/git.ts';
import type { Ticket, TicketStatus, VerifyCommand } from '../../src/core/types.ts';

export interface Env {
  root: string;
  origin: string;
  dataDir: string;
  dbPath: string;
  store: Store;
  company: Company;
  orch: Orchestrator;
  projectId: string;
}

export async function makeOrigin(root: string): Promise<string> {
  const origin = join(root, 'origin');
  mkdirSync(join(origin, 'src'), { recursive: true });
  await git(['init', '-q', '-b', 'main'], origin);
  writeFileSync(join(origin, 'src', 'app.ts'), 'export const version = 1;\n');
  writeFileSync(join(origin, 'README.md'), '# demo\n');
  await git(['add', '-A'], origin);
  await git([...AGENT_IDENTITY, 'commit', '-q', '-m', 'init'], origin);
  return origin;
}

export async function setup(
  t: { after: (fn: () => void | Promise<void>) => void },
  opts: {
    implementer?: string;
    reviewer?: string;
    verify?: VerifyCommand[];
    integrationMode?: 'manual' | 'auto_after_approval';
    screenCheck?: boolean;
    /** 출처 링크 확인(기본: 네트워크 없이 모두 열림) */
    linkCheck?: OrchestratorOptions['linkCheck'];
  } = {},
): Promise<Env> {
  const root = mkdtempSync(join(tmpdir(), 'ac-e2e-'));
  const origin = await makeOrigin(root);
  const dataDir = join(root, 'data');
  const dbPath = join(root, 'company.db');
  const store = new Store(dbPath);
  const company = new Company(store);
  const orch = new Orchestrator(company, {
    dataDir,
    language: 'ko',
    screenCheck: opts.screenCheck ?? false,
    linkCheck: opts.linkCheck ?? (async (urls) => urls.map((url) => ({ url, state: 'ok' as const, detail: '200' }))),
  });
  t.after(async () => {
    await orch.stop();
    await orch.idle();
    store.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });
  const project = company.registerProject({
    name: 'demo',
    originPath: origin,
    protectedPaths: ['README.md'],
    verifyCommands: opts.verify ?? [{ label: 'unit tests', argv: ['node', '-e', 'process.exit(0)'], evidenceType: 'unit_test' }],
    integrationMode: opts.integrationMode ?? 'manual',
  });
  company.hireEmployee({ name: '구현 직원', roles: ['implementer'], cli: 'fake', model: opts.implementer ?? 'diligent' });
  company.hireEmployee({ name: 'QA 직원', roles: ['qa'], cli: 'fake', model: opts.reviewer ?? 'diligent' });
  return { root, origin, dataDir, dbPath, store, company, orch, projectId: project.id };
}

export function newImplTicket(env: Env): Ticket {
  return env.company.createTicket({
    projectId: env.projectId,
    type: 'impl',
    title: '버전 표시 기능',
    purpose: '앱 버전을 화면에 표시',
    requirements: [{ text: '버전 문자열을 반환하는 함수', evidenceType: 'unit_test' }],
    doneCriteria: '단위 테스트 통과',
    writeScope: ['src/**'],
  });
}

/** 조건을 만족하거나 보류될 때까지 tick을 반복한다. */
export async function driveUntil(env: Env, ticketId: string, until: (t: Ticket) => boolean, maxMs = 60_000): Promise<Ticket> {
  const deadline = Date.now() + maxMs;
  for (;;) {
    await env.orch.tick();
    const t = env.company.requireTicket(ticketId);
    if (until(t)) return t;
    if (Date.now() > deadline) throw new Error(`시간 초과: ${ticketId} 상태 ${t.status} 보류 ${t.hold?.reason ?? '-'}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

export const statusIs =
  (...s: TicketStatus[]) =>
  (t: Ticket) =>
    s.includes(t.status);

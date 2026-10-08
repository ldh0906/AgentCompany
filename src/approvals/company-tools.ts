// 회사 도구: 직원이 실행 중에 MCP 도구로 회사 시스템에 말을 건다(동료 질문, 후속 업무 제안, 업무판 읽기, 범위 요청).
// LLM은 제안하고 코드가 결정한다: 도구는 티켓을 만들거나 배정·병합하지 않는다. 데몬이 요청을 받아 기존 흐름으로 처리한다.
// MCP 서버(mcp-company.ts)는 DB에 접근하지 않는다. 승인 큐처럼 실행 폴더의 파일로 데몬과 주고받는다:
//   <id>.request.json(서버) → <id>.response.json(데몬). 답을 기다리는 중이라는 상태는 데몬 DB에만 둔다
//   (실행 폴더는 직원이 쓸 수 있어 그 안의 파일은 믿지 않는다: QA 2차, 위조한 대기 기록으로 다른 방의 답을 읽을 수 있었다).
// 요청은 그 실행의 폴더에만 쓰이고 nonce가 맞아야 처리되므로, 그 실행의 직원·업무로만 동작한다.

import path from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { atomicJson, validateId } from './file-queue.ts';

export const COMPANY_SERVER = 'ac_company';
export type ToolRunKind = 'work' | 'review';

/** 실행에 회사 도구를 붙일 때 어댑터에 넘기는 값. */
export interface CompanyToolsSpec {
  dir: string;
  nonce: string;
  kind: ToolRunKind;
}

export interface ToolRequest {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  nonce: string;
  createdAt: string;
}

export interface ToolResponse {
  ok: boolean;
  text: string;
}

export const COMPANY_TOOLS = [
  {
    name: 'ask_colleague',
    kinds: ['work', 'review'] as ToolRunKind[],
    description:
      "Ask a colleague a question. It is posted in this ticket's chat room and the tool waits for their answer (it can take a few minutes). Use the colleague's exact name.",
    inputSchema: {
      type: 'object',
      properties: { to: { type: 'string', description: "colleague's exact name" }, question: { type: 'string' } },
      required: ['to', 'question'],
    },
  },
  {
    name: 'propose_ticket',
    kinds: ['work', 'review'] as ToolRunKind[],
    description:
      "Propose a follow-up ticket for a problem outside this ticket's scope. It is posted in the ticket room; the CEO (or the delegate) decides whether it becomes a ticket. It does not create a ticket.",
    inputSchema: {
      type: 'object',
      properties: { title: { type: 'string' }, reason: { type: 'string' } },
      required: ['title', 'reason'],
    },
  },
  {
    name: 'board_status',
    kinds: ['work', 'review'] as ToolRunKind[],
    description: "Read the project's ticket board: open tickets with status, assignee and reviewer, and recently finished ones.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'request_scope',
    kinds: ['work'] as ToolRunKind[],
    description:
      'Ask to also edit files outside your write scope. Test files no other ticket is using are allowed at once and you continue in this run. Anything else goes to the CEO: finish what you can inside your scope, then end your run with status "blocked".',
    inputSchema: {
      type: 'object',
      properties: { paths: { type: 'array', items: { type: 'string' } }, reason: { type: 'string' } },
      required: ['paths', 'reason'],
    },
  },
];

export function companyToolsFor(kind: ToolRunKind) {
  return COMPANY_TOOLS.filter((t) => t.kinds.includes(kind)).map(({ name, description, inputSchema }) => ({
    name,
    description,
    inputSchema,
  }));
}

/** Claude --allowedTools 에 넣을 이름. */
export function companyToolPermissions(kind: ToolRunKind): string[] {
  return companyToolsFor(kind).map((t) => `mcp__${COMPANY_SERVER}__${t.name}`);
}

export function companyToolsDir(runDir: string): string {
  return path.join(runDir, 'tools');
}

function serverScriptPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const ts = path.join(here, 'mcp-company.ts');
  return existsSync(ts) ? ts : path.join(here, 'mcp-company.js');
}

/** stdio MCP 서버 실행 방법(Claude --mcp-config, Codex mcp_servers, 가짜 직원이 같은 값을 쓴다). */
export function companyToolServer(spec: CompanyToolsSpec): { command: string; args: string[]; env: Record<string, string> } {
  return {
    command: process.execPath,
    args: ['--no-warnings', serverScriptPath()],
    env: { AC_TOOL_DIR: spec.dir, AC_TOOL_NONCE: spec.nonce, AC_TOOL_KIND: spec.kind },
  };
}

export async function writeToolRequest(dir: string, req: Omit<ToolRequest, 'id' | 'createdAt'>): Promise<string> {
  await mkdir(dir, { recursive: true });
  const id = randomUUID();
  await atomicJson(path.join(dir, `${id}.request.json`), { ...req, id, createdAt: new Date().toISOString() });
  return id;
}

export async function writeToolResponse(dir: string, id: string, res: ToolResponse): Promise<void> {
  validateId(id);
  await atomicJson(path.join(dir, `${id}.response.json`), res);
}

/** 아직 답하지 않은 요청 */
export async function openToolRequests(dir: string): Promise<{ req: ToolRequest }[]> {
  const files = await readdir(dir).catch(() => [] as string[]);
  const out: { req: ToolRequest }[] = [];
  for (const f of files.filter((x) => x.endsWith('.request.json')).sort()) {
    const id = f.slice(0, -'.request.json'.length);
    if (files.includes(`${id}.response.json`)) continue;
    try {
      const req = JSON.parse(await readFile(path.join(dir, f), 'utf8')) as ToolRequest;
      out.push({ req: { ...req, id } });
    } catch {
      // 쓰는 중이거나 깨진 파일: 다음 주기에 다시
    }
  }
  return out;
}

export async function waitToolResponse(dir: string, id: string, timeoutMs: number, signal?: AbortSignal): Promise<ToolResponse | null> {
  validateId(id);
  const deadline = performance.now() + timeoutMs;
  while (!signal?.aborted) {
    try {
      const r = JSON.parse(await readFile(path.join(dir, `${id}.response.json`), 'utf8')) as ToolResponse;
      return { ok: r.ok === true, text: String(r.text ?? '') };
    } catch {
      // 아직 없음
    }
    const remaining = deadline - performance.now();
    if (remaining <= 0) break;
    await delay(Math.min(200, remaining), undefined, { signal }).catch(() => {});
  }
  return null;
}

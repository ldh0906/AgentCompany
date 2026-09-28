// Codex 승인 중계 호스트. 셔틀 아래에서 실행되어 데몬이 죽어도 살아남는다.
//   셔틀 → codex-relay(이 스크립트) → codex app-server (JSON-RPC, stdio)
// - 명령 실행·파일 변경 승인 요청을 파일 큐로 넘겨 대표가 대시보드에서 허용/거부한다.
// - 출력은 `codex exec --json`과 같은 모양(thread.started / item.completed / turn.failed)으로 바꿔 stdout에 쓴다.
//   그래서 기존 Codex 파서를 그대로 쓴다.
// 메서드 이름은 로컬 `codex app-server generate-ts`(0.153.4)로 확인했다. 실제 구독으로의 종단간 실측은 아직이다.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { createApprovalRequest, waitForDecision } from '../approvals/file-queue.ts';
import { locateExecutable } from '../runner/locate.ts';

const env = process.env;
const approvalDir = env.AC_APPROVAL_DIR ?? '';
const policy = env.AC_CODEX_POLICY ?? 'untrusted';
const allowed: string[][] = JSON.parse(env.AC_ALLOWED_COMMANDS ?? '[]');
const approvalTimeoutMs = Number(env.AC_APPROVAL_TIMEOUT_MS ?? 600_000);
const SHELL_META = /[;&|`$<>(){}\n]/;

function out(event: object): void {
  process.stdout.write(JSON.stringify(event) + '\n');
}

/** 허용 목록 자동 승인: 셸 메타문자가 없고, 허용된 argv 접두사로 시작할 때만. */
export function isAllowlisted(command: unknown, list: string[][]): boolean {
  const text = Array.isArray(command) ? command.join(' ') : String(command ?? '');
  if (!text || SHELL_META.test(text)) return false;
  const tokens = text.trim().split(/\s+/);
  return list.some((argv) => argv.length > 0 && argv.every((a, i) => tokens[i] === a));
}

async function main(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  const prompt = Buffer.concat(chunks).toString('utf8');

  const codex = env.AC_CODEX_BIN
    ? { launch: { file: env.AC_CODEX_BIN, argsPrefix: JSON.parse(env.AC_CODEX_ARGS ?? '[]') as string[] } }
    : await locateExecutable('codex');
  if (!codex?.launch) {
    out({ type: 'error', message: 'codex 실행 파일을 찾지 못했습니다.' });
    process.exitCode = 1;
    return;
  }
  const child = spawn(codex.launch.file, [...codex.launch.argsPrefix, 'app-server'], {
    cwd: env.AC_CODEX_CWD,
    env,
    windowsHide: true,
    shell: false,
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const pending = new Map<number, (m: { result?: unknown; error?: unknown }) => void>();
  let nextId = 1;
  let threadId: string | null = null;
  // 파일 변경 승인 요청에는 itemId뿐이다. 바뀔 파일·diff는 먼저 온 item/started(fileChange)에 있다.
  const fileItems = new Map<string, { path: string; kind: string; diff: string }[]>();
  let finished!: (ok: boolean) => void;
  const done = new Promise<boolean>((r) => (finished = r));
  child.once('close', () => finished(false));

  const send = (m: object) => child.stdin.write(JSON.stringify(m) + '\n');
  const request = (method: string, params: unknown) =>
    new Promise<{ result?: any; error?: unknown }>((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      send({ id, method, params });
    });

  createInterface({ input: child.stdout }).on('line', (line) => {
    let m: any;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    if (m.id !== undefined && !m.method && pending.has(m.id)) {
      pending.get(m.id)!(m);
      pending.delete(m.id);
      return;
    }
    if (m.method && m.id !== undefined) {
      void handleServerRequest(m);
      return;
    }
    if (m.method === 'item/started' && m.params?.item?.type === 'fileChange') {
      const changes = Array.isArray(m.params.item.changes) ? m.params.item.changes : [];
      fileItems.set(
        String(m.params.item.id),
        changes.map((c: any) => ({
          path: String(c?.path ?? ''),
          kind: String(c?.kind?.type ?? c?.kind ?? ''),
          diff: String(c?.diff ?? ''),
        })),
      );
    }
    if (m.method === 'item/completed' && m.params?.item?.type === 'agentMessage') {
      out({ type: 'item.completed', item: { type: 'agent_message', text: m.params.item.text } });
    } else if (m.method === 'item/completed' && m.params?.item?.type === 'commandExecution') {
      out({ type: 'item.completed', item: { type: 'command_execution', command: m.params.item.command } });
    } else if (m.method === 'turn/completed' && m.params?.threadId === threadId) {
      const status = m.params.turn?.status;
      if (status !== 'completed')
        out({ type: 'turn.failed', error: { message: `turn ${status}: ${JSON.stringify(m.params.turn?.error ?? '')}` } });
      else out({ type: 'turn.completed' });
      finished(status === 'completed');
    }
  });

  async function handleServerRequest(m: any): Promise<void> {
    const approvalMethods = ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'];
    if (!approvalMethods.includes(m.method)) {
      send({ id: m.id, error: { code: -32601, message: 'unsupported' } });
      return;
    }
    const isCommand = m.method === approvalMethods[0];
    if (isCommand && isAllowlisted(m.params?.command, allowed)) {
      out({ type: 'approval.auto', command: m.params?.command });
      send({ id: m.id, result: { decision: 'accept' } });
      return;
    }
    if (!approvalDir) {
      send({ id: m.id, result: { decision: 'decline' } });
      return;
    }
    const { id } = await createApprovalRequest(approvalDir, {
      source: 'codex',
      kind: isCommand ? 'command' : 'fileChange',
      detail: isCommand ? { command: m.params?.command, cwd: m.params?.cwd } : fileChangeDetail(m.params, fileItems),
    });
    const d = await waitForDecision(approvalDir, id, approvalTimeoutMs);
    out({ type: 'approval.decided', kind: isCommand ? 'command' : 'fileChange', decision: d.decision });
    send({ id: m.id, result: { decision: d.decision === 'allow' ? (d.scope === 'ticket' ? 'acceptForSession' : 'accept') : 'decline' } });
  }

  const init = await request('initialize', {
    clientInfo: { name: 'agent_company', title: 'Agent Company', version: '0.1.0' },
    capabilities: null,
  });
  if (init.error) {
    out({ type: 'error', message: `initialize 실패: ${JSON.stringify(init.error)}` });
    child.kill();
    process.exitCode = 1;
    return;
  }
  send({ method: 'initialized' });
  const thread = await request('thread/start', {
    cwd: env.AC_CODEX_CWD,
    sandbox: 'workspace-write',
    approvalPolicy: policy,
    approvalsReviewer: 'user',
    ...(env.AC_CODEX_MODEL ? { model: env.AC_CODEX_MODEL } : {}),
  });
  threadId = thread.result?.thread?.id ?? null;
  if (!threadId) {
    out({ type: 'error', message: `thread/start 실패: ${JSON.stringify(thread.error ?? thread.result)}` });
    child.kill();
    process.exitCode = 1;
    return;
  }
  out({ type: 'thread.started', thread_id: threadId });
  await request('turn/start', { threadId, input: [{ type: 'text', text: prompt, text_elements: [] }] });
  const ok = await done;
  child.stdin.end();
  child.kill();
  process.exitCode = ok ? 0 : 1;
}

const MAX_APPROVAL_DIFF = 8_000;

/** 대표가 무엇을 승인하는지 볼 수 있게: 바뀔 파일 목록과 (잘린) diff. */
function fileChangeDetail(params: any, items: Map<string, { path: string; kind: string; diff: string }[]>): object {
  const changes = items.get(String(params?.itemId)) ?? [];
  const diff = changes.map((c) => `--- ${c.path} (${c.kind})\n${c.diff}`).join('\n');
  return {
    reason: params?.reason ?? null,
    files: changes.map((c) => ({ path: c.path, kind: c.kind })),
    diff: diff.length > MAX_APPROVAL_DIFF ? `${diff.slice(0, MAX_APPROVAL_DIFF)}\n…(truncated)` : diff,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    out({ type: 'error', message: String(error) });
    process.exitCode = 1;
  });
}

// Claude Code의 --permission-prompt-tool 로 연결되는 stdio MCP 서버.
// 권한 요청을 파일 큐에 올리고, 대표가 대시보드에서 허용/거부하면 그 결정을 Claude에 돌려준다.
// stdout에는 JSON-RPC 외에 아무것도 쓰지 않는다.

import { createInterface } from 'node:readline';
import { createApprovalRequest, waitForDecision } from './file-queue.ts';

const dir = process.env.AC_APPROVAL_DIR;
const source = process.env.AC_APPROVAL_SOURCE ?? 'claude';
const timeoutMs = Number(process.env.AC_APPROVAL_TIMEOUT_MS ?? 600_000);

function send(message: unknown): void {
  process.stdout.write(JSON.stringify(message) + '\n');
}

async function handle(line: string, signal: AbortSignal): Promise<void> {
  let m: { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };
  try {
    m = JSON.parse(line);
  } catch {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
    return;
  }
  if (m.id === undefined) return; // 알림
  const reply = (result: unknown) => send({ jsonrpc: '2.0', id: m.id, result });
  const fail = (code: number, message: string) => send({ jsonrpc: '2.0', id: m.id, error: { code, message } });
  switch (m.method) {
    case 'initialize':
      return reply({
        protocolVersion: (m.params?.protocolVersion as string) ?? '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'ac_approver', version: '0.1.0' },
      });
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({
        tools: [
          {
            name: 'approve',
            description: 'Ask the human CEO to approve a tool call.',
            inputSchema: {
              type: 'object',
              properties: { tool_name: { type: 'string' }, input: { type: 'object' }, tool_use_id: { type: 'string' } },
              required: ['tool_name', 'input'],
            },
          },
        ],
      });
    case 'tools/call': {
      const args = (m.params?.arguments ?? {}) as { tool_name?: unknown; input?: unknown };
      if (m.params?.name !== 'approve' || typeof args.tool_name !== 'string' || !args.input || typeof args.input !== 'object') {
        return fail(-32602, 'invalid arguments');
      }
      if (!dir) {
        return reply({ content: [{ type: 'text', text: JSON.stringify({ behavior: 'deny', message: 'approval queue not configured' }) }] });
      }
      try {
        const { id } = await createApprovalRequest(dir, { source, kind: args.tool_name, detail: args });
        const d = await waitForDecision(dir, id, timeoutMs, signal);
        const result =
          d.decision === 'allow'
            ? { behavior: 'allow', updatedInput: args.input }
            : { behavior: 'deny', message: d.message ?? 'The CEO denied this action.' };
        return reply({ content: [{ type: 'text', text: JSON.stringify(result) }] });
      } catch {
        return reply({ content: [{ type: 'text', text: JSON.stringify({ behavior: 'deny', message: 'approval failed' }) }] });
      }
    }
    default:
      return fail(-32601, 'method not found');
  }
}

const controller = new AbortController();
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('close', () => controller.abort());
lines.on('line', (line) => {
  if (line.trim()) void handle(line, controller.signal);
});

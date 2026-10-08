// 회사 도구 stdio MCP 서버(company-tools.ts). Claude --mcp-config, Codex mcp_servers 로 연결된다.
// 도구 호출을 실행 폴더의 파일 큐에 올리고 데몬의 답을 돌려준다. stdout에는 JSON-RPC 외에 아무것도 쓰지 않는다.

import { createInterface } from 'node:readline';
import { companyToolsFor, waitToolResponse, writeToolRequest, type ToolRunKind } from './company-tools.ts';

const dir = process.env.AC_TOOL_DIR ?? '';
const nonce = process.env.AC_TOOL_NONCE ?? '';
const kind: ToolRunKind = process.env.AC_TOOL_KIND === 'review' ? 'review' : 'work';
const timeoutMs = Number(process.env.AC_TOOL_TIMEOUT_MS ?? 60_000);
// 동료의 답은 짧은 대화 실행 하나를 기다린다(대화 실행 제한 10분).
const askTimeoutMs = Number(process.env.AC_TOOL_ASK_TIMEOUT_MS ?? 600_000);
const tools = companyToolsFor(kind);

function send(message: unknown): void {
  process.stdout.write(JSON.stringify(message) + '\n');
}

const text = (t: string, isError = false) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });

async function handle(line: string, signal: AbortSignal): Promise<void> {
  let m: { id?: string | number | null; method?: string; params?: Record<string, unknown> };
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
        serverInfo: { name: 'ac_company', version: '0.1.0' },
      });
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools });
    case 'tools/call': {
      const name = String(m.params?.name ?? '');
      const args = m.params?.arguments;
      if (!tools.some((t) => t.name === name)) return fail(-32602, `unknown tool: ${name}`);
      if (!dir) return reply(text('Company tools are not configured for this run.', true));
      const ask = name === 'ask_colleague';
      try {
        const id = await writeToolRequest(dir, {
          tool: name,
          args: args && typeof args === 'object' ? (args as Record<string, unknown>) : {},
          nonce,
        });
        const res = await waitToolResponse(dir, id, ask ? askTimeoutMs : timeoutMs, signal);
        if (res) return reply(text(res.text, !res.ok));
        return reply(
          text(
            ask
              ? 'No answer yet. The question stays in the ticket room and the answer will appear there; continue without it.'
              : 'The company system did not answer in time. Continue without it.',
            true,
          ),
        );
      } catch {
        return reply(text('The company tool failed.', true));
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

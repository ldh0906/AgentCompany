// 회사 도구(MCP): 어댑터 연결(Claude --mcp-config·허용 도구, Codex mcp_servers), stdio 서버, Codex 중계의 도구 확인 응답.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { claudeAdapter } from '../../src/adapters/claude.ts';
import { codexAdapter } from '../../src/adapters/codex.ts';
import { companyToolServer, writeToolResponse } from '../../src/approvals/company-tools.ts';
import type { InvocationRequest } from '../../src/adapters/types.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const base: InvocationRequest = {
  prompt: 'p',
  cwd: '.',
  model: null,
  accessLevel: 'read-only',
  allowedCommands: [],
  profileEnv: {},
  runDir: 'run',
};
const tools = { dir: 'run/tools', nonce: 'n1', kind: 'work' as const };
const after = (args: string[], flag: string) => args[args.indexOf(flag) + 1] ?? '';

test('Claude: 회사 도구 서버를 --mcp-config로 붙이고 도구를 승인 없이 허용한다', () => {
  const ro = claudeAdapter.buildInvocation({ ...base, companyTools: tools });
  const cfg = JSON.parse(ro.files.find((f) => f.path.endsWith('mcp-config.json'))!.content);
  assert.deepEqual(cfg.mcpServers.ac_company.env, { AC_TOOL_DIR: 'run/tools', AC_TOOL_NONCE: 'n1', AC_TOOL_KIND: 'work' });
  assert.ok(ro.args.includes('--mcp-config') && ro.args.includes('--strict-mcp-config'));
  assert.match(after(ro.args, '--allowedTools'), /mcp__ac_company__ask_colleague/);
  assert.match(after(ro.args, '--allowedTools'), /mcp__ac_company__request_scope/);

  // 검수 실행: 범위 요청 도구는 없다
  const review = claudeAdapter.buildInvocation({ ...base, companyTools: { ...tools, kind: 'review' } });
  assert.doesNotMatch(after(review.args, '--allowedTools'), /request_scope/);

  // 승인 중계와 함께: 서버 둘이 한 설정 파일에
  const ask = claudeAdapter.buildInvocation({ ...base, accessLevel: 'write-ask', approvalDir: 'q', companyTools: tools });
  const both = JSON.parse(ask.files[0]!.content);
  assert.deepEqual(Object.keys(both.mcpServers).sort(), ['ac_approver', 'ac_company']);
  assert.match(after(ask.args, '--allowedTools'), /mcp__ac_company__propose_ticket/);

  // 회사 도구가 없으면 예전과 같다(읽기 전용은 MCP 설정 없음)
  assert.equal(claudeAdapter.buildInvocation(base).files.length, 0);
});

test('Codex: 회사 도구 서버 정보를 중계기에 넘긴다', () => {
  const inv = codexAdapter.buildInvocation({ ...base, companyTools: tools });
  assert.deepEqual(JSON.parse(inv.env.AC_COMPANY_MCP!).env.AC_TOOL_NONCE, 'n1');
  assert.equal(codexAdapter.buildInvocation(base).env.AC_COMPANY_MCP, undefined);
});

test('MCP 서버: 실행 종류별 도구 목록, 요청을 파일 큐에 올리고 데몬의 답을 돌려준다', { timeout: 30_000 }, async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ac-tools-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const spec = companyToolServer({ dir, nonce: 'n1', kind: 'review' });
  const child = spawn(spec.command, spec.args, {
    env: { ...process.env, ...spec.env },
    stdio: ['pipe', 'pipe', 'inherit'],
    windowsHide: true,
  });
  t.after(() => child.kill());
  const waiting = new Map<number, (m: any) => void>();
  createInterface({ input: child.stdout }).on('line', (l) => {
    const m = JSON.parse(l);
    waiting.get(m.id)?.(m);
  });
  let id = 0;
  const rpc = (method: string, params: object) =>
    new Promise<any>((resolve) => {
      waiting.set(++id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  assert.equal((await rpc('initialize', {})).result.serverInfo.name, 'ac_company');
  const names = (await rpc('tools/list', {})).result.tools.map((x: { name: string }) => x.name);
  assert.deepEqual(names, ['ask_colleague', 'propose_ticket', 'board_status']);
  assert.ok((await rpc('tools/call', { name: 'request_scope', arguments: {} })).error, '검수 실행에는 범위 요청이 없다');

  // 데몬 역할: 올라온 요청을 읽고 답한다
  const poll = setInterval(async () => {
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.request.json'))) {
      const req = JSON.parse(readFileSync(path.join(dir, f), 'utf8'));
      if (req.tool === 'board_status' && req.nonce === 'n1') await writeToolResponse(dir, req.id, { ok: true, text: 'T-1 [in_progress]' });
    }
  }, 50);
  t.after(() => clearInterval(poll));
  const r = await rpc('tools/call', { name: 'board_status', arguments: {} });
  assert.deepEqual(r.result, { content: [{ type: 'text', text: 'T-1 [in_progress]' }] });
});

test('Codex 중계: 회사 도구 서버를 mcp_servers로 붙이고, 그 서버의 도구 확인만 받아들인다', { timeout: 30_000 }, async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ac-relay-tools-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const inv = codexAdapter.buildInvocation({ ...base, cwd: dir, accessLevel: 'full-auto', runDir: dir, companyTools: tools });
  const child = spawn(inv.file, inv.args, {
    env: {
      ...inv.env,
      AC_CODEX_BIN: process.execPath,
      AC_CODEX_ARGS: JSON.stringify(['--no-warnings', path.join(here, 'fake-appserver.ts')]),
      AC_EXPECT_COMPANY_MCP: '1',
    },
    stdio: ['pipe', 'pipe', 'inherit'],
    windowsHide: true,
  });
  child.stdin.end('프롬프트');
  let stdout = '';
  child.stdout.on('data', (d) => (stdout += d));
  const code = await new Promise<number | null>((r) => child.once('close', r));
  assert.equal(code, 0, stdout);
  assert.match(stdout, /"turn.completed"/);
});

// 로컬 generate-ts(0.153.4) 스키마 형식을 따르는 가짜 codex app-server. 모델은 호출하지 않는다.
import { createInterface } from 'node:readline';
const send = (m: unknown) => process.stdout.write(JSON.stringify(m) + '\n');
let count = 0;
for await (const line of createInterface({ input: process.stdin })) {
  const m = JSON.parse(line);
  if (m.method === 'initialize') send({ id: m.id, result: { userAgent: 'fake' } });
  else if (m.method === 'thread/start') {
    if (m.params.approvalPolicy !== 'untrusted' || m.params.approvalsReviewer !== 'user' || m.params.sandbox !== 'workspace-write')
      process.exit(3);
    // 회사 도구 MCP 서버가 점 경로 설정 키로 붙었는지
    const company = m.params.config?.['mcp_servers.ac_company'];
    if (process.env.AC_EXPECT_COMPANY_MCP && (company?.env?.AC_TOOL_NONCE !== 'n1' || !(company.tool_timeout_sec > 60))) process.exit(6);
    send({ id: m.id, result: { thread: { id: 'thread-1' } } });
  } else if (m.id === 'e1' || m.id === 'e2') {
    // 회사 도구 호출 확인(elicitation): 우리 서버만 받아들인다
    const want = m.id === 'e1' ? 'accept' : 'decline';
    if (m.result?.action !== want) process.exit(7);
  } else if (m.method === 'turn/start') {
    if (process.env.AC_EXPECT_EFFORT && m.params.effort !== process.env.AC_EXPECT_EFFORT) process.exit(5);
    if (process.env.AC_EXPECT_COMPANY_MCP) {
      const params = { threadId: 'thread-1', turnId: 'turn-1', mode: 'form', _meta: null, message: 'run tool?', requestedSchema: {} };
      send({ id: 'e1', method: 'mcpServer/elicitation/request', params: { ...params, serverName: 'ac_company' } });
      send({ id: 'e2', method: 'mcpServer/elicitation/request', params: { ...params, serverName: 'other' } });
    }
    send({ id: m.id, result: { turn: { id: 'turn-1', status: 'inProgress', items: [], error: null } } });
    send({
      id: 'c1',
      method: 'item/commandExecution/requestApproval',
      params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'i1', command: 'npm test', cwd: '.' },
    });
    send({
      id: 'c2',
      method: 'item/commandExecution/requestApproval',
      params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'i2', command: 'rm -rf build', cwd: '.' },
    });
    // 생성 중 신호(패치 작성): 중계기가 heartbeat로 남긴다
    send({ method: 'item/fileChange/patchUpdated', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'f1' } });
    // 실측(0.153.4): 파일 변경 승인 요청에는 itemId뿐이다. 바뀔 파일은 먼저 온 item/started에 있다.
    send({
      method: 'item/started',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: {
          type: 'fileChange',
          id: 'f1',
          status: 'inProgress',
          changes: [{ path: 'src/party.js', kind: { type: 'update' }, diff: '+export const x = 1;' }],
        },
      },
    });
    send({
      id: 'c3',
      method: 'item/fileChange/requestApproval',
      params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'f1', reason: null },
    });
  } else if (m.id === 'c1' || m.id === 'c2' || m.id === 'c3') {
    send({
      method: 'item/completed',
      params: { item: { type: 'commandExecution', id: m.id, command: m.id, decision: m.result?.decision } },
    });
    if (++count === 3) {
      send({
        method: 'item/completed',
        params: { item: { type: 'agentMessage', id: 'a1', text: `decisions done: ${m.result?.decision}` } },
      });
      // 실측 스키마(0.153.4): 누적 사용량은 thread/tokenUsage/updated 의 tokenUsage.total
      send({
        method: 'thread/tokenUsage/updated',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          tokenUsage: {
            total: { inputTokens: 1200, cachedInputTokens: 800, outputTokens: 34, reasoningOutputTokens: 0, totalTokens: 1234 },
            last: { inputTokens: 1200, cachedInputTokens: 800, outputTokens: 34, reasoningOutputTokens: 0, totalTokens: 1234 },
          },
        },
      });
      send({
        method: 'turn/completed',
        params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', items: [], error: null } },
      });
    }
  }
}

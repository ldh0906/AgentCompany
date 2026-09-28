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
    send({ id: m.id, result: { thread: { id: 'thread-1' } } });
  } else if (m.method === 'turn/start') {
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
  } else if (m.id === 'c1' || m.id === 'c2') {
    send({
      method: 'item/completed',
      params: { item: { type: 'commandExecution', id: m.id, command: m.id, decision: m.result?.decision } },
    });
    if (++count === 2) {
      send({
        method: 'item/completed',
        params: { item: { type: 'agentMessage', id: 'a1', text: `decisions done: ${m.result?.decision}` } },
      });
      send({
        method: 'turn/completed',
        params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', items: [], error: null } },
      });
    }
  }
}

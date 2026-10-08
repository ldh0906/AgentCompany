// TUI 키: 승인·반려 확인 중에 목록이 바뀌어도 처음 고른 승인에만 적용한다(QA P0, 2026-10-08).
// 전에는 확인 키를 누를 때 같은 칸의 "지금" 항목을 다시 읽어, 그사이 앞에 끼어든 다른 승인을 처리했다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTui } from '../../src/cli/tui.ts';

const approval = (id: string, label: string, over: Record<string, unknown> = {}) => ({
  id,
  kind: 'integrate_request',
  ticketId: null,
  summary: label,
  detail: {
    requestId: `Q-${id}`,
    text: label,
    changedPaths: ['a'],
    tickets: [],
    checks: [{ ticketId: 'T-1', id: 'R1', text: '본다' }],
    ...over,
  },
  state: 'pending',
  createdAt: '2026-10-08T00:00:00.000Z',
});

async function harness(t: { after: (fn: () => void | Promise<void>) => void }) {
  const state = {
    employees: [],
    projects: [],
    tickets: [],
    approvals: [approval('A-1', '첫 번째 요청')] as unknown[],
    runs: [],
    requests: [],
    ceoTodos: [],
    events: [],
    paused: false,
    delegation: { on: false },
  };
  const posts: string[] = [];
  const server = http.createServer((req, res) => {
    if (req.method === 'POST') posts.push(req.url ?? '');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.url === '/api/state' ? state : { ok: true }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const dataDir = mkdtempSync(join(tmpdir(), 'ac-tui-'));
  writeFileSync(join(dataDir, 'daemon.lock'), JSON.stringify({ pid: process.pid, url: `http://127.0.0.1:${port}/#token=t` }));
  const stdin = Object.assign(new EventEmitter(), {
    isTTY: true,
    setRawMode: () => stdin,
    setEncoding: () => stdin,
    pause: () => stdin,
  });
  const frames: string[] = [];
  const stdout = Object.assign(new EventEmitter(), {
    isTTY: true,
    columns: 100,
    rows: 30,
    write: (s: string) => (frames.push(s), true),
  });
  const done = runTui(dataDir, [], { stdin: stdin as never, stdout: stdout as never, refreshMs: 30, cwd: dataDir });
  const wait = (ms = 150) => new Promise((r) => setTimeout(r, ms));
  t.after(async () => {
    stdin.emit('data', 'q');
    await done;
    server.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  await wait();
  return { state, posts, frames, key: (k: string) => stdin.emit('data', k), wait };
}

test('승인 확인 중 다른 승인이 앞에 끼어들어도, 처음 고른 승인을 처리한다', async (t) => {
  const h = await harness(t);
  h.key('a'); // A-1에 직접 확인 항목이 있어 확인 단계로
  h.state.approvals = [approval('B-2', '새로 끼어든 요청'), approval('A-1', '첫 번째 요청')];
  await h.wait();
  h.key('y');
  await h.wait();
  assert.deepEqual(h.posts, ['/api/approvals/A-1/decide']);
});

test('끝나지 않은 업무가 있는 요청 결과물은 한 키로 승인되지 않고, 경고를 보여 준 뒤 y로만 승인한다', async (t) => {
  const h = await harness(t);
  h.state.approvals = [approval('C-3', '반쯤 끝난 요청', { checks: [], notDone: ['T-2 문서 (cancelled)'] })];
  await h.wait();
  assert.match(h.frames.at(-1)!, /⚠ 반쯤 끝난 요청/, '줄에 경고 표시');
  h.key('a');
  await h.wait();
  assert.deepEqual(h.posts, [], 'a만으로는 승인하지 않는다');
  assert.match(h.frames.at(-1)!, /끝나지 않은 업무 1개/);
  h.key('l'); // 직접 확인 항목이 없으니 "나중에"는 승인이 아니다
  await h.wait();
  assert.deepEqual(h.posts, []);
  h.key('a');
  h.key('y');
  await h.wait();
  assert.deepEqual(h.posts, ['/api/approvals/C-3/decide']);
});

test('반려 사유를 적는 사이 고른 승인이 사라지면 아무것도 보내지 않고 알린다', async (t) => {
  const h = await harness(t);
  h.key('r');
  h.state.approvals = [approval('B-2', '새로 끼어든 요청')];
  await h.wait();
  for (const ch of '문구 고쳐') h.key(ch);
  h.key('\r');
  await h.wait();
  assert.deepEqual(h.posts, []);
  assert.match(h.frames.at(-1)!, /목록이 바뀌어 취소/);
});

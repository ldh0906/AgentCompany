// 회사 도구 outbox: 요청마다 처리 기록을 DB에 먼저 남기고 효과를 낸다. 데몬이 중간에 꺼졌다 켜져도
// 같은 질문을 두 번 올리지 않고, 정해진 답은 다시 보내기만 한다(OpenRig 비교 2026-10-08).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { newImplTicket, setup, type Env } from './helpers.ts';
import { ticketChannelId } from '../../src/app/chat.ts';
import { companyToolsDir, writeToolRequest } from '../../src/approvals/company-tools.ts';

async function fixture(t: Parameters<typeof setup>[0]) {
  const env = await setup(t);
  const tk = newImplTicket(env);
  const [dev, qa] = [
    env.company.employees().find((e) => e.name === '구현 직원')!,
    env.company.employees().find((e) => e.name === 'QA 직원')!,
  ];
  const runDir = mkdtempSync(path.join(tmpdir(), 'ac-outbox-'));
  t.after(() => rmSync(runDir, { recursive: true, force: true, maxRetries: 15 }));
  const run = {
    id: 'R-tools',
    ticketId: tk.id,
    employeeId: dev.id,
    kind: 'work',
    status: 'running',
    nonce: 'nonce-1',
    runDir,
    startedAt: new Date().toISOString(),
  };
  env.orch.records.saveRun(run as never);
  const room = env.orch.chat.ensureTicketChannel(tk.id)!;
  if (!room.members.includes(qa.id)) env.orch.chat.addMembers(room.id, [qa.id]);
  const dir = companyToolsDir(runDir);
  const ask = () => writeToolRequest(dir, { tool: 'ask_colleague', args: { to: 'QA 직원', question: '기준이 뭔가요?' }, nonce: 'nonce-1' });
  const poll = () => (env.orch as unknown as { pollCompanyTools(): Promise<void> }).pollCompanyTools();
  const response = (id: string) =>
    readFile(path.join(dir, `${id}.response.json`), 'utf8').then(
      (x) => JSON.parse(x) as { ok: boolean; text: string },
      () => null,
    );
  const questions = () => env.orch.chat.messages(ticketChannelId(tk.id), 200).filter((m) => m.text === '@QA 직원 기준이 뭔가요?');
  return { env, tk, dev, qa, run, ask, poll, response, questions, key: (id: string) => `tool_call:${run.id}:${id}` };
}

const sending = (env: Env, key: string, at: string) => env.store.setSetting(key, JSON.stringify({ state: 'sending', at }));

test('질문을 올리고 꺼졌으면(답장 실행 전) 다시 올리지 않고 "묻지 못했다"고 답한다', { timeout: 60_000 }, async (t) => {
  const f = await fixture(t);
  const id = await f.ask();
  const at = new Date().toISOString();
  sending(f.env, f.key(id), at);
  f.env.orch.chat.post(ticketChannelId(f.tk.id), f.dev.id, '@QA 직원 기준이 뭔가요?', 'chat');
  await f.poll();
  assert.equal(f.questions().length, 1, '같은 질문을 또 올리지 않는다');
  assert.match((await f.response(id))!.text, /not asked: the system restarted/);
  assert.equal(JSON.parse(f.env.store.getSetting(f.key(id))!).state, 'answered');
  assert.ok(
    f.env.store.events(f.tk.id, 200).some((e) => e.type === 'tool.recovered' && (e.payload as { outcome: string }).outcome === 'answered'),
  );
});

test('질문도 답장 실행도 나갔으면 그 답을 기다려 돌려준다', { timeout: 60_000 }, async (t) => {
  const f = await fixture(t);
  const id = await f.ask();
  sending(f.env, f.key(id), new Date().toISOString());
  const q = f.env.orch.chat.post(ticketChannelId(f.tk.id), f.dev.id, '@QA 직원 기준이 뭔가요?', 'chat');
  const reply = {
    id: 'R-reply',
    ticketId: ticketChannelId(f.tk.id),
    employeeId: f.qa.id,
    kind: 'chat',
    status: 'running',
    startedAt: q.createdAt,
  };
  f.env.orch.records.saveRun(reply as never);
  await f.poll();
  assert.equal(f.questions().length, 1);
  assert.equal(await f.response(id), null, '아직 답이 없다');
  assert.equal(JSON.parse(f.env.store.getSetting(f.key(id))!).state, 'waiting');
  f.env.orch.chat.post(ticketChannelId(f.tk.id), f.qa.id, '테스트가 통과해야 합니다', 'chat', { runId: 'R-reply' });
  await f.poll();
  assert.equal((await f.response(id))!.text, 'QA 직원: 테스트가 통과해야 합니다');
});

test('아무것도 올리지 못하고 꺼졌으면 처음부터 한 번만 묻는다', { timeout: 60_000 }, async (t) => {
  const f = await fixture(t);
  const id = await f.ask();
  sending(f.env, f.key(id), new Date().toISOString());
  await f.poll();
  await f.poll();
  assert.equal(f.questions().length, 1);
  assert.notEqual(JSON.parse(f.env.store.getSetting(f.key(id))!).state, 'sending');
  await f.env.orch.idle();
});

test('답을 정해 두고 보내기 전에 꺼졌으면 같은 답을 다시 보내기만 한다', { timeout: 60_000 }, async (t) => {
  const f = await fixture(t);
  const id = await f.ask();
  f.env.store.setSetting(f.key(id), JSON.stringify({ state: 'answered', answer: { ok: true, text: '정해 둔 답' } }));
  await f.poll();
  assert.deepEqual(await f.response(id), { ok: true, text: '정해 둔 답' });
  assert.equal(f.questions().length, 0, '도구를 다시 실행하지 않는다');
});

test('예전 버전의 대기 기록(tool_pending:)도 이어서 기다리고, 실행이 끝나면 기록을 지운다', { timeout: 60_000 }, async (t) => {
  const f = await fixture(t);
  const id = await f.ask();
  const since = new Date().toISOString();
  f.env.store.setSetting(
    `tool_pending:${f.run.id}:${id}`,
    JSON.stringify({ roomId: ticketChannelId(f.tk.id), to: f.qa.id, name: 'QA 직원', since }),
  );
  await f.poll();
  assert.equal(f.questions().length, 0, '다시 묻지 않는다');
  assert.equal(await f.response(id), null);
  f.env.orch.records.saveRun({ ...f.run, status: 'succeeded' } as never);
  await f.poll();
  assert.deepEqual(f.env.store.settingKeys('tool_pending:'), []);
  assert.deepEqual(f.env.store.settingKeys('tool_call:'), []);
});

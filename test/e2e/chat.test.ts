// 사내 대화: 업무방 자동 기록, 대표 멘션·1:1 답장, 직원 간 연쇄 제한, 후속 업무, 작업 로그.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMentions, ticketChannelId, dmChannelId } from '../../src/app/chat.ts';
import { activityFrom } from '../../src/app/activity.ts';
import { parseChatReply } from '../../src/agents/report.ts';
import { driveUntil, newImplTicket, setup } from './helpers.ts';

const until = async (env: Awaited<ReturnType<typeof setup>>, cond: () => boolean, ms = 30_000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timeout');
    await env.orch.tick();
    await new Promise((r) => setTimeout(r, 50));
  }
  await env.orch.idle();
};

test('멘션 찾기: 공백 있는 이름, 긴 이름 먼저, @대표·@전체', () => {
  const emps = [
    { id: 'A', name: 'Codex 검수' },
    { id: 'B', name: 'Codex' },
    { id: 'C', name: 'Claude 팀장' },
  ];
  assert.deepEqual(parseMentions('@Codex 검수 봐 줘', emps, []).sort(), ['A']);
  assert.deepEqual(parseMentions('@Codex 와 @Claude 팀장', emps, []).sort(), ['B', 'C']);
  assert.deepEqual(parseMentions('@대표 확인 부탁', emps, []), ['ceo']);
  assert.deepEqual(parseMentions('@전체 공지', emps, ['ceo', 'A']).sort(), ['A', 'ceo']);
});

test('업무방: 작업 보고·검수 의견·진행 상황이 대화로 쌓인다(직원끼리의 대화를 대표가 본다)', { timeout: 120_000 }, async (t) => {
  const env = await setup(t);
  const tk = newImplTicket(env);
  await driveUntil(env, tk.id, (x) => x.status === 'awaiting_approval' || x.hold !== null);
  const msgs = env.orch.chat.messages(ticketChannelId(tk.id));
  const kinds = msgs.map((m) => m.kind);
  assert.ok(kinds.includes('report'), '작업 보고');
  assert.ok(kinds.includes('review'), '검수 의견');
  const t2 = env.company.requireTicket(tk.id);
  assert.equal(msgs.find((m) => m.kind === 'report')!.author, t2.assigneeId);
  assert.equal(msgs.find((m) => m.kind === 'review')!.author, t2.reviewerId);
  const ch = env.orch.chat.channel(ticketChannelId(tk.id))!;
  assert.ok(ch.members.includes('ceo') && ch.members.includes(t2.assigneeId!) && ch.members.includes(t2.reviewerId!));
});

test('대표가 멘션하면 그 직원이 답하고, 1:1 방에서는 늘 답한다', { timeout: 120_000 }, async (t) => {
  const env = await setup(t);
  const [impl, qa] = env.company.employees();
  const tk = newImplTicket(env);
  await driveUntil(env, tk.id, (x) => x.status === 'awaiting_approval' || x.hold !== null);
  await env.orch.ceoMessage(ticketChannelId(tk.id), `@${qa!.name} 테스트 범위 괜찮아?`);
  await until(env, () => env.orch.chat.messages(ticketChannelId(tk.id)).some((m) => m.author === qa!.id && m.kind === 'chat'));
  const dm = env.orch.chat.ensureDm(impl!.id);
  await env.orch.ceoMessage(dm.id, '오늘 한 일 요약해 줘');
  await until(env, () => env.orch.chat.messages(dmChannelId(impl!.id)).some((m) => m.author === impl!.id));
  assert.match(env.orch.chat.messages(dm.id).at(-1)!.text, /오늘 한 일/);
});

test('직원끼리 서로 부르는 연쇄는 깊이 제한에서 멈춘다(토큰 폭주 방지)', { timeout: 120_000 }, async (t) => {
  const env = await setup(t);
  const [impl, qa] = env.company.employees();
  const room = env.orch.chat.createGroup({ name: '핑퐁', members: [impl!.id, qa!.id], createdBy: 'ceo' });
  // 가짜 직원은 받은 말에 부를이름:"…" 이 있으면 그 사람을 부른다 → 되받는 말에도 들어 있어 계속 부른다.
  await env.orch.ceoMessage(room.id, `@${impl!.name} 부를이름:"${qa!.name}"`);
  await until(env, () => env.orch.chat.messages(room.id).some((m) => m.author === 'system' && /멈춥니다|stops/.test(m.text)), 60_000);
  const ai = env.orch.chat.messages(room.id).filter((m) => m.author !== 'ceo' && m.author !== 'system');
  assert.ok(ai.length >= 2 && ai.length <= 5, `AI 답장 ${ai.length}개`);
});

test('작업 보고의 후속 업무 제안은 업무방에 올라가고, 대표가 누르면 비서실장 요청이 된다', { timeout: 60_000 }, async (t) => {
  const env = await setup(t);
  env.company.hireEmployee({ name: '비서실장', roles: ['chief-of-staff'], cli: 'fake', model: 'diligent' });
  const tk = newImplTicket(env);
  const room = env.orch.chat.ensureTicketChannel(tk.id)!;
  const m = env.orch.chat.post(room.id, env.company.employees()[0]!.id, '후속 업무 제안: 맵 레벨대', 'followup', {
    followUp: { title: '맵 레벨대 조정', reason: '골렘이 안 나옴', projectId: env.projectId, ticketId: tk.id },
  });
  const req = await env.orch.followUpToRequest(m.id);
  assert.match(req.text, /맵 레벨대 조정/);
  assert.match(req.text, new RegExp(tk.id));
  await env.orch.idle();
});

test('대표가 업무방에 남긴 말은 다음 작업 지시에 들어간다', { timeout: 120_000 }, async (t) => {
  const env = await setup(t, { reviewer: 'picky' });
  const tk = newImplTicket(env);
  await driveUntil(env, tk.id, (x) => x.status === 'in_review');
  env.orch.chat.post(ticketChannelId(tk.id), 'ceo', '버전 문자열은 v 접두사를 붙여 줘', 'chat');
  await driveUntil(env, tk.id, (x) => x.round === 2 && x.status === 'in_progress');
  await env.orch.idle();
  const run = env.orch.records
    .runsForTicket(tk.id)
    .filter((r) => r.kind === 'work')
    .at(-1)!;
  const { readFileSync } = await import('node:fs');
  const prompt = readFileSync(`${run.runDir}/prompt.md`, 'utf8');
  assert.match(prompt, /v 접두사/);
});

test('대화 답장 읽기: JSON이 있으면 쓰고, 없으면 본문을 답으로', () => {
  const j = parseChatReply(
    '```json\n{"nonce":"n","kind":"chat","reply":"네","mentions":["@QA 직원"],"openRoom":{"name":"맵","members":["구현 직원"],"topic":"t","message":"m"}}\n```',
    'n',
  )!;
  assert.equal(j.reply, '네');
  assert.deepEqual(j.mentions, ['QA 직원']);
  assert.equal(j.openRoom?.name, '맵');
  assert.equal(parseChatReply('그냥 답합니다', 'n')!.reply, '그냥 답합니다');
  assert.equal(parseChatReply('', 'n'), null);
});

test('작업 로그: Claude·Codex 출력을 사람이 읽는 타임라인으로', () => {
  const items = activityFrom([
    {
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: '파일을 살펴봅니다' },
          { type: 'tool_use', name: 'Read', input: { file_path: 'src/a.ts' } },
        ],
      },
    },
    { type: 'user', message: { content: [{ type: 'tool_result', content: 'export const a = 1', is_error: false }] } },
    { type: 'item.completed', item: { type: 'command_execution', command: 'npm test', exit_code: 0, aggregated_output: 'ok' } },
    { type: 'item.completed', item: { type: 'file_change', changes: [{ path: 'src/b.ts', kind: 'update' }] } },
    { type: 'approval.auto', command: 'rm -rf /', allow: false },
    { type: 'steer.delivered', ok: true, text: '테스트부터' },
    { type: 'result', result: '끝', is_error: false },
  ]);
  assert.deepEqual(
    items.map((i) => i.kind),
    ['say', 'tool', 'output', 'command', 'file', 'approval', 'steer', 'done'],
  );
  assert.equal(items[1]!.text, 'Read: src/a.ts');
  assert.match(items[5]!.text, /⛔/);
});

test('API: 인코딩된 방 ID(t%3AT-1)로도 메시지를 읽는다', { timeout: 60_000 }, async (t) => {
  const env = await setup(t);
  const { Api } = await import('../../src/server/api.ts');
  const api = new Api(env.orch, env.dataDir);
  const tk = newImplTicket(env);
  const id = ticketChannelId(tk.id);
  const msgs = (await api.handle('GET', `/api/channels/${encodeURIComponent(id)}/messages`, new URLSearchParams(), undefined)) as unknown[];
  assert.ok(msgs.length >= 1, '업무 생성 기록이 보인다');
  await api.handle('POST', `/api/channels/${encodeURIComponent(id)}/messages`, new URLSearchParams(), { text: '메모' });
  assert.ok(env.orch.chat.messages(id).some((m) => m.text === '메모'));
});

test('그룹 방에서 이 업무(T-번호)를 두고 합의한 대화는 담당자의 작업 지시에 들어간다', { timeout: 120_000 }, async (t) => {
  const env = await setup(t);
  const [impl, qa] = env.company.employees();
  const tk = newImplTicket(env);
  const room = env.orch.chat.createGroup({ name: '설계 싱크', members: [impl!.id, qa!.id], createdBy: 'ceo' });
  env.orch.chat.post(room.id, qa!.id, `${tk.id}는 버전 앞에 v를 붙이기로 합의`, 'chat');
  await driveUntil(
    env,
    tk.id,
    (x) => x.status !== 'backlog' && x.status !== 'assigned' && x.status !== 'received' && x.status !== 'analyzing',
  );
  await env.orch.idle();
  const run = env.orch.records.runsForTicket(tk.id).find((r) => r.kind === 'work')!;
  const { readFileSync } = await import('node:fs');
  assert.match(readFileSync(`${run.runDir}/prompt.md`, 'utf8'), /설계 싱크.*v를 붙이기로 합의/);
});

test('회사 전체 일시정지: 새 작업을 시작하지 않고, 풀면 다시 진행한다', { timeout: 120_000 }, async (t) => {
  const env = await setup(t);
  env.orch.setPaused(true);
  assert.equal(env.orch.paused, true);
  const tk = newImplTicket(env);
  for (let i = 0; i < 8; i++) await env.orch.tick();
  await env.orch.idle();
  assert.equal(env.orch.records.runsForTicket(tk.id).filter((r) => r.kind === 'work').length, 0, '멈춘 동안 작업 실행 없음');
  assert.ok(
    env.orch.chat.messages('general').some((m) => /일시정지/.test(m.text)),
    '전체방에 알림',
  );
  env.orch.setPaused(false);
  const done = await driveUntil(env, tk.id, (x) => x.status === 'awaiting_approval' || x.hold !== null);
  assert.equal(done.status, 'awaiting_approval');
});

test('업무 하나 멈춤: 대표 보류가 되고, 보류 해제로 재개한다', { timeout: 120_000 }, async (t) => {
  const env = await setup(t);
  env.orch.setPaused(true);
  const tk = newImplTicket(env);
  for (let i = 0; i < 4; i++) await env.orch.tick();
  const p = env.orch.pauseTicket(tk.id);
  assert.equal(p.hold?.reason, 'on_hold');
  env.orch.setPaused(false);
  for (let i = 0; i < 4; i++) await env.orch.tick();
  await env.orch.idle();
  assert.equal(env.orch.records.runsForTicket(tk.id).length, 0, '멈춘 업무는 시작하지 않음');
  env.orch.releaseHold(tk.id);
  const done = await driveUntil(env, tk.id, (x) => x.status === 'awaiting_approval' || x.hold !== null);
  assert.equal(done.status, 'awaiting_approval');
});

test(
  '대화로 프로필 바꾸기: 직원이 프로필 변경을 제안하면 대표 할 일에 뜨고, 반영하면 프로젝트 프로필이 바뀐다',
  { timeout: 120_000 },
  async (t) => {
    const env = await setup(t);
    const [impl] = env.company.employees();
    const dm = env.orch.chat.ensureDm(impl!.id);
    await env.orch.ceoMessage(dm.id, '이거 휴대폰에서도 돼야 해');
    await until(env, () => env.orch.profileProposal(env.projectId) !== null);
    assert.deepEqual(env.orch.profileProposal(env.projectId)!.profile, {
      summary: '웹 앱(휴대폰 대응)',
      mobile: true,
      game: false,
      deliverable: 'screen',
    });
    assert.ok(
      env.orch.desk.ceoTodos().some((x) => x.link === '/projects'),
      '대표 할 일에 뜬다',
    );
    assert.ok(env.orch.chat.messages(dm.id).some((m) => /프로필 변경을 제안/.test(m.text)));
    const p = env.orch.resolveProfileProposal(env.projectId, true);
    assert.equal(p.profile?.mobile, true);
    assert.equal(env.orch.profileProposal(env.projectId), null, '반영하면 제안은 사라진다');
    assert.ok(!env.orch.desk.ceoTodos().some((x) => x.link === '/projects'));
    // 같은 프로필을 다시 제안하면 무시한다
    await env.orch.ceoMessage(dm.id, '다시 말하지만 휴대폰에서도 돼야 해');
    await until(env, () => env.orch.chat.messages(dm.id).filter((m) => m.author === impl!.id).length >= 2);
    assert.equal(env.orch.profileProposal(env.projectId), null);
  },
);

test('대화 답장 읽기: 프로필 제안이 없거나 틀리면 null', () => {
  assert.equal(parseChatReply('```json\n{"nonce":"n","kind":"chat","reply":"네","profile":{"summary":""}}\n```', 'n')!.profile, null);
  assert.equal(parseChatReply('```json\n{"nonce":"n","kind":"chat","reply":"네"}\n```', 'n')!.profile, null);
});

// 반영 충돌: 내 폴더에 합치려는데 그사이 다른 변경과 겹치면 완료로 치지 않고 담당자에게 돌려보낸다.
// 다음 작업 때 최신 기준을 업무 폴더에 합쳐 주고, 직원이 충돌을 정리하면 다시 반영된다.
// 실측(2026-10-01, 물 마시기): 충돌로 "따로 보관"되고도 완료 처리되어, 코드가 내 폴더에 없는데 뒤 업무가 시작했다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { AGENT_IDENTITY, git } from '../../src/workspace/git.ts';
import { driveUntil, newImplTicket, setup, statusIs } from './helpers.ts';

test('반영 충돌은 담당자에게 돌아가고, 최신 기준을 합쳐 정리한 뒤 내 폴더에 들어간다', { timeout: 240_000 }, async (t) => {
  const env = await setup(t, { integrationMode: 'auto_after_approval' });
  const tk = newImplTicket(env);
  await driveUntil(env, tk.id, statusIs('awaiting_approval'), 120_000);

  // 승인 직전에 다른 변경이 같은 파일을 먼저 만든다(다른 업무가 먼저 반영된 상황)
  const file = path.join(env.origin, 'src', 'agent-company-demo', `${tk.id}.md`);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, '# 다른 업무가 먼저 넣은 내용\n');
  await git(['add', '-A'], env.origin);
  await git([...AGENT_IDENTITY, 'commit', '-q', '-m', 'other ticket'], env.origin);

  const a = env.orch.records.pendingApprovalFor(tk.id, 'integrate')!;
  env.orch.decideIntegration(a.id, 'approved');
  const back = await driveUntil(env, tk.id, (x) => x.status === 'changes_requested' || x.status === 'done' || x.hold !== null, 60_000);
  assert.equal(back.status, 'changes_requested', '충돌은 완료가 아니다');
  const ev = env.company.store
    .events(tk.id)
    .filter((e) => e.type === 'ticket.changes_requested')
    .at(-1)!;
  assert.match(String((ev.payload as { reason: string }).reason), /겹쳤습니다[\s\S]*충돌 표시/);

  // 다시 일하면서 최신 기준을 합쳐 정리 → 다시 승인 → 내 폴더에 양쪽 내용이 다 들어간다
  await driveUntil(env, tk.id, statusIs('awaiting_approval'), 120_000);
  assert.ok(env.company.store.events(tk.id).some((e) => e.type === 'ticket.caught_up'));
  const a2 = env.orch.records.pendingApprovalFor(tk.id, 'integrate')!;
  env.orch.decideIntegration(a2.id, 'approved');
  await driveUntil(env, tk.id, statusIs('done'), 60_000);
  const merged = readFileSync(file, 'utf8');
  assert.match(merged, /다른 업무가 먼저 넣은 내용/);
  assert.match(merged, new RegExp(`${tk.id} round`));
  assert.doesNotMatch(merged, /<<<<<<<|>>>>>>>/);
});

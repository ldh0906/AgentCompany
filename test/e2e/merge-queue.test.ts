// 반영 대기열: 넓힌 쓰기 범위도 잠가 같은 파일은 차례로 쓰고, 먼저 반영된 업무와 충돌할 업무는 대표 확인 전에 돌려보낸다.
// 실측(2026-10-01, 물 마시기): 넓혀 준 tests/index.js가 잠기지 않아 두 업무가 같은 파일을 만들었고, 반영 때 충돌했다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AGENT_IDENTITY, git } from '../../src/workspace/git.ts';
import { projectPaths } from '../../src/workspace/workspace.ts';
import { driveUntil, newImplTicket, setup, statusIs } from './helpers.ts';

test('넓힌 쓰기 범위도 잠근다: 같은 파일을 쓰려는 다른 업무는 차례를 기다린다', async (t) => {
  const env = await setup(t);
  const mk = (scope: string[]) =>
    env.company.createTicket({
      projectId: env.projectId,
      type: 'impl',
      title: scope.join(','),
      purpose: 'x',
      requirements: [{ text: 'x', evidenceType: 'unit_test' }],
      doneCriteria: 'x',
      writeScope: scope,
    });
  const a = mk(['src/a/**']);
  const b = mk(['src/b/**', 'tests/index.js']);
  assert.ok(env.orch.records.acquireLocks(a, [a, b]).ok);
  const wider = env.company.extendWriteScope(a.id, ['tests/index.js']);
  assert.ok(env.orch.records.acquireLocks(wider, [wider, b]).ok, '자기 잠금은 다시 잡아도 된다');
  const r = env.orch.records.acquireLocks(b, [wider, b]);
  assert.equal(r.ok, false, '넓힌 범위의 파일도 잠겨 있다');
  if (!r.ok) assert.equal(r.conflictWith, a.id);
});

test('먼저 반영된 업무와 충돌할 업무는 대표가 확인하기 전에 돌려보내고, 승인 요청은 무효로 한다', { timeout: 180_000 }, async (t) => {
  const env = await setup(t);
  const tk = newImplTicket(env);
  await driveUntil(env, tk.id, statusIs('awaiting_approval'), 120_000);
  const pending = env.orch.records.pendingApprovalFor(tk.id, 'integrate')!;

  // 다른 업무가 같은 파일을 먼저 반영한 기준을 미러에 만든다
  const paths = projectPaths(env.dataDir, env.projectId);
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'ac-mq-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const wt = path.join(tmp, 'wt');
  await git(['worktree', 'add', '--detach', wt, 'refs/heads/main'], paths.mirror);
  mkdirSync(path.join(wt, 'src', 'agent-company-demo'), { recursive: true });
  writeFileSync(path.join(wt, 'src', 'agent-company-demo', `${tk.id}.md`), '# 다른 업무가 먼저\n');
  await git(['add', '-A'], wt);
  await git([...AGENT_IDENTITY, 'commit', '-q', '-m', 'other'], wt);
  const base = (await git(['rev-parse', 'HEAD'], wt)).stdout.trim();
  await git(['worktree', 'remove', '--force', wt], paths.mirror);

  await (
    env.orch as unknown as { recheckWaiting: (p: unknown, pp: unknown, id: string, base: string, branch: string) => Promise<void> }
  ).recheckWaiting(env.company.requireProject(env.projectId), paths, 'T-99', base, 'main');

  const back = env.company.requireTicket(tk.id);
  assert.equal(back.status, 'changes_requested', '대표 확인 전에 돌려보낸다');
  assert.equal(env.orch.records.approval(pending.id)!.state, 'expired', '기다리던 승인 요청은 무효');
  const ev = env.company.store
    .events(tk.id)
    .filter((e) => e.type === 'ticket.changes_requested')
    .at(-1)!;
  assert.match(String((ev.payload as { reason: string }).reason), /T-99가 먼저[\s\S]*agent-company-demo/);
  assert.equal(env.company.store.getSetting(`catch_up:${tk.id}`), '1', '다음 작업 때 최신 기준을 합쳐 준다');
});

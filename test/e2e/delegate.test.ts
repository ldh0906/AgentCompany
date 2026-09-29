// 권한 요청 위임: 전체 자동(4) 직원이 있으면 그 직원이 대표 대신 처리한다. 치명적인 것만 막는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { createApprovalRequest } from '../../src/approvals/file-queue.ts';
import { setup } from './helpers.ts';
import type { RunRecord } from '../../src/app/records.ts';

type Env = Awaited<ReturnType<typeof setup>>;

function fakeRunningRun(env: Env, employeeId: string): RunRecord {
  const runDir = path.join(env.dataDir, 'runs', 'R-delegate');
  const approvalDir = path.join(runDir, 'approvals');
  mkdirSync(approvalDir, { recursive: true });
  const run = {
    id: 'R-delegate',
    ticketId: 'T-1',
    employeeId,
    kind: 'work',
    nonce: 'n',
    status: 'running',
    pid: null,
    cliSessionId: null,
    runDir,
    exitCode: null,
    failureClass: null,
    startedAt: new Date().toISOString(),
    endedAt: null,
    round: 1,
    cli: 'claude',
    processStartMs: null,
    approvalDir,
    worktreePath: path.join(env.dataDir, 'wt', 'T-1'),
  } as unknown as RunRecord;
  env.orch.records.saveRun(run);
  return run;
}

const decision = (dir: string, id: string) =>
  existsSync(path.join(dir, `${id}.decision.json`)) ? JSON.parse(readFileSync(path.join(dir, `${id}.decision.json`), 'utf8')) : null;
const poll = (env: Env) => (env.orch as unknown as { pollToolApprovals: () => Promise<void> }).pollToolApprovals();

test('전체 자동 직원이 있으면 권한 요청을 대신 처리: 일반 명령 허용, 치명적 명령 차단', { timeout: 60_000 }, async (t) => {
  const env = await setup(t);
  const [impl] = env.company.employees();
  const lead = env.company.hireEmployee({
    name: '팀장',
    roles: ['planner'],
    cli: 'fake',
    model: 'diligent',
    rank: 'lead',
    accessLevel: 'read-only',
  });
  env.company.setAccessLevel(lead.id, 'full-auto', { kind: 'ceo' });
  const run = fakeRunningRun(env, impl!.id);
  const safe = await createApprovalRequest(run.approvalDir!, {
    source: 'claude',
    kind: 'PowerShell',
    detail: { tool_name: 'PowerShell', input: { command: 'git ls-files | Select-Object -First 80' } },
  });
  const bad = await createApprovalRequest(run.approvalDir!, {
    source: 'claude',
    kind: 'PowerShell',
    detail: { tool_name: 'PowerShell', input: { command: 'Remove-Item -Recurse -Force C:\\' } },
  });
  await poll(env);
  assert.equal(decision(run.approvalDir!, safe.id)?.decision, 'allow');
  assert.equal(decision(run.approvalDir!, bad.id)?.decision, 'deny');
  const approvals = env.orch.records.approvals().filter((a) => a.kind === 'tool_permission');
  assert.equal(approvals.length, 2);
  assert.ok(
    approvals.every((a) => a.state !== 'pending'),
    '대표에게 남는 요청 없음',
  );
  const events = env.store.events(undefined, 50).filter((e) => e.type === 'approval.delegated');
  assert.equal(events.length, 2);
  assert.ok(
    events.every((e) => e.actor === lead.id),
    '처리자는 전체 자동 직원',
  );
  assert.ok(events.some((e) => (e.payload as { allow: boolean }).allow === false));
});

test('전체 자동 직원이 없으면 지금처럼 대표에게, 생기면 대기 중이던 요청도 처리', { timeout: 60_000 }, async (t) => {
  const env = await setup(t);
  const [impl] = env.company.employees();
  const run = fakeRunningRun(env, impl!.id);
  const req = await createApprovalRequest(run.approvalDir!, {
    source: 'codex',
    kind: 'command',
    detail: { command: 'npm test', cwd: '.' },
  });
  await poll(env);
  assert.equal(decision(run.approvalDir!, req.id), null, '대표 결정을 기다린다');
  assert.equal(env.orch.records.approvals('pending').length, 1);
  const lead = env.company.hireEmployee({
    name: '팀장',
    roles: ['planner'],
    cli: 'fake',
    model: 'diligent',
    rank: 'lead',
    accessLevel: 'read-only',
  });
  env.company.setAccessLevel(lead.id, 'full-auto', { kind: 'ceo' });
  await poll(env);
  assert.equal(decision(run.approvalDir!, req.id)?.decision, 'allow');
  assert.equal(env.orch.records.approvals('pending').length, 0);
});

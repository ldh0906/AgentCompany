// 공유 계약: 요청의 첫 업무가 이름·타입·값을 고정하면, 같은 요청의 다른 업무는 그 파일을 그대로 쓴다(대표 요청 2026-10-08:
// "ai 여러개가 작업했지만 하나의 결과물, 고정된 값을 내게 만드는게 중요해").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { driveUntil, setup, statusIs } from './helpers.ts';

test(
  '계약 업무가 끝나면 그 파일은 같은 요청의 다른 업무에 고정: 지시에 들어가고, 고치면 격리되며 대표만 허락할 수 있다',
  { timeout: 300_000 },
  async (t) => {
    const env = await setup(t, { implementer: 'contract-breaker' });
    env.company.hireEmployee({ name: '비서실장', roles: ['chief-of-staff'], cli: 'fake', model: 'diligent' });
    const req = await env.orch.submitRequest(env.projectId, '파티 해산 기능');
    await env.orch.idle();
    const drafts = env.orch.records.request(req.id)!.drafts.map((d, i) =>
      // 뒤 업무도 src/**를 쓴다: 계약 파일이 쓰기 범위 안이어도 고정인지 본다
      i === 0 ? { ...d, contract: true } : { ...d, type: 'impl' as const, writeScope: ['src/**'] },
    );
    const [contract, doc] = env.orch.acceptRequest(req.id, drafts);
    assert.equal(env.orch.records.request(req.id)!.contractTicketId, contract!.id);
    assert.ok(doc!.dependsOn.includes(contract!.id), '다른 업무는 계약 업무를 기다린다');

    // 계약 업무 자신은 계약 파일을 자유롭게 만든다(계약 블록 없음)
    await driveUntil(env, contract!.id, statusIs('done'), 150_000);
    const held = await driveUntil(env, doc!.id, (x) => x.hold?.reason === 'needs_permission' || x.status === 'done', 150_000);
    // 뒤 업무의 지시에 계약 파일이 내용째 들어간다
    const run = env.orch.records.runsForTicket(doc!.id).find((r) => r.kind === 'work')!;
    const prompt = await readFile(path.join(run.runDir, 'prompt.md'), 'utf8');
    assert.match(prompt, /Shared contract/);
    assert.match(prompt, /--- src\/agent-company-demo\/T-1\.md ---/);
    // 계약 파일을 고치면 격리되고 대표 허락을 기다린다
    assert.equal(held.hold?.reason, 'needs_permission', `상태: ${held.status}`);
    assert.match(held.hold!.note, /계약:src\/agent-company-demo\/T-1\.md/);
    // 위임받은 직원은 계약 변경을 허락할 수 없다
    assert.throws(() => env.orch.resolveScopeHold(doc!.id, true, 'delegate'), /계약/);
    // 대표가 허락하면 그 제출물에 한해 계속 진행한다
    env.orch.resolveScopeHold(doc!.id, true);
    const done = await driveUntil(
      env,
      doc!.id,
      (x) => x.status === 'done' || (x.hold !== null && x.hold.reason !== 'waiting_dependency'),
      150_000,
    );
    assert.equal(done.status, 'done', `보류: ${done.hold?.note}`);
  },
);

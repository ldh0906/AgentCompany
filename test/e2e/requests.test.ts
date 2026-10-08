import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { gitOut, git } from '../../src/workspace/git.ts';
import { Orchestrator } from '../../src/app/orchestrator.ts';
import { driveUntil, setup, statusIs } from './helpers.ts';

test(
  '대표 요청 → 초안 확정 → 업무들이 요청 브랜치에 쌓임(원본 그대로) → 요청 전체를 한 번 승인 → 원본에 결과물 하나',
  { timeout: 300_000 },
  async (t) => {
    const env = await setup(t);
    env.company.hireEmployee({ name: '비서실장', roles: ['chief-of-staff', 'recorder'], cli: 'fake', model: 'diligent' });
    const req = await env.orch.submitRequest(env.projectId, '파티 해산 기능');
    await env.orch.idle();
    const drafted = env.orch.records.request(req.id)!;
    assert.equal(drafted.status, 'drafted', drafted.error ?? '');
    assert.equal(drafted.drafts.length, 2);
    assert.equal(env.company.tickets().length, 0, '초안 단계에서는 티켓이 만들어지지 않음');

    const mainBefore = await gitOut(['rev-parse', 'main'], env.origin);
    const [impl, doc] = env.orch.acceptRequest(req.id);
    assert.deepEqual(doc!.dependsOn, [impl!.id]);
    assert.equal(doc!.requesterId, 'ceo', '티켓은 대표 명의');
    assert.equal(env.orch.records.request(req.id)!.branch, `ac/${req.id}`);

    // 업무마다 대표 승인 없이: 검수를 통과하면 요청 브랜치(미러)에 합쳐지고 완료된다. 선행 업무가 끝나야 뒤 업무가 시작한다.
    await driveUntil(env, impl!.id, statusIs('done'), 150_000);
    // 뒤 업무는 앞 업무의 결과 위에서 시작한다(요청 브랜치에서 출발)
    const d = await driveUntil(
      env,
      doc!.id,
      (x) => x.status === 'done' || (x.hold !== null && x.hold.reason !== 'waiting_dependency'),
      150_000,
    );
    assert.equal(d.status, 'done', `보류: ${d.hold?.note}`);
    const docRun = env.orch.records.runsForTicket(doc!.id).find((r) => r.kind === 'work')!;
    const docWt = await git(['ls-files'], docRun.worktreePath);
    assert.match(docWt.stdout, /src\/agent-company-demo\/T-1\.md/, '뒤 업무 폴더에 앞 업무의 파일이 있다');

    // 원본은 아직 그대로: 업무 브랜치도, 기준 브랜치 변화도 없다
    assert.equal(await gitOut(['rev-parse', 'main'], env.origin), mainBefore);
    assert.equal((await git(['branch', '--list', 'ac/*'], env.origin)).stdout.trim(), '');

    // 업무가 모두 끝나면(인수 시험까지) 요청 전체 승인이 하나 생긴다
    const pendingRequest = () => env.orch.records.approvals('pending').find((a) => a.kind === 'integrate_request');
    const deadline = Date.now() + 120_000;
    while (!pendingRequest() && Date.now() < deadline) {
      await env.orch.tick();
      await new Promise((r) => setTimeout(r, 50));
    }
    const a = pendingRequest();
    assert.ok(a, '요청 전체 승인 요청');
    const detail = a!.detail as { changedPaths: string[]; tickets: { id: string }[] };
    // 인수 시험이 만든 고칠 업무도 같은 요청 브랜치에 들어간다
    assert.ok(
      detail.changedPaths.includes('src/agent-company-demo/T-1.md') && detail.changedPaths.includes('docs/agent-company-demo/T-2.md'),
    );
    assert.equal(env.orch.records.approvals('pending').filter((x) => x.kind === 'integrate').length, 0, '업무별 승인은 남지 않는다');

    await env.orch.decideRequest(a!.id, 'approved');
    await env.orch.idle();
    const after = env.orch.records.request(req.id)!;
    assert.ok(after.integration, '요청 결과물 반영 기록');
    // 원본에는 결과물 하나(브랜치 ac/<요청 ID>)에 두 업무가 모두 들어 있다. manual이라 main은 그대로.
    const files = await gitOut(['ls-tree', '-r', '--name-only', `ac/${req.id}`], env.origin);
    assert.match(files, /src\/agent-company-demo\/T-1\.md/);
    assert.match(files, /docs\/agent-company-demo\/T-2\.md/);
    assert.equal(await gitOut(['rev-parse', 'main'], env.origin), mainBefore);
    assert.equal(env.orch.records.approval(a!.id)!.state, 'consumed');
    assert.equal(env.store.verifyEventChain().ok, true);
  },
);

test('요청 결과물 반려 → 대표가 적은 이유로 고칠 업무 → 끝나면 새 요청 승인', { timeout: 300_000 }, async (t) => {
  const env = await setup(t);
  env.company.hireEmployee({ name: '비서실장', roles: ['chief-of-staff'], cli: 'fake', model: 'diligent' });
  const req = await env.orch.submitRequest(env.projectId, '파티 해산 기능');
  await env.orch.idle();
  env.orch.acceptRequest(req.id);
  const pendingRequest = () => env.orch.records.approvals('pending').find((a) => a.kind === 'integrate_request');
  const waitFor = async (ok: () => boolean) => {
    const deadline = Date.now() + 240_000;
    while (!ok()) {
      if (Date.now() > deadline)
        throw new Error(
          `시간 초과: ${env.company
            .tickets()
            .map((x) => `${x.id} ${x.status} ${x.hold ? `${x.hold.reason}: ${x.hold.note.slice(0, 120)}` : ''}`)
            .join(' | ')} / 인수 ${JSON.stringify(env.orch.records.request(req.id)?.acceptanceRounds?.map((r) => r.state))}`,
        );
      await env.orch.tick();
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  await waitFor(() => Boolean(pendingRequest()));
  const first = pendingRequest()!;
  await assert.rejects(env.orch.decideRequest(first.id, 'rejected', { reason: '  ' }), /고쳐야/);
  await env.orch.decideRequest(first.id, 'rejected', { reason: '해산 버튼 문구를 바꿔 주세요' });
  const ids = env.orch.records.request(req.id)!.ticketIds;
  const fix = env.company.requireTicket(ids.at(-1)!);
  assert.match(fix.title, /대표 반려/);
  await waitFor(() => Boolean(pendingRequest()));
  assert.notEqual(pendingRequest()!.id, first.id, '고친 뒤 새 승인 요청');
  assert.equal(env.company.requireTicket(fix.id).status, 'done');
});

test('초안 난이도: 비서실장이 제안하고, 대표가 확정 전에 바꿀 수 있음', { timeout: 120_000 }, async (t) => {
  const env = await setup(t);
  env.company.hireEmployee({ name: '비서실장', roles: ['chief-of-staff', 'recorder'], cli: 'fake', model: 'diligent' });
  const req = await env.orch.submitRequest(env.projectId, '파티 해산 기능');
  await env.orch.idle();
  const drafted = env.orch.records.request(req.id)!;
  assert.deepEqual(
    drafted.drafts.map((d) => d.difficulty),
    ['normal', 'easy'],
    '비서실장이 초안마다 난이도를 제안',
  );
  // 대표가 첫 초안을 쉬움으로 바꾸고, 잘못된 값은 보통으로 정리된다
  const edited = drafted.drafts.map((d, i) => ({ ...d, difficulty: i === 0 ? 'easy' : 'extreme' })) as typeof drafted.drafts;
  const [a, b] = env.orch.acceptRequest(req.id, edited);
  assert.equal(a!.difficulty, 'easy');
  assert.equal(b!.difficulty, 'normal');
});

test('비서실장이 없으면 요청을 거부하고 직접 업무를 만들라고 안내', { timeout: 60_000 }, async (t) => {
  const env = await setup(t);
  await assert.rejects(env.orch.submitRequest(env.projectId, 'x'), /비서실장/);
});

test('초안 작성 중인 요청을 버리면 비서실장 실행을 끊고, 끝난 실행이 요청을 되살리지 않는다', { timeout: 60_000 }, async (t) => {
  const env = await setup(t);
  env.company.hireEmployee({ name: '비서실장', roles: ['chief-of-staff'], cli: 'fake', model: 'slow' });
  const req = await env.orch.submitRequest(env.projectId, '파티 해산 기능');
  const run = env.orch.records.runsForTicket(req.id).find((r) => r.status === 'running');
  assert.ok(run, '초안 실행이 돌고 있다');
  // 프로세스가 pid를 남길 때까지 잠깐 기다린다
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && !existsSync(join(run.runDir, 'pid.json'))) await new Promise((r) => setTimeout(r, 100));
  await env.orch.stopRun(run.id);
  await env.orch.idle();
  const after = env.orch.records.request(req.id)!;
  assert.equal(after.status, 'dismissed');
  assert.equal(after.drafts.length, 0, '초안이 붙지 않는다');
  assert.notEqual(env.orch.records.run(run.id)!.status, 'running');
});

test('초안은 비서실장·기획 중 한가한 사람에게: 비서실장이 쓰는 중이면 기획 직원이 받는다', { timeout: 60_000 }, async (t) => {
  const env = await setup(t);
  const chief = env.company.hireEmployee({ name: '비서실장', roles: ['chief-of-staff'], cli: 'fake', model: 'slow', rank: 'lead' });
  const planner = env.company.hireEmployee({ name: '기획', roles: ['planner'], cli: 'fake', model: 'diligent' });
  const a = await env.orch.submitRequest(env.projectId, '파티 해산 기능');
  const b = await env.orch.submitRequest(env.projectId, '길드 채팅');
  assert.equal(a.employeeId, chief.id, '한가하면 비서실장이 먼저');
  assert.equal(b.employeeId, planner.id, '비서실장이 바쁘면 기획 직원');
  await env.orch.idle();
});

test('열린 일 모두 정리: 끝나지 않은 업무는 취소, 초안은 버리고, 끝난 업무는 그대로', { timeout: 120_000 }, async (t) => {
  const env = await setup(t);
  env.company.hireEmployee({ name: '비서실장', roles: ['chief-of-staff'], cli: 'fake', model: 'slow' });
  const mk = (title: string, dir: string) =>
    env.company.createTicket({
      projectId: env.projectId,
      type: 'impl',
      title,
      purpose: 'p',
      requirements: [{ text: 'r', evidenceType: 'inspection' }],
      doneCriteria: 'd',
      writeScope: [`${dir}/**`],
    });
  const done = mk('끝난 일', 'a');
  await driveUntil(env, done.id, (x) => x.status === 'awaiting_approval');
  env.orch.decideIntegration(env.orch.records.pendingApprovalFor(done.id, 'integrate')!.id, 'approved');
  await driveUntil(env, done.id, statusIs('done'));
  const open1 = mk('진행 중인 일', 'b');
  const open2 = mk('아직 안 한 일', 'c');
  await env.orch.tick();
  const req = await env.orch.submitRequest(env.projectId, '새 기능');
  const r = await env.orch.clearOpenWork();
  await env.orch.idle();
  assert.deepEqual(r, { tickets: 2, requests: 1 });
  assert.equal(env.company.requireTicket(open1.id).status, 'cancelled');
  assert.equal(env.company.requireTicket(open2.id).status, 'cancelled');
  assert.equal(env.company.requireTicket(done.id).status, 'done', '끝난 업무는 그대로');
  assert.equal(env.orch.records.request(req.id)!.status, 'dismissed');
  assert.ok(!env.orch.records.runsByStatus('running').some((x) => [open1.id, open2.id, req.id].includes(x.ticketId)), '돌던 실행은 끊긴다');
});

test(
  '요청 결과물 승인(auto_after_approval): 원본 main에 한 번에 병합되고 합친 결과로 검사를 다시 돈다',
  { timeout: 300_000 },
  async (t) => {
    const env = await setup(t, { integrationMode: 'auto_after_approval' });
    env.company.hireEmployee({ name: '비서실장', roles: ['chief-of-staff'], cli: 'fake', model: 'diligent' });
    const req = await env.orch.submitRequest(env.projectId, '파티 해산 기능');
    await env.orch.idle();
    env.orch.acceptRequest(req.id);
    const pendingRequest = () => env.orch.records.approvals('pending').find((a) => a.kind === 'integrate_request');
    const deadline = Date.now() + 240_000;
    while (!pendingRequest()) {
      if (Date.now() > deadline)
        throw new Error(
          `시간 초과: ${env.company
            .tickets()
            .map((x) => `${x.id} ${x.status} ${x.hold ? `${x.hold.reason}: ${x.hold.note.slice(0, 120)}` : ''}`)
            .join(' | ')} / 인수 ${JSON.stringify(env.orch.records.request(req.id)?.acceptanceRounds?.map((r) => r.state))}`,
        );
      await env.orch.tick();
      await new Promise((r) => setTimeout(r, 50));
    }
    const mainBefore = await gitOut(['rev-parse', 'main'], env.origin);
    await env.orch.decideRequest(pendingRequest()!.id, 'approved');
    await env.orch.idle();
    const result = env.orch.records.request(req.id)!.integration!.result as { kind: string };
    assert.equal(result.kind, 'merged');
    assert.notEqual(await gitOut(['rev-parse', 'main'], env.origin), mainBefore);
    const files = await gitOut(['ls-tree', '-r', '--name-only', 'main'], env.origin);
    assert.match(files, /src\/agent-company-demo\/T-1\.md/);
    assert.match(files, /docs\/agent-company-demo\/T-2\.md/);
  },
);

test('요청 승인 직후 데몬이 꺼져 반영 기록이 없으면, 다시 켰을 때 그 승인으로 이어서 반영한다', { timeout: 300_000 }, async (t) => {
  const env = await setup(t);
  env.company.hireEmployee({ name: '비서실장', roles: ['chief-of-staff'], cli: 'fake', model: 'diligent' });
  const req = await env.orch.submitRequest(env.projectId, '파티 해산 기능');
  await env.orch.idle();
  env.orch.acceptRequest(req.id);
  const pendingRequest = () => env.orch.records.approvals('pending').find((a) => a.kind === 'integrate_request');
  const deadline = Date.now() + 240_000;
  while (!pendingRequest()) {
    if (Date.now() > deadline)
      throw new Error(
        `시간 초과: ${env.company
          .tickets()
          .map((x) => `${x.id} ${x.status} ${x.hold ? `${x.hold.reason}: ${x.hold.note.slice(0, 120)}` : ''}`)
          .join(' | ')} / 인수 ${JSON.stringify(env.orch.records.request(req.id)?.acceptanceRounds?.map((r) => r.state))}`,
      );
    await env.orch.tick();
    await new Promise((r) => setTimeout(r, 50));
  }
  const a = pendingRequest()!;
  // 승인은 저장됐지만 반영을 시작하기 전에 꺼진 상태(반영 중인 작업 없음): 데몬을 멈추고 같은 DB로 새로 켠다
  env.orch.records.setApprovalState(a.id, 'approved', 'ceo', { mode: 'manual' });
  await env.orch.stop();
  await env.orch.idle();
  const again = new Orchestrator(env.company, { dataDir: env.dataDir, language: 'ko', screenCheck: false });
  t.after(async () => {
    await again.stop();
    await again.idle();
  });
  await again.recover();
  while (!again.records.request(req.id)!.integration) {
    if (Date.now() > deadline) throw new Error('이어서 반영하지 않음');
    await again.tick();
    await new Promise((r) => setTimeout(r, 50));
  }
  await again.idle();
  assert.equal(again.records.approval(a.id)!.state, 'consumed');
  assert.match(await gitOut(['ls-tree', '-r', '--name-only', `ac/${req.id}`], env.origin), /T-1\.md/);
  assert.equal(again.records.approvals().filter((x) => x.kind === 'integrate_request').length, 1, '새 승인을 또 만들지 않는다');
});

test('요청 승인 카드: 취소된 업무는 "끝나지 않은 업무"로, 인수 시험은 요청에 정한 수를 기준으로 센다', { timeout: 300_000 }, async (t) => {
  const env = await setup(t);
  env.company.hireEmployee({ name: '비서실장', roles: ['chief-of-staff'], cli: 'fake', model: 'diligent' });
  const req = await env.orch.submitRequest(env.projectId, '파티 해산 기능');
  await env.orch.idle();
  // 검수 통과하면 자동 반영인 프로젝트라도, 끝나지 않은 업무가 있으면 대표가 직접 본다
  env.company.updateProject(env.projectId, { autoApprove: true });
  const [, doc] = env.orch.acceptRequest(req.id);
  env.orch.cancel(doc!.id, '이번에는 문서 생략');
  const pendingRequest = () => env.orch.records.approvals('pending').find((a) => a.kind === 'integrate_request');
  const deadline = Date.now() + 240_000;
  while (!pendingRequest()) {
    if (Date.now() > deadline)
      throw new Error(
        `시간 초과: ${env.company
          .tickets()
          .map((x) => `${x.id} ${x.status} ${x.hold ? `${x.hold.reason}: ${x.hold.note.slice(0, 120)}` : ''}`)
          .join(' | ')} / 인수 ${JSON.stringify(env.orch.records.request(req.id)?.acceptanceRounds?.map((r) => r.state))}`,
      );
    await env.orch.tick();
    await new Promise((r) => setTimeout(r, 50));
  }
  const d = pendingRequest()!.detail as { notDone: string[]; acceptance: { total: number } | null };
  assert.equal(d.notDone.length, 1);
  assert.match(d.notDone[0]!, new RegExp(`${doc!.id} .*cancelled`));
  if (d.acceptance) assert.equal(d.acceptance.total, env.orch.records.request(req.id)!.acceptance!.length);
  for (let i = 0; i < 5; i++) await env.orch.tick();
  await env.orch.idle();
  assert.ok(pendingRequest(), '자동으로 승인하지 않고 기다린다');
  assert.equal(env.orch.records.request(req.id)!.integration ?? null, null);
});

test(
  '작업 흐름: 비서실장이 단계대로 초안을 내면 필수 요구사항·순서가 들어가고, 단계를 빼먹으면 거부된다',
  { timeout: 120_000 },
  async (t) => {
    const env = await setup(t);
    const chief = env.company.hireEmployee({ name: '비서실장', roles: ['chief-of-staff'], cli: 'fake', model: 'diligent' });
    await assert.rejects(env.orch.submitRequest(env.projectId, 'x', 'deploy'), /알 수 없는 작업 흐름/);

    const req = await env.orch.submitRequest(env.projectId, '정산 모듈 정리', 'refactor');
    await env.orch.idle();
    const drafted = env.orch.records.request(req.id)!;
    assert.equal(drafted.status, 'drafted', drafted.error ?? '');
    assert.equal(drafted.formula, 'refactor');
    assert.deepEqual(
      drafted.drafts.map((d) => d.step),
      ['pin', 'reshape'],
    );
    assert.deepEqual(drafted.drafts[1]!.dependsOn, [0], '구조 개선은 동작 고정 뒤에');
    assert.ok(
      drafted.drafts[0]!.requirements.some((r) => r.text.includes('지금 동작을 확인하는 테스트') && r.evidenceType === 'unit_test'),
    );
    const run = env.orch.records.runsForTicket(req.id).find((r) => r.kind === 'analysis')!;
    const { readFile } = await import('node:fs/promises');
    assert.match(await readFile(join(run.runDir, 'prompt.md'), 'utf8'), /Workflow formula: 리팩터링/);

    // 단계를 빼먹은 초안은 거부(실패한 요청으로 남고 이유가 보인다)
    env.company.setEmployeeActive(chief.id, false);
    env.company.hireEmployee({ name: '건너뛰는 비서실장', roles: ['chief-of-staff'], cli: 'fake', model: 'flowskipper' });
    const bad = await env.orch.submitRequest(env.projectId, '정산 모듈 정리', 'refactor');
    await env.orch.idle();
    const failed = env.orch.records.request(bad.id)!;
    assert.equal(failed.status, 'failed');
    assert.match(failed.error ?? '', /작업 흐름 "리팩터링"을 따르지 않았습니다/);
  },
);

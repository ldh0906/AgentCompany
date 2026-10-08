// ac 명령: 데몬(같은 API)에 붙어 up → ask → approve 한 바퀴. 대표 요청(2026-10-08): CLI로 쉽게쉽게.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/store/db.ts';
import { Company } from '../../src/app/company.ts';
import { Orchestrator } from '../../src/app/orchestrator.ts';
import { Api } from '../../src/server/api.ts';
import { startServer } from '../../src/server/http.ts';
import { runAc } from '../../src/cli/ac.ts';
import { parseTeam } from '../../src/cli/teams.ts';
import { gitOut } from '../../src/workspace/git.ts';
import { makeOrigin } from './helpers.ts';

test('ac up --fake → ac ask --yes → ac approve: 요청 결과물이 원본에 하나로 들어간다', { timeout: 300_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ac-cli-'));
  const dataDir = join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
  const origin = await makeOrigin(root);
  const store = new Store(join(root, 'c.db'));
  const company = new Company(store);
  const orch = new Orchestrator(company, { dataDir, language: 'ko', screenCheck: false });
  const server = await startServer({ api: new Api(orch, dataDir), port: 0, webRoot: null });
  // ac는 daemon.lock의 주소·토큰으로 붙는다(데몬을 새로 띄우지 않게 이 프로세스를 데몬으로 적는다)
  writeFileSync(join(dataDir, 'daemon.lock'), JSON.stringify({ pid: process.pid, url: server.url, startedAt: new Date().toISOString() }));
  orch.start(200);
  const logs: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => void logs.push(a.map(String).join(' '));
  t.after(async () => {
    console.log = log;
    await orch.stop();
    await orch.idle();
    await server.close();
    store.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });
  const ac = async (cmd: Parameters<typeof runAc>[0], ...args: string[]) => {
    process.exitCode = 0;
    await runAc(cmd, args, dataDir);
    assert.equal(process.exitCode, 0, logs.slice(-5).join('\n'));
  };

  await ac('up', '--fake', '--path', origin);
  const project = company.projects()[0]!;
  assert.equal(project.originPath.toLowerCase(), origin.toLowerCase());
  assert.deepEqual(
    company.employees().map((e) => [e.name, e.cli, e.rank]),
    [
      ['리드', 'fake', 'lead'],
      ['구현', 'fake', 'senior'],
    ],
  );
  // 이 저장소에는 검사 명령이 없다: 단위 테스트 증거가 나오게 하나 둔다
  company.updateProject(project.id, {
    verifyCommands: [{ label: 'unit tests', argv: ['node', '-e', 'process.exit(0)'], evidenceType: 'unit_test' }],
  });
  // 팀이 있으면 다시 고용하지 않는다
  await ac('up', 'workshop', '--path', origin);
  assert.equal(company.employees().length, 2);

  await ac('ask', '--yes', '파티 해산 기능');
  const req = orch.records.requests()[0]!;
  assert.equal(req.status, 'accepted');
  assert.ok(
    logs.some((l) => l.includes('구현: 파티 해산 기능')),
    '초안을 보여 준다',
  );

  await ac('ps');
  const deadline = Date.now() + 240_000;
  while (!orch.records.approvals('pending').some((a) => a.kind === 'integrate_request')) {
    if (Date.now() > deadline)
      throw new Error(
        `시간 초과: ${company
          .tickets()
          .map((x) => `${x.id} ${x.status}`)
          .join(', ')}`,
      );
    await new Promise((r) => setTimeout(r, 200));
  }
  await ac('approve');
  while (!orch.records.request(req.id)!.integration) {
    if (Date.now() > deadline) throw new Error('반영 시간 초과');
    await new Promise((r) => setTimeout(r, 200));
  }
  const files = await gitOut(['ls-tree', '-r', '--name-only', `ac/${req.id}`], origin);
  assert.match(files, /src\/agent-company-demo\/T-1\.md/);

  // 지금 팀을 파일로 → 다시 읽으면 같은 자리
  const file = join(root, 'team.yaml');
  await ac('team', 'export', file);
  assert.deepEqual(
    parseTeam(readFileSync(file, 'utf8'), file).seats.map((s) => [s.name, s.cli]),
    [
      ['리드', 'fake'],
      ['구현', 'fake'],
    ],
  );
});

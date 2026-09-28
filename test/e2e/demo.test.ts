// 데모는 대표가 아무것도 누르지 않아도 네 직원의 행동(성실·게으름·범위 위반·검토)을 모두 보여줘야 한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/store/db.ts';
import { Company } from '../../src/app/company.ts';
import { Orchestrator } from '../../src/app/orchestrator.ts';
import { seedDemo } from '../../src/cli/demo.ts';
import { scopesOverlap } from '../../src/workspace/workspace.ts';

test('데모 업무들의 쓰기 범위는 겹치지 않음 (승인 전에도 범위 위반 직원이 실행됨)', { timeout: 30_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ac-demo-'));
  const store = new Store(join(root, 'company.db'));
  const company = new Company(store);
  const orch = new Orchestrator(company, { dataDir: join(root, 'data'), language: 'en' });
  t.after(async () => {
    await orch.stop();
    await orch.idle();
    store.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });
  await seedDemo(company, orch, join(root, 'data'), 'en');
  const scoped = company.tickets().filter((x) => x.writeScope.length > 0);
  assert.ok(scoped.length >= 3);
  for (const a of scoped)
    for (const b of scoped) if (a.id < b.id) assert.equal(scopesOverlap(a.writeScope, b.writeScope), false, `${a.id} ↔ ${b.id}`);
});

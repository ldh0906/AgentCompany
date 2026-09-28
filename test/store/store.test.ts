import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/store/db.ts';
import { Company, DomainError } from '../../src/app/company.ts';

// Windows는 열린 DB 파일이 있는 폴더를 지울 수 없으므로, 등록된 저장소를 먼저 닫고 폴더를 지운다.
function tempDb(t: { after: (fn: () => void) => void }): { path: string; open: () => Store } {
  const dir = mkdtempSync(join(tmpdir(), 'ac-store-'));
  const opened: Store[] = [];
  t.after(() => {
    for (const s of opened) {
      try {
        s.close();
      } catch {
        /* 이미 닫힘 */
      }
    }
    rmSync(dir, { recursive: true, force: true });
  });
  const path = join(dir, 'company.db');
  return {
    path,
    open: () => {
      const s = new Store(path);
      opened.push(s);
      return s;
    },
  };
}

test('이벤트 해시 체인: 정상 검증과 수정·삭제 탐지', (t) => {
  const store = tempDb(t).open();
  for (let i = 0; i < 5; i++) store.appendEvent('ceo', 'x', `E${i}`, { i, 한글: '값' });
  assert.deepEqual(store.verifyEventChain(), { ok: true, count: 5 });

  store.db.prepare('UPDATE events SET payload = \'{"i":99}\' WHERE seq = 3').run();
  const tampered = store.verifyEventChain();
  assert.equal(tampered.ok, false);
  if (!tampered.ok) assert.equal(tampered.brokenAt, 3);
});

test('이벤트 삭제도 탐지', (t) => {
  const store = tempDb(t).open();
  for (let i = 0; i < 4; i++) store.appendEvent('ceo', 'x', 'E', { i });
  store.db.prepare('DELETE FROM events WHERE seq = 2').run();
  const r = store.verifyEventChain();
  assert.equal(r.ok, false);
});

test('트랜잭션 실패 시 상태와 이벤트 모두 롤백', (t) => {
  const store = tempDb(t).open();
  const company = new Company(store);
  const p = company.registerProject({ name: 'demo', originPath: 'C:/demo' });
  const ticket = company.createTicket({
    projectId: p.id,
    type: 'impl',
    title: 't',
    purpose: 'p',
    requirements: [{ text: 'r', evidenceType: 'unit_test' }],
    doneCriteria: 'd',
    writeScope: ['src/**'],
  });
  const before = store.events().length;
  assert.throws(() => company.applyTicket(ticket.id, { type: 'ceo_approve' }, { kind: 'ceo' }), DomainError);
  assert.equal(store.events().length, before);
  assert.equal(company.requireTicket(ticket.id).status, 'received');
});

test('활성 직원 최대 4명, 비활성화 후 추가 가능', (t) => {
  const store = tempDb(t).open();
  const company = new Company(store);
  const hired = [1, 2, 3, 4].map((n) =>
    company.hireEmployee({ name: `직원${n}`, roles: ['implementer'], cli: 'codex', model: 'gpt-6-astra' }),
  );
  assert.throws(() => company.hireEmployee({ name: '다섯째', roles: ['qa'], cli: 'claude', model: null }), /최대 4명/);
  company.setEmployeeActive(hired[0]!.id, false);
  const fifth = company.hireEmployee({ name: '다섯째', roles: ['qa'], cli: 'claude', model: null });
  assert.equal(fifth.active, true);
  assert.throws(() => company.setEmployeeActive(hired[0]!.id, true), /최대 4명/);
});

test('직원은 직접 고용하거나 티켓을 만들 수 없음, 전체 자동 등급은 바로 부여 불가', (t) => {
  const store = tempDb(t).open();
  const company = new Company(store);
  const p = company.registerProject({ name: 'demo', originPath: 'C:/demo' });
  assert.throws(() => company.hireEmployee({ name: 'x', roles: ['qa'], cli: 'codex', model: null }, { kind: 'employee', id: 'E-1' }));
  assert.throws(() => company.hireEmployee({ name: 'x', roles: ['qa'], cli: 'codex', model: null, accessLevel: 'full-auto' }), /전체 자동/);
  assert.throws(() =>
    company.createTicket(
      { projectId: p.id, type: 'doc', title: 't', purpose: 'p', requirements: [], doneCriteria: '' },
      { kind: 'employee', id: 'E-1' },
    ),
  );
});

test('재시작(저장소 다시 열기) 후 티켓·직원·이벤트 유지, 체인 유효', (t) => {
  const db = tempDb(t);
  const s1 = db.open();
  const c1 = new Company(s1);
  const p = c1.registerProject({ name: 'demo', originPath: 'C:/demo' });
  const a = c1.hireEmployee({ name: '구현', roles: ['implementer'], cli: 'codex', model: null });
  const b = c1.hireEmployee({ name: '검수', roles: ['qa'], cli: 'claude', model: null });
  const tk = c1.createTicket({
    projectId: p.id,
    type: 'impl',
    title: '기능',
    purpose: 'p',
    requirements: [{ text: 'r', evidenceType: 'unit_test' }],
    doneCriteria: 'd',
    writeScope: ['src/**'],
  });
  c1.applyTicket(tk.id, { type: 'analyze' }, { kind: 'orchestrator' });
  c1.applyTicket(tk.id, { type: 'accept_to_backlog' }, { kind: 'orchestrator' });
  c1.applyTicket(tk.id, { type: 'assign', assigneeId: a.id, reviewerId: b.id, activeEmployeeIds: [a.id, b.id] }, { kind: 'orchestrator' });
  s1.close();

  const s2 = db.open();
  const c2 = new Company(s2);
  const reloaded = c2.requireTicket(tk.id);
  assert.equal(reloaded.status, 'assigned');
  assert.equal(reloaded.assigneeId, a.id);
  assert.equal(c2.activeEmployees().length, 2);
  assert.equal(s2.verifyEventChain().ok, true);
  assert.equal(
    c2.createTicket({
      projectId: p.id,
      type: 'doc',
      title: '둘째',
      purpose: '',
      requirements: [{ text: 'x', evidenceType: 'human_attest' }],
      doneCriteria: 'd',
    }).id,
    'T-2',
  );
});

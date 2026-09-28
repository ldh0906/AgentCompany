import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/store/db.ts';
import { Company } from '../../src/app/company.ts';
import { Orchestrator } from '../../src/app/orchestrator.ts';
import { Api } from '../../src/server/api.ts';
import { startServer } from '../../src/server/http.ts';
import { makeOrigin } from '../e2e/helpers.ts';

function raw(
  port: number,
  opts: { path: string; host?: string; headers?: Record<string, string>; method?: string; body?: string },
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: opts.path,
        method: opts.method ?? 'GET',
        headers: { host: opts.host ?? `127.0.0.1:${port}`, ...opts.headers },
      },
      (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

test('서버: 토큰·Host·Origin 검사와 API 흐름', { timeout: 60_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ac-srv-'));
  const store = new Store(join(root, 'c.db'));
  const orch = new Orchestrator(new Company(store), { dataDir: join(root, 'data') });
  const server = await startServer({ api: new Api(orch, join(root, 'data')), port: 0, webRoot: null });
  t.after(async () => {
    await server.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const auth = { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' };

  assert.equal((await raw(server.port, { path: '/api/state' })).status, 401, '토큰 없으면 거부');
  assert.equal((await raw(server.port, { path: '/api/state', headers: { authorization: 'Bearer wrong' } })).status, 401);
  assert.equal((await raw(server.port, { path: '/api/state', host: 'evil.example:80', headers: auth })).status, 421, 'DNS 리바인딩 차단');
  assert.equal(
    (await raw(server.port, { path: '/api/state', headers: { ...auth, origin: 'https://evil.example' } })).status,
    403,
    '다른 출처 차단',
  );
  assert.equal((await raw(server.port, { path: '/api/state', headers: auth })).status, 200);

  const origin = await makeOrigin(root);
  const post = (path: string, body: unknown) => raw(server.port, { path, method: 'POST', headers: auth, body: JSON.stringify(body) });
  const p = JSON.parse(
    (
      await post('/api/projects', {
        name: 'demo',
        originPath: origin,
        verifyCommands: [{ label: 'ok', argv: ['node', '-e', '0'], evidenceType: 'unit_test' }],
      })
    ).body,
  );
  assert.ok(p.id);
  const e1 = await post('/api/employees', { name: '구현', roles: ['implementer'], cli: 'fake', model: 'diligent' });
  assert.equal(e1.status, 200);
  const bad = await post('/api/employees', { name: 'x', roles: ['qa'], cli: 'agy', model: null, accessLevel: 'write-ask' });
  assert.equal(bad.status, 400, 'Antigravity는 실행 중 승인 중계 수단이 없어 write-ask 거부');
  assert.match(JSON.parse(bad.body).error, /지원하지 않습니다/);
  const tk = await post('/api/tickets', {
    projectId: p.id,
    type: 'impl',
    title: '기능',
    requirements: [{ text: 'r', evidenceType: 'unit_test' }],
    doneCriteria: 'd',
    writeScope: ['src/**'],
  });
  assert.equal(tk.status, 200);
  const invalid = await post('/api/tickets', { projectId: p.id, title: '요구사항 없음', requirements: [], doneCriteria: 'd' });
  assert.equal(invalid.status, 400);
  const detail = await raw(server.port, { path: `/api/tickets/${JSON.parse(tk.body).id}`, headers: auth });
  assert.equal(JSON.parse(detail.body).ticket.status, 'received');
  const conflict = await post(`/api/tickets/${JSON.parse(tk.body).id}/cancel`, {});
  assert.equal(conflict.status, 200);
});

// 실행 로그·작업 기록 API는 비밀값을 가린 뒤 내보낸다(원본 로그 파일은 그대로)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { newImplTicket, setup } from './helpers.ts';
import { Api } from '../../src/server/api.ts';

test('로그·작업 기록·보고서의 비밀값과 데몬 접속 토큰은 [REDACTED]로 나간다', { timeout: 60_000 }, async (t) => {
  const env = await setup(t);
  const tk = newImplTicket(env);
  const runDir = mkdtempSync(path.join(tmpdir(), 'ac-redact-'));
  t.after(() => rmSync(runDir, { recursive: true, force: true, maxRetries: 15 }));
  const daemonToken = 'Zq7_daemon-token-value-1234';
  env.store.setSetting('server_token', daemonToken);
  const key = `sk-ant-api03-${'x'.repeat(30)}`;
  const lines = [
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'a', name: 'Bash', input: { command: 'cat .env' } }] } },
    {
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'a', content: `ANTHROPIC_API_KEY=${key}\nURL=#token=${daemonToken}` }] },
    },
    { type: 'result', result: `끝. 키는 ${key}`, is_error: false },
  ];
  writeFileSync(path.join(runDir, 'stdout.log'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  env.orch.records.saveRun({
    id: 'R-secret',
    ticketId: tk.id,
    employeeId: env.company.employees()[0]!.id,
    kind: 'work',
    status: 'succeeded',
    runDir,
    startedAt: new Date().toISOString(),
    finalText: `끝. 키는 ${key}`,
    report: { summary: `password: hunter2hunter2 그리고 ${key}` },
    reportError: null,
    summary: '',
  } as never);
  const api = new Api(env.orch, env.dataDir);
  const get = (p: string) => api.handle('GET', `/api/${p}`, new URLSearchParams(), undefined);
  const log = JSON.stringify(await get('runs/R-secret/log'));
  const activity = JSON.stringify(await get('runs/R-secret/activity'));
  for (const body of [log, activity]) {
    assert.ok(!body.includes(key), '키가 나가지 않는다');
    assert.ok(!body.includes(daemonToken), '데몬 접속 토큰이 나가지 않는다');
    assert.match(body, /\[REDACTED\]/);
  }
  assert.ok(!log.includes('hunter2hunter2'), '보고서 안쪽 값도');
  assert.match(activity, /cat \.env/, '나머지 내용은 그대로');
  assert.ok(readFileSync(path.join(runDir, 'stdout.log'), 'utf8').includes(key), '원본 로그 파일은 건드리지 않는다');
});

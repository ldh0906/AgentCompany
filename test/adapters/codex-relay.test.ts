import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isAllowlisted } from '../../src/adapters/codex-relay.ts';
import { writeDecision } from '../../src/approvals/file-queue.ts';

const here = path.dirname(fileURLToPath(import.meta.url));

test('허용 목록: 접두사가 맞고 셸 메타문자가 없을 때만 자동 승인', () => {
  const list = [
    ['npm', 'test'],
    ['git', 'status'],
  ];
  assert.equal(isAllowlisted('npm test', list), true);
  assert.equal(isAllowlisted('npm test -- --watch', list), true);
  assert.equal(isAllowlisted(['git', 'status'], list), true);
  assert.equal(isAllowlisted('npm test && rm -rf /', list), false, '명령 연결 차단');
  assert.equal(isAllowlisted('npm test; curl evil', list), false);
  assert.equal(isAllowlisted('npm test $(whoami)', list), false);
  assert.equal(isAllowlisted('npm install', list), false);
  assert.equal(isAllowlisted('npmtest', list), false);
});

test('Codex 중계: 허용 목록 명령은 자동 승인, 나머지는 파일 큐로 대표에게, exec 형식으로 출력', { timeout: 30_000 }, async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ac-relay-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const child = spawn(process.execPath, ['--no-warnings', path.join(here, '..', '..', 'src', 'adapters', 'codex-relay.ts')], {
    env: {
      ...process.env,
      AC_CODEX_BIN: process.execPath,
      AC_CODEX_ARGS: JSON.stringify(['--no-warnings', path.join(here, 'fake-appserver.ts')]),
      AC_CODEX_CWD: dir,
      AC_APPROVAL_DIR: dir,
      AC_ALLOWED_COMMANDS: JSON.stringify([['npm', 'test']]),
    },
    stdio: ['pipe', 'pipe', 'inherit'],
    windowsHide: true,
  });
  child.stdin.end('프롬프트');
  let stdout = '';
  child.stdout.on('data', (d) => (stdout += d));
  // 대표 역할: 큐에 올라온 요청을 거부
  const answered = new Set<string>();
  const requests: { kind: string; detail: any }[] = [];
  const poll = setInterval(async () => {
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.request.json'))) {
      const id = f.replace('.request.json', '');
      if (answered.has(id)) continue;
      answered.add(id);
      requests.push(JSON.parse(readFileSync(path.join(dir, f), 'utf8')));
      await writeDecision(dir, id, { decision: 'deny' });
    }
  }, 50);
  const code = await new Promise<number | null>((r) => child.once('close', r));
  clearInterval(poll);
  const events = stdout
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  assert.equal(code, 0);
  assert.ok(events.some((e) => e.type === 'thread.started' && e.thread_id === 'thread-1'));
  assert.ok(
    events.some((e) => e.type === 'approval.auto' && e.command === 'npm test'),
    'npm test 자동 승인',
  );
  assert.ok(
    events.some((e) => e.type === 'approval.decided' && e.decision === 'deny'),
    'rm -rf 는 대표에게 물어 거부',
  );
  assert.equal(answered.size, 2, '대표에게는 rm -rf 와 파일 변경 두 건만 올라옴');
  const fileReq = requests.find((r) => r.kind === 'fileChange');
  assert.deepEqual(fileReq?.detail.files, [{ path: 'src/party.js', kind: 'update' }], '어떤 파일을 바꾸는지 대표가 볼 수 있음');
  assert.match(fileReq?.detail.diff ?? '', /export const x/);
  assert.ok(events.some((e) => e.type === 'item.completed' && e.item?.type === 'agent_message'));
});

// CLI 옵션 점검: 도움말에서 우리가 쓰는 옵션을 찾고, 이번 실행이 실제로 쓰는 것만 막는다(OpenRig 비교 2026-10-08)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { helpHas, lacksFor, probeCli } from '../../src/app/cli-caps.ts';

const HELP = `Usage: claude [options]
  -p, --print                 Print response and exit
  --output-format <format>    Output format
  --model <model>             Model
  --allowedTools, --allowed-tools <tools...>
  --resume [value]            Resume`;

test('도움말의 옵션은 경계까지 보고 찾는다(-p가 --print 안에서 잡히지 않게)', () => {
  for (const t of ['-p', '--print', '--output-format', '--model', '--allowedTools', '--resume']) assert.ok(helpHas(HELP, t), t);
  assert.ok(!helpHas(HELP, '--effort'));
  assert.ok(!helpHas('  --print   x', '-p'), '--print만 있으면 -p는 없다');
  assert.ok(!helpHas(HELP, '--allowed'), '앞부분만 같은 옵션은 아니다');
  assert.ok(helpHas('Commands:\n  app-server   [experimental] Run', 'app-server'));
});

test('이번 실행이 쓰는 옵션만 막고, 하위 명령은 늘 필요하다', () => {
  const caps = { missing: ['--effort', '--print', 'app-server'] };
  assert.deepEqual(lacksFor({ missing: ['--effort'] }, ['-p', '--model', 'x']), [], 'effort를 안 쓰면 상관없다');
  assert.deepEqual(lacksFor(caps, ['--effort', 'high', '--print=hi']), ['--effort', '--print', 'app-server']);
  assert.deepEqual(lacksFor({ missing: [] }, ['--anything']), []);
});

test('실제 실행 파일로 확인: 빠진 옵션을 찾고, 도움말을 못 읽으면 막지 않는다', async () => {
  const node = { file: process.execPath, argsPrefix: [] };
  const help = (text: string) => ['-e', `process.stdout.write(${JSON.stringify(text)})`];
  const ok = await probeCli(
    { helpChecks: [{ args: help('  --model <m>\n  --resume'), tokens: ['--model', '--resume', '--effort'] }] },
    node,
    process.env,
    'k',
  );
  assert.equal(ok.version, process.version);
  assert.deepEqual(ok.missing, ['--effort']);
  assert.equal(ok.key, 'k');
  const silent = await probeCli({ helpChecks: [{ args: ['-e', 'process.exit(3)'], tokens: ['--model'] }] }, node, process.env, 'k');
  assert.deepEqual(silent.missing, []);
  assert.match(silent.error ?? '', /exit 3/);
});

test('도움말이라는 근거가 없으면 막지 않는다: 안내만 찍고 끝나거나 멈춰 끊긴 경우(QA)', async () => {
  const node = { file: process.execPath, argsPrefix: [] };
  const tokens = ['--model', '--resume'];
  const notice = await probeCli(
    { helpChecks: [{ args: ['-e', 'console.log("A new version is available")'], tokens }] },
    node,
    process.env,
    'k',
  );
  assert.deepEqual(notice.missing, []);
  assert.match(notice.error ?? '', /no help text/);
  // 하나만 확인하는 하위 명령도, 도움말 모양이면 빠진 것으로 본다(Codex app-server)
  const codex = await probeCli(
    { helpChecks: [{ args: ['-e', 'console.log("Usage: codex [OPTIONS]\\nCommands:\\n  exec")'], tokens: ['app-server'] }] },
    node,
    process.env,
    'k',
  );
  assert.deepEqual(codex.missing, ['app-server']);
});

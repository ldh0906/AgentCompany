// 확인용 실행(화면 없는 프로그램): 직원이 남긴 명령을 좁은 모양만 받아 돌리고 출력을 남긴다(대표 요청 2026-10-01).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  demoCommandsOf,
  demoOutputFiles,
  demoRefusal,
  demoResultLine,
  fileTimes,
  mentionedFiles,
  runDemos,
} from '../../src/app/demo-run.ts';
import { locateExecutable } from '../../src/runner/locate.ts';
import { AGENT_IDENTITY, git } from '../../src/workspace/git.ts';

test('보고서의 demoCommands: 형식이 틀린 항목은 버리고, 모르는 요구사항은 *', () => {
  assert.deepEqual(
    demoCommandsOf(
      [
        { requirementId: 'R1', argv: ['python', 'demo.py'], label: '요청과 응답' },
        { requirementId: 'R9', argv: ['node', 'cli.js', '--help'] },
        { argv: [] },
        { argv: 'python demo.py' },
      ],
      ['R1', 'R2'],
    ),
    [
      { requirementId: 'R1', argv: ['python', 'demo.py'], label: '요청과 응답' },
      { requirementId: '*', argv: ['node', 'cli.js', '--help'], label: '' },
    ],
  );
  assert.deepEqual(demoCommandsOf(null, []), []);
});

test('허용 모양: python/py/node + 프로젝트 안 파일, python -m 모듈. 셸·인라인 코드·밖 파일은 거절', (t) => {
  const d = mkdtempSync(path.join(tmpdir(), 'ac-demo-'));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  writeFileSync(path.join(d, 'demo.py'), '');
  mkdirSync(path.join(d, 'tools'));
  writeFileSync(path.join(d, 'tools', 'cli.js'), '');
  assert.equal(demoRefusal(['python', 'demo.py'], d), null);
  assert.equal(demoRefusal(['node', 'tools/cli.js', '--x'], d), null);
  assert.equal(demoRefusal(['python', '-m', 'app.main'], d), null);
  for (const bad of [
    ['powershell', '-c', 'dir'],
    ['cmd', '/c', 'dir'],
    ['python', '-c', 'print(1)'],
    ['node', '-e', '1'],
    ['python', '../outside.py'],
    ['python', 'missing.py'],
    ['python', 'tools'],
    ['node', '-m', 'x'],
    ['python', '-m', 'os;rm'],
  ])
    assert.ok(demoRefusal(bad, d), bad.join(' '));
});

test('돌리기: 출력·종료 코드·거절 이유, 파이썬 한글 출력도 깨지지 않게', { timeout: 60_000 }, async (t) => {
  const d = mkdtempSync(path.join(tmpdir(), 'ac-demo-'));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  writeFileSync(path.join(d, 'ok.js'), 'console.log("GET /items -> 200 [사과]"); process.exit(0);');
  writeFileSync(path.join(d, 'fail.js'), 'console.error("boom"); process.exit(3);');
  writeFileSync(path.join(d, 'hello.py'), 'print("안녕하세요 — 요청 1개 처리")\n');
  const hasPython = Boolean((await locateExecutable('python'))?.launch);
  const r = await runDemos(
    [
      { requirementId: 'R1', argv: ['node', 'ok.js'], label: '목록' },
      { requirementId: 'R1', argv: ['node', 'fail.js'], label: '' },
      { requirementId: 'R2', argv: ['cmd', '/c', 'dir'], label: '' },
      ...(hasPython ? [{ requirementId: 'R3', argv: ['python', 'hello.py'], label: '' }] : []),
    ],
    d,
    path.join(d, '.runs'),
    20_000,
  );
  assert.match(r[0]!.output, /GET \/items -> 200 \[사과\]/);
  assert.equal(r[0]!.exitCode, 0);
  assert.equal(demoResultLine(r[0]!), '정상 종료(0)');
  assert.equal(r[1]!.exitCode, 3);
  assert.match(r[1]!.errors, /boom/);
  assert.ok(r[2]!.skipped);
  assert.match(demoResultLine(r[2]!), /^돌리지 않음/);
  if (hasPython) assert.match(r[3]!.output, /안녕하세요 — 요청 1개 처리/);
});

test('확인용 실행이 만든 파일: 새로 생기거나 바뀐 문서·표만, CSV는 엑셀 한글 판정, node_modules 등은 무시', async (t) => {
  const d = mkdtempSync(path.join(tmpdir(), 'ac-demo-'));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  writeFileSync(path.join(d, 'old.md'), '# 그대로');
  writeFileSync(path.join(d, 'report.md'), '# 이전');
  mkdirSync(path.join(d, 'node_modules'));
  const before = fileTimes(d);
  await new Promise((r) => setTimeout(r, 20));
  mkdirSync(path.join(d, 'out'));
  writeFileSync(
    path.join(d, 'out', 'summary.csv'),
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('월,합계\n2026-01,57000\n')]),
  );
  writeFileSync(path.join(d, 'out', 'nobom.csv'), '월,합계\n');
  writeFileSync(path.join(d, 'report.md'), '# 새 보고서');
  writeFileSync(path.join(d, 'node_modules', 'x.md'), 'ignored');
  writeFileSync(path.join(d, 'out', 'data.bin'), 'x');
  const files = await demoOutputFiles(d, before);
  assert.deepEqual(
    files.map((f) => [f.path, f.status]),
    [
      ['out/nobom.csv', 'added'],
      ['out/summary.csv', 'added'],
      ['report.md', 'modified'],
    ],
  );
  assert.match(files[1]!.verdict ?? '', /BOM 있음/);
  assert.match(files[0]!.verdict ?? '', /^⚠/);
  assert.equal(files[1]!.text, '월,합계\n2026-01,57000\n');
});

test('출력에 적힌 파일 경로(상대·전체·따옴표)도 결과물로 잡는다: 같은 내용으로 다시 써서 바뀌지 않아도', async (t) => {
  const d = mkdtempSync(path.join(tmpdir(), 'ac-demo-'));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  mkdirSync(path.join(d, 'out'));
  writeFileSync(path.join(d, 'out', 'summary.csv'), '월,합계\n');
  writeFileSync(path.join(d, 'notes.md'), '# n');
  const full = path.join(d, 'out', 'summary.csv');
  assert.deepEqual(mentionedFiles(`엑셀 파일: ${full}\n보고서 "./notes.md" 와 ../secret.md, C:\\other\\x.csv`, d), [
    'out/summary.csv',
    'notes.md',
  ]);
  const before = fileTimes(d);
  const files = await demoOutputFiles(d, before, 5, `요약 파일: ${full}`);
  assert.deepEqual(
    files.map((f) => f.path),
    ['out/summary.csv'],
  );
});

test('저장소에 있고 바뀌지 않은 입력 파일은 엑셀 판정 없이 뒤에, 결과 파일이 먼저', async (t) => {
  const d = mkdtempSync(path.join(tmpdir(), 'ac-demo-'));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  writeFileSync(path.join(d, 'sample.csv'), '날짜,금액\n');
  await git(['init', '-q'], d);
  await git(['add', '-A'], d);
  await git([...AGENT_IDENTITY, 'commit', '-q', '-m', 'x'], d);
  const before = fileTimes(d);
  await new Promise((r) => setTimeout(r, 20));
  writeFileSync(path.join(d, 'summary.csv'), '월,합계\n');
  const files = await demoOutputFiles(d, before, 5, '입력: sample.csv\n결과: summary.csv');
  assert.deepEqual(
    files.map((f) => [f.path, Boolean(f.verdict)]),
    [
      ['summary.csv', true],
      ['sample.csv', false],
    ],
  );
});

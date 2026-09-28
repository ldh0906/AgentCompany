// Codex 재검수(2026-09-28)가 지적한 부분 수정·회귀의 테스트
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../../src/store/db.ts';
import { Records } from '../../src/app/records.ts';
import { git, gitOut } from '../../src/workspace/git.ts';
import { commitWorktree, ensureTicketWorktree, integrateWithMerge, originFingerprint, projectPaths, syncMirror } from '../../src/workspace/workspace.ts';
import { isAlive, startProcess } from '../../src/runner/process.ts';
import { makeOrigin } from './helpers.ts';

const here = path.dirname(fileURLToPath(import.meta.url));

function tmp(t: { after: (fn: () => void) => void }): string {
  const d = mkdtempSync(path.join(tmpdir(), 'ac-rf2-'));
  t.after(() => rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  return d;
}

test('원본 지문: 이미 수정된 파일을 다시 덮어쓰거나 미추적 파일 내용을 바꿔도 탐지', async (t) => {
  const root = tmp(t);
  const origin = await makeOrigin(root);
  writeFileSync(path.join(origin, 'README.md'), '대표 작업 중 1\n');
  writeFileSync(path.join(origin, 'notes.txt'), 'a');
  const before = await originFingerprint(origin);
  writeFileSync(path.join(origin, 'README.md'), '대표 작업 중 2 (몰래 덮어씀)\n');
  assert.notEqual(await originFingerprint(origin), before, '수정된 파일 재수정 탐지');
  writeFileSync(path.join(origin, 'README.md'), '대표 작업 중 1\n');
  assert.equal(await originFingerprint(origin), before);
  writeFileSync(path.join(origin, 'notes.txt'), 'b');
  assert.notEqual(await originFingerprint(origin), before, '미추적 파일 내용 변경 탐지');
});

test('원본 지문: 오케스트레이터의 정상 fast-forward 반영에는 변하지 않음(동시 검증 오탐 방지)', async (t) => {
  const root = tmp(t);
  const origin = await makeOrigin(root);
  const paths = projectPaths(path.join(root, 'data'), 'P');
  await syncMirror(origin, paths, 'main');
  const wt = await ensureTicketWorktree(paths, 'T-1', 'main');
  writeFileSync(path.join(wt.path, 'src', 'b.ts'), '1');
  const sha = (await commitWorktree(wt, 'x'))!;
  const before = await originFingerprint(origin);
  const r = await integrateWithMerge(origin, paths, 'T-1', 'main', sha, '기능');
  assert.equal(r.kind, 'merged');
  assert.equal(await originFingerprint(origin), before);
});

test('반영은 승인된 SHA 자체를 가져옴 (원본 브랜치 = 승인 SHA, 임시 ref 없음)', async (t) => {
  const root = tmp(t);
  const origin = await makeOrigin(root);
  const paths = projectPaths(path.join(root, 'data'), 'P');
  await syncMirror(origin, paths, 'main');
  const wt = await ensureTicketWorktree(paths, 'T-1', 'main');
  writeFileSync(path.join(wt.path, 'src', 'b.ts'), '1');
  const sha = (await commitWorktree(wt, 'x'))!;
  await git(['checkout', '-q', '-b', 'other'], origin);
  const r = await integrateWithMerge(origin, paths, 'T-1', 'main', sha, '기능');
  assert.equal(r.kind, 'merged');
  assert.equal((await gitOut(['for-each-ref', '--format=%(refname)', 'refs/ac-merge', 'refs/ac-approved'], origin)), '');
  if (r.kind === 'merged') assert.equal(await gitOut(['rev-parse', 'main'], origin), r.mergeSha);
});

test('감사 로그: 끝부분을 지운 뒤 새 이벤트를 추가해도 변조가 계속 탐지됨', (t) => {
  const d = tmp(t);
  const db = path.join(d, 'c.db');
  const s1 = new Store(db);
  for (let i = 0; i < 3; i++) s1.appendEvent('ceo', 'x', 'E', { i });
  s1.db.prepare('DELETE FROM events WHERE seq = 3').run();
  s1.close();
  const s2 = new Store(db);
  s2.appendEvent('ceo', 'after-tamper', 'E', {});
  s2.appendEvent('ceo', 'after-tamper', 'E', {});
  const r = s2.verifyEventChain();
  s2.close();
  assert.equal(r.ok, false);
});

test('감사 로그: 커밋 후 체크포인트 쓰기가 실패해도 트랜잭션은 성공으로 처리되고 검증에 드러남', (t) => {
  const d = tmp(t);
  const db = path.join(d, 'c.db');
  const s = new Store(db);
  mkdirSync(`${db}.head`); // 파일 자리에 폴더 → rename 실패
  assert.doesNotThrow(() => s.appendEvent('ceo', 'x', 'E', {}));
  assert.equal((s.db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n, 1);
  const r = s.verifyEventChain();
  s.close();
  assert.equal(r.ok, false);
});

test('증거는 제출(실행) 단위로만 조회: 이전 회차의 대표 확인을 재사용할 수 없음', (t) => {
  const d = tmp(t);
  const s = new Store(path.join(d, 'c.db'));
  const r = new Records(s);
  const base = { ticketId: 'T', round: 1, headSha: 'h', type: 'human_attest' as const, label: '', argv: null, exitCode: null, passed: true, outputPath: null, summary: '', requirementId: 'R1', createdAt: '2026' };
  r.saveEvidence({ ...base, id: 'E1' }, 'RUN-1');
  r.saveEvidence({ ...base, id: 'E2', round: 2 }, 'RUN-2');
  assert.deepEqual(r.evidenceFor('T', { submission: 'RUN-2' }).map((e) => e.id), ['E2']);
  assert.deepEqual(r.evidenceFor('T', { submission: null }), []);
  s.close();
});

test('셔틀: 복구가 포기 표시를 남긴 실행은 CLI를 띄우지 않음(중복 실행 방지)', async (t) => {
  const d = tmp(t);
  const marker = path.join(d, 'ran.txt');
  writeFileSync(path.join(d, 'abandoned'), 'x');
  writeFileSync(path.join(d, 'spec.json'), JSON.stringify({
    file: process.execPath, args: ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`], cwd: d, stdinPath: null,
    stdoutPath: path.join(d, 'out.log'), stderrPath: path.join(d, 'err.log'), pidPath: path.join(d, 'pid.json'), exitPath: path.join(d, 'exit.json'), timeoutMs: 10_000,
  }));
  const shim = spawn(process.execPath, ['--no-warnings', path.join(here, '..', '..', 'src', 'runner', 'shim.ts'), path.join(d, 'spec.json')], { windowsHide: true, stdio: 'ignore' });
  await new Promise((r) => shim.once('close', r));
  assert.equal(existsSync(marker), false, 'CLI가 실행되지 않음');
  assert.equal(JSON.parse(readFileSync(path.join(d, 'exit.json'), 'utf8')).abandoned, true);
});

test('명시적 종료는 CLI와 그 하위 프로세스까지 종료', { timeout: 30_000 }, async (t) => {
  const d = tmp(t);
  const script = "const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(c.pid);setInterval(()=>{},1000)";
  const p = await startProcess({ file: process.execPath, args: ['-e', script], cwd: d, env: process.env, stdinText: null, runDir: path.join(d, 'run'), timeoutMs: 60_000 });
  let grandchild = 0;
  for (let i = 0; i < 50 && !grandchild; i++) {
    await new Promise((r) => setTimeout(r, 100));
    grandchild = Number(readFileSync(p.stdoutPath, 'utf8').trim()) || 0;
  }
  assert.ok(grandchild > 0);
  await p.kill();
  await p.done;
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(isAlive(grandchild), false, '하위 프로세스도 종료');
});

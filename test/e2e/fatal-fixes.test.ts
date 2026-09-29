// 실사용 점검(2026-09-30, 앱만으로 게임 만들기)에서 첫 업무부터 막힌 원인들의 회귀 테스트.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { dependencySetup } from '../../src/app/verify-setup.ts';
import { PreviewManager, previewCommand } from '../../src/app/preview.ts';
import { createRepo } from '../../src/app/repo-inspect.ts';
import { git, gitOut } from '../../src/workspace/git.ts';
import { reviewDiffText } from '../../src/workspace/workspace.ts';
import { driveUntil, newImplTicket, setup } from './helpers.ts';

function tmp(t: { after: (fn: () => void) => void }): string {
  const d = mkdtempSync(path.join(tmpdir(), 'ac-fix-'));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

test('수정 요청에 고칠 게 없으면 이전 결과를 그대로 다시 제출(반박) → "변경 없음" 반려 없이 재검수', { timeout: 120_000 }, async (t) => {
  const env = await setup(t, { implementer: 'stubborn', reviewer: 'picky' });
  const tk = newImplTicket(env);
  const end = await driveUntil(env, tk.id, (x) => x.status === 'awaiting_approval' || x.hold !== null || x.round > 2);
  assert.equal(end.status, 'awaiting_approval', `보류: ${end.hold?.note}`);
  assert.equal(end.round, 2);
});

test('검수가 막히면(회차 초과) 대표가 검수를 건너뛰고 승인 단계로 보낼 수 있다 — 검증 통과 제출물만', { timeout: 180_000 }, async (t) => {
  const env = await setup(t, { reviewer: 'harsh' });
  const tk = newImplTicket(env);
  const held = await driveUntil(env, tk.id, (x) => x.hold !== null);
  assert.equal(held.hold?.reason, 'needs_decision');
  const next = env.orch.skipReview(tk.id);
  assert.equal(next.status, 'awaiting_approval');
  assert.equal(next.hold, null);
  await env.orch.tick();
  assert.ok(env.orch.records.pendingApprovalFor(tk.id, 'integrate'), '대표 승인 요청이 생긴다');
});

test('검증 실패한 제출물은 검수 건너뛰기로도 승인 단계에 못 간다', { timeout: 180_000 }, async (t) => {
  const env = await setup(t, {
    reviewer: 'harsh',
    verify: [{ label: 'unit tests', argv: ['node', '-e', 'process.exit(1)'], evidenceType: 'unit_test' }],
  });
  const tk = newImplTicket(env);
  await driveUntil(env, tk.id, (x) => x.hold !== null);
  assert.throws(() => env.orch.skipReview(tk.id), /검증/);
});

test('검증 전 의존성 설치: package.json만 있고 node_modules가 없으면 잠금 파일에 맞는 설치를 앞에 붙인다', (t) => {
  const d = tmp(t);
  assert.equal(dependencySetup(d, []), null, 'package.json이 없으면 없음');
  writeFileSync(path.join(d, 'package.json'), '{}');
  assert.deepEqual(dependencySetup(d, [])?.argv.slice(0, 2), ['npm', 'install']);
  writeFileSync(path.join(d, 'package-lock.json'), '{}');
  assert.deepEqual(dependencySetup(d, [])?.argv.slice(0, 2), ['npm', 'ci']);
  assert.equal(
    dependencySetup(d, [{ label: 'i', argv: ['npm', 'ci'], evidenceType: 'static_check' }]),
    null,
    '대표가 설치 명령을 이미 넣었으면 그대로',
  );
  mkdirSync(path.join(d, 'node_modules'));
  assert.equal(dependencySetup(d, []), null, '이미 설치됨');
});

test('검수용 diff: 변경 요약을 앞에 두고 잠금 파일 본문은 뺀다', async (t) => {
  const d = tmp(t);
  await git(['init', '-q', '-b', 'main'], d);
  const id = ['-c', 'user.name=t', '-c', 'user.email=t@t'];
  await git([...id, 'commit', '-q', '--allow-empty', '-m', 'base'], d);
  const base = await gitOut(['rev-parse', 'HEAD'], d);
  writeFileSync(path.join(d, 'package-lock.json'), `${'"lock-line",\n'.repeat(5000)}`);
  mkdirSync(path.join(d, 'src'));
  writeFileSync(path.join(d, 'src', 'loop.ts'), 'export const step = 1 / 60;\n');
  await git(['add', '-A'], d);
  await git([...id, 'commit', '-q', '-m', 'work'], d);
  const out = await reviewDiffText(d, base, await gitOut(['rev-parse', 'HEAD'], d));
  assert.match(out, /package-lock\.json \| 5000/, '요약에는 남는다');
  assert.ok(!out.includes('"lock-line"'), '본문은 빠진다');
  assert.match(out, /export const step/);
});

test('새 프로젝트: 폴더를 만들고 빈 첫 커밋이 있는 main 저장소로 시작', async (t) => {
  const d = tmp(t);
  const repo = await createRepo(d, 'my-game');
  assert.equal(repo, path.join(d, 'my-game'));
  assert.equal(await gitOut(['rev-parse', '--abbrev-ref', 'HEAD'], repo), 'main');
  assert.equal((await gitOut(['rev-list', '--count', 'HEAD'], repo)).trim(), '1');
  await assert.rejects(createRepo(d, 'my-game'), /이미|exists/);
  await assert.rejects(createRepo(d, '../x'), /문자|characters/);
});

test('실행해 보기: dev 스크립트 우선, 없으면 index.html을 내장 정적 서버로 띄운다', async (t) => {
  const d = tmp(t);
  assert.equal(previewCommand(d), null);
  writeFileSync(path.join(d, 'index.html'), '<canvas id="game"></canvas>');
  assert.deepEqual(previewCommand(d), { static: true });
  const pm = new PreviewManager();
  t.after(() => pm.stopAll());
  const info = await pm.start({ projectId: 'P', ticketId: null, sha: 'x', dir: d });
  assert.equal(info.state, 'running');
  const body = await (await fetch(info.url!)).text();
  assert.match(body, /canvas/);
  assert.equal((await fetch(new URL('/nope.txt', info.url!))).status, 404);
  writeFileSync(path.join(d, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }));
  assert.deepEqual(previewCommand(d), { argv: ['npm', 'run', 'dev'] });
});

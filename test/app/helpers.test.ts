// 입력 도우미: 모델 목록 해석, 폴더 찾아보기, 저장소 자동 분석
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseAgyModels, parseCodexModels } from '../../src/app/models.ts';
import { inspectRepo, listDirs } from '../../src/app/repo-inspect.ts';
import { AGENT_IDENTITY, git } from '../../src/workspace/git.ts';

test('모델 목록: codex debug models JSON (목록 공개 모델만)', () => {
  const out = JSON.stringify({
    models: [
      { slug: 'gpt-6-astra', display_name: 'GPT-6-Astra', description: 'Frontier', visibility: 'list' },
      { slug: 'hidden-x', display_name: 'Hidden', visibility: 'hide' },
    ],
  });
  assert.deepEqual(parseCodexModels(out), [
    { id: 'gpt-6-astra', label: 'GPT-6-Astra', note: 'Frontier' },
    { id: 'hidden-x', label: 'Hidden (hidden)' },
  ]);
});

test('모델 목록: agy models (ID<TAB>이름, 안내 문구 무시)', () => {
  const out =
    'Fetching available models...\r\ngemini-3.8-flash-high\tGemini 3.8 Flash (High)\r\nclaude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\r\n';
  assert.deepEqual(parseAgyModels(out), [
    { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)' },
    { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (Thinking)' },
  ]);
});

function tmp(t: { after: (fn: () => void) => void }): string {
  const d = mkdtempSync(path.join(tmpdir(), 'ac-help-'));
  t.after(() => rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  return d;
}

test('폴더 찾아보기: 하위 폴더와 git 저장소 여부', async (t) => {
  const d = tmp(t);
  mkdirSync(path.join(d, 'game', '.git'), { recursive: true });
  mkdirSync(path.join(d, 'notes'));
  writeFileSync(path.join(d, 'file.txt'), 'x');
  const r = await listDirs(d);
  assert.equal(r.path, d);
  assert.deepEqual(
    r.dirs.map((x) => [x.name, x.isGit]),
    [
      ['game', true],
      ['notes', false],
    ],
  );
  assert.equal(r.parent, path.dirname(d));
});

test('저장소 분석: 이름·현재 브랜치·검증 명령·폴더·보호 경로 제안', async (t) => {
  const d = tmp(t);
  const repo = path.join(d, 'my-game');
  mkdirSync(path.join(repo, 'src'), { recursive: true });
  mkdirSync(path.join(repo, 'docs'));
  writeFileSync(path.join(repo, 'src', 'a.ts'), 'x');
  writeFileSync(path.join(repo, 'docs', 'd.md'), 'x');
  writeFileSync(path.join(repo, 'README.md'), '# r');
  writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ scripts: { test: 'node --test', typecheck: 'tsc', dev: 'vite' } }));
  await git(['init', '-q', '-b', 'develop'], repo);
  await git(['add', '-A'], repo);
  await git([...AGENT_IDENTITY, 'commit', '-q', '-m', 'init'], repo);
  const r = await inspectRepo(repo);
  assert.equal(r.isGit, true);
  assert.equal(r.name, 'my-game');
  assert.equal(r.baseBranch, 'develop');
  assert.deepEqual(
    r.verify.map((v) => [v.argv.join(' '), v.evidenceType]),
    [
      ['npm test', 'unit_test'],
      ['npm run typecheck', 'static_check'],
    ],
  );
  assert.deepEqual(r.dirs, ['docs', 'src']);
  assert.ok(r.protectedSuggestions.includes('README.md'));
  assert.ok(r.protectedSuggestions.includes('package.json'));
});

test('저장소 분석: git 저장소가 아니면 알려 준다', async (t) => {
  const d = tmp(t);
  const r = await inspectRepo(d);
  assert.equal(r.isGit, false);
  assert.deepEqual(r.verify, []);
});

test('모델 목록: Codex 숨김 모델은 맨 뒤, 나머지는 priority 순', () => {
  const out = JSON.stringify({
    models: [
      { slug: 'b', visibility: 'list', priority: 5 },
      { slug: 'h', visibility: 'hide', priority: 1 },
      { slug: 'a', visibility: 'list', priority: 2 },
    ],
  });
  assert.deepEqual(
    parseCodexModels(out).map((m) => m.id),
    ['a', 'b', 'h'],
  );
});

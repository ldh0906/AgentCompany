// 결과물 보기: 제출물에서 바뀐 문서·표·그림을 앱 안에서 읽게 꺼낸다(대표 요청 2026-10-01).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deliverableFiles, projectDoc, projectDocList } from '../../src/app/deliverables.ts';
import { AGENT_IDENTITY, git } from '../../src/workspace/git.ts';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

async function commit(dir: string, msg: string): Promise<string> {
  await git(['add', '-A'], dir);
  await git([...AGENT_IDENTITY, 'commit', '-q', '-m', msg], dir);
  return (await git(['rev-parse', 'HEAD'], dir)).stdout.trim();
}

test('바뀐 문서·표·그림만 읽기 좋은 순서로, 수정 파일은 바뀌기 전 내용도', async (t) => {
  const d = mkdtempSync(path.join(tmpdir(), 'ac-deliv-'));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  await git(['init', '-q', '-b', 'main'], d);
  writeFileSync(path.join(d, 'plan.md'), '# 계획\n옛 내용\n');
  writeFileSync(path.join(d, 'old.txt'), '지울 글\n');
  const base = await commit(d, 'base');
  writeFileSync(path.join(d, 'plan.md'), '# 계획\n새 내용\n');
  mkdirSync(path.join(d, 'data'));
  writeFileSync(path.join(d, 'data', 'sales.csv'), '﻿월,매출\n1월,100\n');
  writeFileSync(path.join(d, 'chart.png'), PNG);
  writeFileSync(path.join(d, 'main.py'), 'print(1)\n');
  unlinkSync(path.join(d, 'old.txt'));
  const head = await commit(d, 'work');

  const files = await deliverableFiles(d, base, head, ['main.py', 'chart.png', 'data/sales.csv', 'old.txt', 'plan.md']);
  assert.deepEqual(
    files.map((f) => [f.path, f.kind, f.status]),
    [
      ['plan.md', 'markdown', 'modified'],
      ['data/sales.csv', 'table', 'added'],
      ['old.txt', 'text', 'deleted'],
      ['chart.png', 'image', 'added'],
    ],
    '코드(.py)는 빼고, 문서 → 표 → 글 → 그림 순',
  );
  assert.equal(files[0]!.text, '# 계획\n새 내용\n');
  assert.equal(files[0]!.before, '# 계획\n옛 내용\n');
  assert.equal(files[1]!.text, '월,매출\n1월,100\n', '엑셀용 BOM은 보기에서 뺀다');
  assert.equal(files[1]!.before, undefined, '새 파일은 바뀌기 전이 없다');
  assert.match(files[3]!.dataUrl ?? '', /^data:image\/png;base64,/);

  const list = await projectDocList(d, head);
  assert.deepEqual(
    list.map((x) => x.path),
    ['plan.md', 'data/sales.csv', 'chart.png'],
  );
  assert.equal((await projectDoc(d, head, 'plan.md'))?.text, '# 계획\n새 내용\n');
  assert.equal(await projectDoc(d, head, 'main.py'), null, '읽을 파일 종류가 아니면 거절');
  assert.equal(await projectDoc(d, head, 'nope.md'), null);
});

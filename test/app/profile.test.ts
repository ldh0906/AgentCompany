// 앱 전용 CLI 프로필 폴더는 로그인 전에 존재해야 한다(Codex는 CODEX_HOME 폴더가 없으면 실행을 거부).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { appProfileDir, profileRoot } from '../../src/app/doctor.ts';

test('앱 전용 프로필 폴더가 없으면 빈 폴더를 만든다', (t) => {
  const d = mkdtempSync(path.join(tmpdir(), 'ac-prof-'));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  const dir = appProfileDir(profileRoot(d), 'codex');
  assert.equal(dir, path.join(d, 'profiles', 'codex'));
  assert.ok(existsSync(dir));
  assert.equal(appProfileDir(profileRoot(d), 'codex'), dir); // 이미 있어도 그대로
});

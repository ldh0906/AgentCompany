// 토스트 알림 명령: 직원이 쓴 글자(업무 제목)가 PowerShell 코드로 해석되지 않는다(보안 점검 2026-10-01).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { toastCommand } from '../../src/app/notify.ts';

const decode = (args: string[]) => Buffer.from(args.at(-1)!, 'base64').toString('utf16le');

test('토스트: 제목·내용은 스크립트가 아니라 환경변수로(XML만 이스케이프)', () => {
  const evil = 'x’; New-Item pwned; ’ <b>&';
  const { args, env } = toastCommand(evil, 'body');
  assert.ok(!decode(args).includes('pwned'), '글자가 스크립트에 들어가지 않는다');
  assert.equal(env.AC_TOAST_TITLE, 'x’; New-Item pwned; ’ &lt;b&gt;&amp;');
  assert.equal(env.AC_TOAST_BODY, 'body');
});

test(
  '토스트: 둥근 따옴표가 섞인 글자도 PowerShell에서 명령으로 실행되지 않는다',
  { skip: process.platform !== 'win32', timeout: 30_000 },
  (t) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ac-toast-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const marker = path.join(dir, 'pwned.txt');
    // 토스트와 같은 방식(작은따옴표 문자열 + 환경변수 이어 붙이기)으로 글자를 다루고, 결과만 출력한다.
    const script = "$s = '<text>' + $env:AC_TOAST_TITLE + '</text>'; Write-Output $s";
    const title = `x’; New-Item -ItemType File -Path '${marker}'; ’`;
    const r = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      {
        env: toastCommand(title, '').env,
        encoding: 'utf8',
        windowsHide: true,
      },
    );
    assert.equal(r.status, 0, r.stderr);
    assert.equal(existsSync(marker), false, '명령이 실행되면 안 된다');
  },
);

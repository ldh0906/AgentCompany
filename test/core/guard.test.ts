// 권한 위임 처리자의 판단: 치명적인 것만 막고 나머지는 허용한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judgeReadOnlyCommand, judgeToolRequest } from '../../src/core/guard.ts';

const WS = 'C:\\Users\\me\\AgentCompany\\projects\\P-1\\wt\\T-4';
const cmd = (command: unknown, tool = 'PowerShell') => judgeToolRequest({ tool, input: { command }, workspace: WS });

test('허용: 일상적인 명령·작업공간 안 삭제·빌드·테스트', () => {
  for (const c of [
    'git ls-files | Select-Object -First 80; ls docs/architecture',
    'npm test',
    'dotnet build',
    'Remove-Item -Recurse -Force .\\Library\\Temp',
    `Remove-Item -Recurse -Force "${WS}\\build"`,
    'rm -rf node_modules dist',
    'Get-Content src/party.js',
    'powershell -NoProfile -File tools/unity-editor.ps1',
  ])
    assert.equal(cmd(c).allow, true, c);
});

test('차단: 드라이브·홈·시스템 폴더 통째 삭제', () => {
  for (const c of [
    'rm -rf /',
    'rm -rf ~',
    'rm -rf /*',
    'Remove-Item -Recurse -Force C:\\',
    'Remove-Item C:\\* -Recurse -Force',
    'Remove-Item -Path $env:USERPROFILE -Recurse',
    'rd /s /q C:\\Windows',
    'del /s /q D:\\',
    'rmdir /s /q "C:\\Program Files"',
    'Get-ChildItem C:\\Users | Remove-Item -Recurse -Force',
  ]) {
    const r = cmd(c);
    assert.equal(r.allow, false, c);
    assert.ok(r.reason);
  }
});

test('차단: 작업공간 밖 절대경로 재귀 삭제', () => {
  assert.equal(cmd('Remove-Item -Recurse -Force D:\\GameDev\\Projects\\PUBG').allow, false);
  assert.equal(cmd('rm -rf /home/me/project').allow, false);
});

test('차단: 포맷·디스크·부팅·레지스트리·섀도 복사본·종료', () => {
  for (const c of [
    'format C: /q',
    'Format-Volume -DriveLetter D',
    'diskpart /s wipe.txt',
    'Clear-Disk -Number 0 -RemoveData',
    'bcdedit /deletevalue {current} safeboot',
    'reg delete HKLM\\SOFTWARE /f',
    'Remove-Item -Path HKLM:\\SOFTWARE\\Microsoft -Recurse',
    'vssadmin delete shadows /all /quiet',
    'shutdown /s /t 0',
    'Stop-Computer -Force',
    'Restart-Computer',
    'mkfs.ext4 /dev/sda1',
    'dd if=/dev/zero of=/dev/sda',
  ])
    assert.equal(cmd(c).allow, false, c);
});

test('Codex 형식(argv 배열)과 파일 변경 요청', () => {
  assert.equal(judgeToolRequest({ tool: 'command', input: { command: ['rm', '-rf', '/'] }, workspace: WS }).allow, false);
  assert.equal(judgeToolRequest({ tool: 'command', input: { command: ['npm', 'test'] }, workspace: WS }).allow, true);
  assert.equal(
    judgeToolRequest({ tool: 'fileChange', input: { files: [{ path: `${WS}\\src\\a.ts`, kind: 'update' }] }, workspace: WS }).allow,
    true,
  );
});

test('Claude 도구 입력(tool_name/input 감싼 형식)도 읽는다', () => {
  const r = judgeToolRequest({
    tool: 'Bash',
    input: { tool_name: 'Bash', input: { command: 'rm -rf ~/', description: 'clean' } },
    workspace: WS,
  });
  assert.equal(r.allow, false);
});

test('실측 Codex 형식: powershell.exe -Command "…" 안에 숨은 명령도 검사', () => {
  const wrap = (inner: string) => `"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command "${inner}"`;
  assert.equal(cmd(wrap('Get-Location; rg --files -g package.json'), 'command').allow, true);
  assert.equal(cmd(wrap('Remove-Item -Recurse -Force C:\\'), 'command').allow, false);
  assert.equal(cmd(wrap('Remove-Item -Recurse -Force .\\obj'), 'command').allow, true);
  assert.equal(cmd("bash -lc 'rm -rf / --no-preserve-root'", 'Bash').allow, false);
});

test('읽기 전용 실행(검수): 읽기·검색·테스트는 허용, 쓰기·git 변경·설치·리다이렉트는 차단', () => {
  const ps = (inner: string) => `"C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe" -Command '${inner}'`;
  const ok = (c: string) => judgeReadOnlyCommand(c, WS).allow;
  for (const c of [
    ps('Get-Content -LiteralPath src/main.ts'),
    ps('Get-ChildItem -Recurse src | Select-Object FullName'),
    'rg -n "GameLoop" src',
    'git diff HEAD~1 --stat',
    'git log --oneline -5',
    'git show HEAD:package.json',
    'npm test',
    'npx vitest run',
    ps('Select-String -Path tests/*.ts -Pattern "copy"'),
  ])
    assert.equal(ok(c), true, c);
  for (const c of [
    ps("Set-Content -LiteralPath written.txt -Value 'x'"),
    ps('Remove-Item a.txt'),
    'rm -rf src',
    'git commit -am x',
    'git checkout main',
    'git branch -D feature',
    'echo hi > out.txt',
    'npm install',
    'npm ci',
    ps('New-Item -ItemType File x.ts'),
  ])
    assert.equal(ok(c), false, c);
  assert.equal(ok(ps('Get-Content x 2>$null')), true, '오류 버리기 리다이렉트는 허용');
});

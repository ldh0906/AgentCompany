// 앱 창과 바로가기: 순수한 부분만 검사한다(실제 창·바탕화면은 건드리지 않는다).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { appBrowserCandidates, appWindowArgs, launcherScript } from '../../src/cli/app-window.ts';

test('앱 창: 주소창 없는 앱 모드, 사용자 브라우저 프로필과 분리된 설정 폴더', () => {
  const args = appWindowArgs('http://127.0.0.1:4777/#token=abc', path.join('D', 'data'));
  assert.equal(args[0], '--app=http://127.0.0.1:4777/#token=abc');
  assert.ok(args.includes(`--user-data-dir=${path.join('D', 'data', 'app-window')}`));
  assert.ok(args.includes('--no-first-run'));
});

test('바로가기 실행 스크립트: 창 없이(0) 백그라운드로 서버를 켜고, 경로의 따옴표를 이스케이프', () => {
  const s = launcherScript('C:\\Program Files\\nodejs\\node.exe', 'C:\\app "x"\\main.js', 'C:\\Users\\me\\AgentCompany');
  assert.match(s, /CreateObject\("WScript\.Shell"\)/);
  assert.match(s, /""C:\\Program Files\\nodejs\\node\.exe"" ""C:\\app ""x""\\main\.js"" start --background/);
  assert.match(s, /, 0, False\r\n/);
});

test('앱 창 후보에 Edge는 없고 Chrome이 먼저 (대표 결정)', () => {
  for (const platform of ['win32', 'darwin', 'linux'] as const) {
    const c = appBrowserCandidates({ ProgramFiles: 'C:/PF', 'ProgramFiles(x86)': 'C:/PF86', LOCALAPPDATA: 'C:/LAD' }, platform);
    assert.ok(c.length > 0);
    assert.ok(
      c.every((x) => !/edge/i.test(x)),
      `${platform}: Edge 제외`,
    );
    assert.match(c[0]!, /chrome/i);
  }
});

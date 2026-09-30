// 앱처럼 쓰기: 주소창 없는 전용 창(Chrome 계열 앱 모드)과 바탕화면·시작 메뉴 바로가기.
// 설치하는 것은 없다. 바로가기는 창 없이 서버를 켜는 작은 VBScript를 가리킨다.
// Edge는 쓰지 않는다(대표 결정, 2026-09-29): Chrome → Brave → Chromium → Vivaldi, 없으면 기본 브라우저 탭.
import { execFile, spawn } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** 앱 창 후보(우선순위 순). */
export function appBrowserCandidates(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string[] {
  const c: string[] = [];
  if (platform === 'win32') {
    const bases = [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA].filter(Boolean) as string[];
    for (const rel of [
      ['Google', 'Chrome', 'Application', 'chrome.exe'],
      ['BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'],
      ['Chromium', 'Application', 'chrome.exe'],
      ['Vivaldi', 'Application', 'vivaldi.exe'],
    ])
      for (const base of bases) c.push(path.join(base, ...rel));
  } else if (platform === 'darwin') {
    c.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    );
  } else {
    c.push('/usr/bin/google-chrome', '/usr/bin/brave-browser', '/usr/bin/chromium', '/usr/bin/chromium-browser');
  }
  return c;
}

/** 앱 모드를 지원하는 브라우저 실행 파일(없으면 null → 기본 브라우저 탭). */
export function findAppBrowser(env: NodeJS.ProcessEnv = process.env): string | null {
  return appBrowserCandidates(env).find((f) => existsSync(f)) ?? null;
}

export function appWindowArgs(url: string, dataDir: string): string[] {
  return [
    `--app=${url}`,
    `--user-data-dir=${path.join(dataDir, 'app-window')}`, // 앱 전용 창 설정(사용자 브라우저 프로필과 분리)
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1440,920',
  ];
}

/** 전용 창으로 연다. 브라우저를 못 찾으면 false(호출자가 일반 탭으로 연다). */
export function openAppWindow(url: string, dataDir: string): boolean {
  const browser = findAppBrowser();
  if (!browser) return false;
  const child = spawn(browser, appWindowArgs(url, dataDir), { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
  return true;
}

/** 바로가기가 실행하는 스크립트: 창 없이(0) 서버를 켜고 기다리지 않는다(False). */
export function launcherScript(nodePath: string, mainPath: string, dataDir: string): string {
  const q = (s: string) => s.replace(/"/g, '""');
  return [
    "' Agent Company launcher (created by `agent-company shortcut`)",
    'Set sh = CreateObject("WScript.Shell")',
    `sh.Run """${q(nodePath)}"" ""${q(mainPath)}"" start --background --data-dir ""${q(dataDir)}""", 0, False`,
    '',
  ].join('\r\n');
}

function powershell(script: string): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) =>
    execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        `[Console]::OutputEncoding = [Text.Encoding]::UTF8; ${script}`,
      ],
      { windowsHide: true, encoding: 'utf8' },
      (error, stdout, stderr) => resolve({ ok: !error, out: `${stdout}${stderr}`.trim() }),
    ),
  );
}

// PowerShell은 둥근 따옴표(‘ ’ ‚ ‛)도 작은따옴표로 읽으므로 함께 두 번 쓴다.
const psq = (s: string) => `'${s.replace(/['‘’‚‛]/g, '$&$&')}'`;

/** 바탕화면과 시작 메뉴에 'Agent Company' 바로가기를 만든다(Windows). 만든 경로를 돌려준다. */
export async function createShortcuts(opts: { dataDir: string; mainPath: string; iconPath: string | null }): Promise<string[]> {
  if (process.platform !== 'win32') throw new Error('shortcuts are supported on Windows only');
  const vbs = path.join(opts.dataDir, 'launch.vbs');
  // VBScript는 UTF-16LE(BOM)면 한글 경로도 안전하다.
  writeFileSync(
    vbs,
    Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(launcherScript(process.execPath, opts.mainPath, opts.dataDir), 'utf16le')]),
  );
  const script = `
$sh = New-Object -ComObject WScript.Shell
$made = @()
foreach ($dir in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))) {
  $lnk = Join-Path $dir 'Agent Company.lnk'
  $s = $sh.CreateShortcut($lnk)
  $s.TargetPath = Join-Path $env:WINDIR 'System32\\wscript.exe'
  $s.Arguments = '"' + ${psq(vbs)} + '"'
  $s.WorkingDirectory = ${psq(opts.dataDir)}
  $s.Description = 'Agent Company'
  ${opts.iconPath ? `$s.IconLocation = ${psq(opts.iconPath)} + ',0'` : ''}
  $s.Save()
  $made += $lnk
}
$made -join [char]10`;
  const r = await powershell(script);
  if (!r.ok) throw new Error(r.out);
  return r.out
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function removeShortcuts(dataDir: string): Promise<string[]> {
  rmSync(path.join(dataDir, 'launch.vbs'), { force: true });
  if (process.platform !== 'win32') return [];
  const r = await powershell(`
$gone = @()
foreach ($dir in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))) {
  $lnk = Join-Path $dir 'Agent Company.lnk'
  if (Test-Path $lnk) { Remove-Item $lnk -Force; $gone += $lnk }
}
$gone -join [char]10`);
  return r.out
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

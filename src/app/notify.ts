// 대표 알림: "지금 대표가 할 일" 목록과 알림(QA 자동 반려, 요청 완료 등), 그리고 선택형 윈도우 토스트.
// 대표 요청(2026-09-30): 알려 줄 게 있으면 알려 주기. 게임 중 창을 띄우지 말라고 했으므로 토스트는 기본으로 끈다.

import { spawn, spawnSync } from 'node:child_process';

export interface CeoTodo {
  /** 같은 할 일을 두 번 알리지 않기 위한 키 */
  key: string;
  kind: 'approval' | 'decision' | 'permission' | 'draft' | 'failed' | 'paused';
  title: string;
  /** 대시보드 안의 이동 경로(예: /tickets/T-3) */
  link: string;
}

export interface CeoNotice {
  id: string;
  at: string;
  title: string;
  body: string;
  link: string;
}

/**
 * 윈도우 토스트(화면 구석 알림). 창을 띄우지 않는 숨은 PowerShell로 보낸다. 윈도우가 아니면 아무것도 하지 않는다.
 * 글자는 -EncodedCommand(UTF-16)로 넘겨 따옴표·한글이 깨지지 않게 한다.
 */
export function toastCommand(title: string, body: string): { args: string[]; env: NodeJS.ProcessEnv } {
  // 글자(직원이 쓴 업무 제목 등)는 스크립트에 넣지 않고 환경변수로 넘긴다: PowerShell은 ‘ ’ 같은 둥근 따옴표도
  // 문자열 끝으로 읽어서, 제목에 섞이면 명령이 실행될 수 있었다(보안 점검 2026-10-01). 환경변수 값은 코드로 해석되지 않는다.
  const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const script = [
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null',
    '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null',
    '$x = New-Object Windows.Data.Xml.Dom.XmlDocument',
    "$x.LoadXml('<toast><visual><binding template=\"ToastGeneric\"><text>' + $env:AC_TOAST_TITLE + '</text><text>' + $env:AC_TOAST_BODY + '</text></binding></visual></toast>')",
    "$id = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'",
    '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($id).Show([Windows.UI.Notifications.ToastNotification]::new($x))',
  ].join('; ');
  return {
    args: ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    env: { ...process.env, AC_TOAST_TITLE: xml(title.slice(0, 80)), AC_TOAST_BODY: xml(body.slice(0, 200)) },
  };
}

export function showToast(title: string, body: string): void {
  if (process.platform !== 'win32') return;
  const { args, env } = toastCommand(title, body);
  const child = spawn('powershell.exe', args, { windowsHide: true, stdio: 'ignore', detached: false, env });
  child.on('error', () => {});
}

/**
 * 토스트가 실제로 보이는지: 윈도우 설정에서 PowerShell 알림이 꺼져 있으면 보내도 보이지 않는다.
 * 실측(2026-09-30): 이 PC는 DisabledForUser였다. 시스템 설정은 대표가 직접 바꿔야 한다.
 */
export function toastBlocked(): string | null {
  if (process.platform !== 'win32') return 'Windows only';
  const script = [
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null',
    "$id = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'",
    'Write-Output ([Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($id).Setting)',
  ].join('; ');
  const r = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15_000,
    },
  );
  const setting = (r.stdout ?? '').trim().split(/\s+/)[0] ?? '';
  return setting === 'Enabled' ? null : setting || 'unknown';
}

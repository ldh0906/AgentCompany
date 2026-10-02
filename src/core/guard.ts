// 권한 위임 처리자(전체 자동 직원)의 판단. 치명적인 것만 막고 나머지는 허용한다(대표 결정, 2026-09-30).
// 막는 것: 드라이브·홈·시스템 폴더 통째 삭제, 작업공간 밖 절대경로 재귀 삭제, 포맷·디스크 초기화,
// 부팅 설정·레지스트리 핵심부·섀도 복사본 삭제, PC 종료·재시작.
// 순수 함수: 명령을 실행하지 않고 문자열만 읽는다.

export interface ToolJudgement {
  allow: boolean;
  reason?: string;
}

const HARD: [RegExp, string][] = [
  [/\bformat(\.com)?\s+[a-z]:/i, 'disk format'],
  [/\bformat-volume\b/i, 'disk format'],
  [/\bdiskpart\b/i, 'diskpart'],
  [/\b(clear|initialize)-disk\b/i, 'disk wipe'],
  [/\bmkfs(\.\w+)?\b/i, 'filesystem format'],
  [/\bdd\b[^|;&]*\bof=\/dev\//i, 'raw disk write'],
  [/\bbcdedit\b/i, 'boot configuration'],
  [/\breg(\.exe)?\s+delete\s+(hklm|hkey_local_machine|hkcr|hkey_classes_root|hku|hkey_users)\b/i, 'registry delete'],
  [/\bremove-item\b[^|;&]*\bhk(lm|cr|u):/i, 'registry delete'],
  [/\bvssadmin\b[^|;&]*\bdelete\b/i, 'shadow copy delete'],
  [/\bwmic\b[^|;&]*shadowcopy[^|;&]*\bdelete\b/i, 'shadow copy delete'],
  [/\bcipher(\.exe)?\s+\/w/i, 'free-space wipe'],
  [/\bshutdown(\.exe)?\b/i, 'shutdown'],
  [/\b(stop|restart)-computer\b/i, 'shutdown/restart'],
  [/(^|[;&|]\s*)(sudo\s+)?(reboot|poweroff|halt)\b/i, 'shutdown/restart'],
];

/** 도구 요청 입력에서 명령 문자열을 꺼낸다(Claude: {tool_name,input:{command}}, Codex: {command: string|argv}). */
export function commandOf(input: unknown): string | null {
  const o = input && typeof input === 'object' ? (input as Record<string, unknown>) : null;
  if (!o) return null;
  const c = o.command ?? o.cmd;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map(String).join(' ');
  if (o.input && typeof o.input === 'object') return commandOf(o.input);
  return null;
}

/** 따옴표를 존중해 토큰으로 나눈다. */
function tokens(s: string): string[] {
  return (s.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((t) => t.replace(/^["']|["']$/g, ''));
}

// 두 겹 백슬래시도 하나로: Codex는 명령 안 경로를 "C:\\Users\\…"처럼 이스케이프해 보낸다(실측 2026-10-02).
const norm = (p: string) =>
  p
    .replace(/\//g, '\\')
    .replace(/\\{2,}/g, '\\')
    .replace(/\\+$/, '')
    .toLowerCase();

function isAbsolute(p: string): boolean {
  return /^[a-z]:/i.test(p) || p.startsWith('/') || p.startsWith('\\') || p.startsWith('~') || /^\$(env:)?\w+|^%\w+%/i.test(p);
}

function dangerousTarget(p: string, workspace: string): string | null {
  const t = p.trim();
  if (!t) return null;
  if (/^\.\.([\\/]|$)/.test(t)) return 'parent of the workspace';
  if (!isAbsolute(t)) return null; // 작업공간 안 상대 경로
  const n = norm(t.replace(/[\\/]\*$/, ''));
  if (/^[a-z]:$/.test(n) || n === '' || n === '\\' || n === '\\*') return 'drive root';
  if (/^(~|\$home|\$env:userprofile|%userprofile%|\$env:homepath|%homepath%)$/.test(n)) return 'home folder';
  const ws = norm(workspace);
  if (ws && (n === ws || n.startsWith(`${ws}\\`))) return null; // 작업공간 안
  return 'outside the workspace';
}

const DELETE_SEGMENT = /\b(rm|remove-item|ri|rd|rmdir|del|erase)\b/i;

/** 재귀 삭제 한 토막을 검사한다. prevTarget: 파이프 앞 명령이 넘긴 경로(Get-ChildItem C:\Users | Remove-Item). */
function judgeDelete(seg: string, workspace: string, prevTarget: string | null): string | null {
  const tk = tokens(seg);
  const i = tk.findIndex((x) => DELETE_SEGMENT.test(x) && /^(rm|remove-item|ri|rd|rmdir|del|erase)$/i.test(x));
  if (i < 0) return null;
  const cmd = tk[i]!.toLowerCase();
  const args = tk.slice(i + 1);
  const cmdStyle = cmd === 'rd' || cmd === 'rmdir' || cmd === 'del' || cmd === 'erase';
  // PowerShell 삭제(Remove-Item/ri)는 -Recurse(줄임 -r, -re, -rec…)만 재귀다. 묶음 짧은 옵션(-rf, -Rf)은 rm만.
  // 실측(2026-10-02, 가계부 T-47): -LiteralPath·-Force에 r이 들어 있어 파일 하나 지우기가 "재귀 삭제"로 막혔다.
  const recursive = cmdStyle
    ? args.some((a) => /^\/s$/i.test(a))
    : cmd === 'rm'
      ? args.some((a) => /^-(-recursive|[a-z]{0,3}r[a-z]{0,3})$/i.test(a))
      : args.some((a) => /^-(r|re|rec|recu|recur|recurs|recurse)$/i.test(a));
  if (!recursive) return null;
  const valueFlags = /^-(path|literalpath|include|exclude|filter)$/i;
  const targets: string[] = [];
  for (let k = 0; k < args.length; k++) {
    const a = args[k]!;
    if (valueFlags.test(a)) {
      if (/^-(path|literalpath)$/i.test(a) && args[k + 1]) targets.push(args[k + 1]!);
      k++;
      continue;
    }
    if (cmdStyle ? /^\/[a-z]$/i.test(a) : a.startsWith('-')) continue;
    targets.push(a);
  }
  if (!targets.length && prevTarget) targets.push(prevTarget);
  for (const t of targets) {
    const why = dangerousTarget(t, workspace);
    if (why) return `recursive delete of ${t} (${why})`;
  }
  return null;
}

function judgeCommand(command: string, workspace: string, depth: number): ToolJudgement {
  for (const [re, what] of HARD) if (re.test(command)) return { allow: false, reason: `${what}: ${command.slice(0, 200)}` };
  for (const stmt of command.split(/;|&&|\|\||\r?\n/)) {
    let prevTarget: string | null = null;
    for (const seg of stmt.split('|')) {
      const why = judgeDelete(seg, workspace, prevTarget);
      if (why) return { allow: false, reason: why };
      const src = tokens(seg);
      const gi = src.findIndex((x) => /^(get-childitem|gci|ls|dir)$/i.test(x));
      prevTarget = gi >= 0 ? (src.slice(gi + 1).find((x) => !x.startsWith('-')) ?? null) : null;
    }
  }
  // 감싼 명령(powershell -Command "…", bash -lc '…')의 안쪽도 한 번 더 본다.
  if (depth < 2) {
    for (const t of tokens(command).filter((x) => /\s/.test(x))) {
      const inner = judgeCommand(t, workspace, depth + 1);
      if (!inner.allow) return inner;
    }
  }
  return { allow: true };
}

// 읽기 전용 실행(검수 등): 파일을 쓰거나 git 기록을 바꾸는 명령은 막는다. 읽기·검색·테스트 실행은 허용.
// (Windows에서 Codex는 승인된 명령을 샌드박스 밖에서 실행하므로 이 판단이 곧 읽기 전용 보장이다.)
const WRITE_CMDLETS =
  /\b(set-content|add-content|out-file|new-item|remove-item|move-item|copy-item|rename-item|clear-content|set-item|tee-object|ni|ri|mi|cpi|rni|sc|ac)\b/i;
const WRITE_SHELL =
  /(^|[\s;&|(])(rm|rmdir|rd|del|erase|mv|move|cp|copy|xcopy|robocopy|mkdir|md|touch|ren|rename|truncate|chmod|chown)(\s|$)/i;
const GIT_MUTATE =
  /\bgit\b[^|;&]*?\s(commit|push|reset|checkout|switch|restore|branch|tag|update-ref|worktree|stash|merge|rebase|cherry-pick|revert|am|apply|clean|rm|mv|add|gc|prune|fetch|pull|config|remote|submodule|notes|replace|symbolic-ref)\b/i;
const REDIRECT = /(^|[^0-9<>=!-])>{1,2}(?!\s*&?\s*(\$?null|nul)\b)/i;
const INSTALL = /\b(npm|pnpm|yarn|bun)\s+(i|install|ci|add|remove|uninstall|update|up|link)\b|\bpip\s+install\b/i;

export function judgeReadOnlyCommand(command: string, workspace: string): ToolJudgement {
  const hard = judgeCommand(command, workspace, 0);
  if (!hard.allow) return hard;
  const c = command;
  if (WRITE_CMDLETS.test(c)) return { allow: false, reason: `read-only run: file write (${command.slice(0, 120)})` };
  if (WRITE_SHELL.test(c)) return { allow: false, reason: `read-only run: file change (${command.slice(0, 120)})` };
  if (GIT_MUTATE.test(c)) return { allow: false, reason: `read-only run: git change (${command.slice(0, 120)})` };
  if (REDIRECT.test(c)) return { allow: false, reason: `read-only run: output redirect (${command.slice(0, 120)})` };
  if (INSTALL.test(c)) return { allow: false, reason: `read-only run: package install (${command.slice(0, 120)})` };
  return { allow: true };
}

export function judgeToolRequest(req: { tool: string; input: unknown; workspace: string }): ToolJudgement {
  const command = commandOf(req.input);
  if (!command) return { allow: true }; // 파일 변경 등: 작업공간 안에서 일어나고 사후 범위 검사가 따로 있다
  return judgeCommand(command, req.workspace, 0);
}

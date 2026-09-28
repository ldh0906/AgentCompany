// 실행 파일 찾기 (M0 작업자 A 구현, 검수 후 이식). PATH·PATHEXT를 따르고 npm .cmd shim은 실제 node 스크립트로 해석해 셸 없이 실행한다.
import { access, readFile, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';

export type LocatedExe = {
  kind: 'exe' | 'node-script' | 'ps1-only' | 'other';
  path: string;
  launch?: { file: string; argsPrefix: string[] };
};

export async function locateExecutable(name: string, env = process.env): Promise<LocatedExe | null> {
  const win = process.platform === 'win32';
  const value = (key: string) => Object.entries(env).find(([k]) => win ? k.toLowerCase() === key.toLowerCase() : k === key)?.[1];
  const dirs = name.includes('/') || name.includes('\\') ? [''] : (value('PATH') ?? '').split(win ? ';' : ':');
  const extensions = win && !path.extname(name) ? (value('PATHEXT') ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
  let fallback: LocatedExe | null = null;
  for (const dir of dirs) {
    for (const ext of [...extensions, ...(win && !path.extname(name) && !extensions.some(e => e.toLowerCase() === '.ps1') ? ['.ps1'] : [])]) {
      const file = path.resolve(dir.replace(/^"|"$/g, ''), name + ext);
      try {
        if (!(await stat(file)).isFile()) continue;
        const suffix = path.extname(file).toLowerCase();
        if (suffix === '.ps1') { fallback ??= { kind: 'ps1-only', path: file }; continue; }
        if (suffix === '.cmd' || suffix === '.bat') {
          const content = await readFile(file, 'utf8');
          const rel = shimTarget(content);
          if (rel) {
            const script = path.resolve(path.dirname(file), rel.replace(/[\\/]/g, path.sep));
            try {
              if ((await stat(script)).isFile()) return { kind: 'node-script', path: file, launch: { file: process.execPath, argsPrefix: [script] } };
            } catch {
              // 대상이 사라진 shim도 발견한 경로를 유지한다.
            }
          }
          return { kind: 'other', path: file };
        }
        if (!win) await access(file, constants.X_OK);
        return { kind: 'exe', path: file, launch: { file, argsPrefix: [] } };
      } catch {
        // 읽거나 실행할 수 없는 후보는 건너뛴다.
      }
    }
  }
  return fallback;
}

const SCRIPT_RE = /(?:%dp0%|%~dp0)[\\/]?([^"\r\n%]*?\.(?:js|cjs|mjs))(?=["\s]|$)/i;

/**
 * .cmd shim이 실제로 실행하는 스크립트(상대 경로)를 찾는다.
 * 인자(%*)를 넘기는 줄이 진짜 실행 줄이다. npm.cmd처럼 그 줄이 변수(%NPM_CLI_JS%)를 쓰면 SET 정의를 따라간다.
 * (첫 번째 .js를 고르면 npm.cmd에서 npm-prefix.js를 잘못 고른다.)
 */
export function shimTarget(content: string): string | null {
  const vars = new Map<string, string>();
  for (const m of content.matchAll(/^\s*SET\s+"?([A-Za-z_][A-Za-z0-9_]*)=([^"\r\n]*)"?\s*$/gim)) {
    const script = m[2]!.match(SCRIPT_RE);
    if (script) vars.set(m[1]!.toUpperCase(), script[1]!);
  }
  const execLine = content.split(/\r?\n/).find((l) => l.includes('%*'));
  if (execLine) {
    const direct = execLine.match(SCRIPT_RE);
    if (direct) return direct[1]!;
    for (const v of execLine.matchAll(/%([A-Za-z_][A-Za-z0-9_]*)%/g)) {
      const hit = vars.get(v[1]!.toUpperCase());
      if (hit) return hit;
    }
  }
  const all = [...content.matchAll(new RegExp(SCRIPT_RE.source, 'gim'))].map((m) => m[1]!);
  return all.filter((s) => !/prefix/i.test(s)).at(-1) ?? all.at(-1) ?? null;
}

// 검증 전 의존성 설치. 검증은 제출 커밋의 깨끗한 사본에서 돌기 때문에 node_modules가 없다
// (실측 2026-09-30: 빈 저장소에서 시작한 프로젝트의 `npm test`가 항상 실패했다).
// 대표가 설치 명령을 검증 명령에 직접 넣었으면 그대로 두고, 아니면 잠금 파일에 맞는 설치 명령을 앞에 붙인다.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { locateExecutable } from '../runner/locate.ts';
import path from 'node:path';
import { tr } from '../core/i18n.ts';
import type { VerifyCommand } from '../core/types.ts';

const INSTALLS = /^(npm|pnpm|yarn|bun)$/i;
const INSTALL_VERBS = /^(i|install|ci|add)$/i;

export function dependencySetup(dir: string, commands: VerifyCommand[]): VerifyCommand | null {
  if (!existsSync(path.join(dir, 'package.json')) || existsSync(path.join(dir, 'node_modules'))) return null;
  if (commands.some((c) => INSTALLS.test(c.argv[0] ?? '') && (INSTALL_VERBS.test(c.argv[1] ?? '') || c.argv.length === 1))) return null;
  const has = (f: string) => existsSync(path.join(dir, f));
  const argv = has('pnpm-lock.yaml')
    ? ['pnpm', 'install', '--frozen-lockfile']
    : has('yarn.lock')
      ? ['yarn', 'install', '--frozen-lockfile']
      : has('package-lock.json')
        ? ['npm', 'ci', '--no-audit', '--no-fund']
        : ['npm', 'install', '--no-audit', '--no-fund'];
  return { label: tr('의존성 설치', 'Install dependencies'), argv, evidenceType: 'setup', timeoutMs: 10 * 60_000 };
}

/**
 * 직원 작업공간에도 의존성을 미리 깔아 둔다(실측: Codex 직원이 "vitest/tsc 미설치로 테스트 실행 불가"를 보고).
 * 실패해도 작업은 진행한다(직원이 직접 설치할 수 있다). 결과만 돌려준다.
 */
export async function installDependencies(dir: string, timeoutMs = 10 * 60_000): Promise<{ ran: boolean; ok: boolean; output: string }> {
  const setup = dependencySetup(dir, []);
  if (!setup) return { ran: false, ok: true, output: '' };
  const located = await locateExecutable(setup.argv[0]!);
  if (!located?.launch) return { ran: true, ok: false, output: `${setup.argv[0]} not found` };
  return new Promise((resolve) => {
    let output = '';
    const child = spawn(located.launch!.file, [...located.launch!.argsPrefix, ...setup.argv.slice(1)], {
      cwd: dir,
      env: { ...process.env, FORCE_COLOR: '0' },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const keep = (d: Buffer) => (output = (output + d.toString('utf8')).slice(-4000));
    child.stdout!.on('data', keep);
    child.stderr!.on('data', keep);
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.once('error', () => (clearTimeout(timer), resolve({ ran: true, ok: false, output })));
    child.once('exit', (code) => (clearTimeout(timer), resolve({ ran: true, ok: code === 0, output })));
  });
}

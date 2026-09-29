// 검증 전 의존성 설치. 검증은 제출 커밋의 깨끗한 사본에서 돌기 때문에 node_modules가 없다
// (실측 2026-09-30: 빈 저장소에서 시작한 프로젝트의 `npm test`가 항상 실패했다).
// 대표가 설치 명령을 검증 명령에 직접 넣었으면 그대로 두고, 아니면 잠금 파일에 맞는 설치 명령을 앞에 붙인다.

import { existsSync } from 'node:fs';
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
  return { label: tr('의존성 설치', 'Install dependencies'), argv, evidenceType: 'static_check', timeoutMs: 10 * 60_000 };
}

import type { CliKind } from '../core/types.ts';
import { agyAdapter } from './agy.ts';
import { claudeAdapter } from './claude.ts';
import { codexAdapter } from './codex.ts';
import { fakeAdapter } from './fake.ts';
import type { CliAdapter } from './types.ts';

export const ADAPTERS: Record<CliKind, CliAdapter> = {
  claude: claudeAdapter,
  codex: codexAdapter,
  agy: agyAdapter,
  fake: fakeAdapter,
};

export function adapterFor(kind: CliKind): CliAdapter {
  return ADAPTERS[kind];
}

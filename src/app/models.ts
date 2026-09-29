// 직원 채용 화면의 모델 목록. CLI가 목록 명령을 주면 그것을(실측 형식), 없으면 공식 별칭을 쓴다.
import { execFile } from 'node:child_process';
import { locateExecutable } from '../runner/locate.ts';
import { cliEnv } from './doctor.ts';
import type { CliKind } from '../core/types.ts';

export interface ModelOption {
  id: string;
  label: string;
  note?: string;
}

/** Claude Code는 목록 명령이 없다: --model 이 받는 공식 별칭. */
export const CLAUDE_MODELS: ModelOption[] = [
  { id: 'opus', label: 'Opus', note: 'most capable' },
  { id: 'sonnet', label: 'Sonnet', note: 'balanced' },
  { id: 'haiku', label: 'Haiku', note: 'fastest' },
];

export const FAKE_MODELS: ModelOption[] = ['diligent', 'lazy', 'rogue', 'slow', 'tamper'].map((id) => ({ id, label: id }));

/** 실측(0.153.4): `codex debug models` → {"models":[{slug, display_name, description, visibility}]} */
export function parseCodexModels(out: string): ModelOption[] {
  const data = JSON.parse(out) as { models?: { slug?: string; display_name?: string; description?: string; visibility?: string }[] };
  return (data.models ?? [])
    .filter((m) => m.slug && m.visibility !== 'hide')
    .map((m) => ({ id: m.slug!, label: m.display_name || m.slug!, ...(m.description ? { note: m.description } : {}) }));
}

/** 실측(1.2.12): `agy models` → 안내 한 줄 뒤에 "ID<TAB>이름" 줄들 */
export function parseAgyModels(out: string): ModelOption[] {
  return out
    .split(/\r?\n/)
    .map((l) => l.split('\t'))
    .filter((p) => p.length >= 2 && p[0]!.trim() && !/\s/.test(p[0]!.trim()))
    .map(([id, label]) => ({ id: id!.trim(), label: label!.trim() }));
}

const cache = new Map<CliKind, { at: number; models: ModelOption[] }>();
const TTL_MS = 10 * 60_000;

export async function listModels(
  dataDir: string,
  cli: CliKind,
  useAppProfiles = true,
): Promise<{ models: ModelOption[]; source: 'cli' | 'builtin'; error?: string }> {
  if (cli === 'claude') return { models: CLAUDE_MODELS, source: 'builtin' };
  if (cli === 'fake') return { models: FAKE_MODELS, source: 'builtin' };
  const hit = cache.get(cli);
  if (hit && Date.now() - hit.at < TTL_MS) return { models: hit.models, source: 'cli' };
  const { env } = cliEnv(dataDir, cli, useAppProfiles);
  const exe = await locateExecutable(cli === 'codex' ? 'codex' : 'agy', env);
  if (!exe?.launch) return { models: [], source: 'cli', error: 'not installed' };
  const args = cli === 'codex' ? ['debug', 'models'] : ['models'];
  const out = await new Promise<{ ok: boolean; text: string }>((resolve) =>
    execFile(
      exe.launch!.file,
      [...exe.launch!.argsPrefix, ...args],
      { env, windowsHide: true, timeout: 30_000, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => resolve({ ok: !error, text: error ? String(stderr || error.message) : stdout }),
    ),
  );
  if (!out.ok) return { models: [], source: 'cli', error: out.text.slice(0, 300) };
  try {
    const models = cli === 'codex' ? parseCodexModels(out.text) : parseAgyModels(out.text);
    cache.set(cli, { at: Date.now(), models });
    return { models, source: 'cli' };
  } catch (error) {
    return { models: [], source: 'cli', error: String(error).slice(0, 300) };
  }
}

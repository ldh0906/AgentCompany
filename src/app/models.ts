// 직원 채용 화면의 모델 목록. CLI가 목록 명령을 주면 그것을(실측 형식), 없으면 실측해 둔 정확한 모델명을 쓴다.
import { execFile } from 'node:child_process';
import { locateExecutable } from '../runner/locate.ts';
import { cliEnv } from './doctor.ts';
import type { CliKind } from '../core/types.ts';

export interface ModelOption {
  id: string;
  label: string;
  note?: string;
  /** 고를 수 있는 추론 강도. 없으면 effort 선택 없음. */
  efforts?: string[];
  defaultEffort?: string;
  /** effort가 모델 ID의 일부라 반드시 골라야 한다(agy 계열). */
  effortRequired?: boolean;
}

const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']; // 실측: claude --help (2.1.202)

/**
 * Claude Code는 목록 명령이 없다. 별칭이 가리키는 정확한 모델명을 실측해 둔다
 * (2026-09-29, Claude Code 2.1.202: 첫 system/init 이벤트의 model). CLI 기본값은 claude-opus-4-8[1m].
 */
export const CLAUDE_MODELS: ModelOption[] = [
  { id: 'claude-fable-5', label: 'Claude Fable 5', note: 'alias fable', efforts: CLAUDE_EFFORTS },
  { id: 'claude-opus-4-8', label: 'Claude Opus 4.8', note: 'alias opus', efforts: CLAUDE_EFFORTS },
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', note: 'alias sonnet', efforts: CLAUDE_EFFORTS },
  { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5', note: 'alias haiku' },
];
export const CLAUDE_DEFAULT_MODEL = 'claude-opus-4-8[1m]';

export const FAKE_MODELS: ModelOption[] = ['diligent', 'lazy', 'rogue', 'slow', 'tamper'].map((id) => ({ id, label: id }));

/** 실측(0.153.4): `codex debug models` → {"models":[{slug, display_name, description, visibility, default_reasoning_level, supported_reasoning_levels}]} */
export function parseCodexModels(out: string): ModelOption[] {
  const data = JSON.parse(out) as {
    models?: {
      slug?: string;
      display_name?: string;
      description?: string;
      visibility?: string;
      default_reasoning_level?: string;
      supported_reasoning_levels?: { effort?: string }[];
      priority?: number;
    }[];
  };
  // Codex가 매긴 순서(priority 오름차순)대로: 첫 항목이 Codex가 가장 앞에 두는 모델이다.
  return (data.models ?? [])
    .filter((m) => m.slug && m.visibility !== 'hide')
    .sort((a, b) => (a.priority ?? 1e9) - (b.priority ?? 1e9))
    .map((m) => {
      const efforts = (m.supported_reasoning_levels ?? []).map((l) => l.effort).filter((e): e is string => Boolean(e));
      return {
        id: m.slug!,
        label: m.display_name || m.slug!,
        ...(m.description ? { note: m.description } : {}),
        ...(efforts.length ? { efforts } : {}),
        ...(m.default_reasoning_level ? { defaultEffort: m.default_reasoning_level } : {}),
      };
    });
}

const AGY_SUFFIX = /-(low|medium|high)$/;
const AGY_ORDER = ['low', 'medium', 'high'];

/**
 * 실측(1.2.12): `agy models` → 안내 한 줄 뒤에 "ID<TAB>이름" 줄들.
 * 같은 계열의 -low/-medium/-high 변형이 둘 이상이면 계열 하나 + effort 선택으로 묶는다(실행할 때 ID에 다시 붙인다).
 */
export function parseAgyModels(out: string): ModelOption[] {
  const rows = out
    .split(/\r?\n/)
    .map((l) => l.split('\t'))
    .filter((p) => p.length >= 2 && p[0]!.trim() && !/\s/.test(p[0]!.trim()))
    .map(([id, label]) => ({ id: id!.trim(), label: label!.trim() }));
  const families = new Map<string, { label: string; efforts: Set<string> }>();
  for (const r of rows) {
    const m = r.id.match(AGY_SUFFIX);
    if (!m) continue;
    const base = r.id.slice(0, -m[0].length);
    const f = families.get(base) ?? { label: r.label.replace(/\s*\((low|medium|high)\)\s*$/i, ''), efforts: new Set<string>() };
    f.efforts.add(m[1]!);
    families.set(base, f);
  }
  const result: ModelOption[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const m = r.id.match(AGY_SUFFIX);
    const base = m ? r.id.slice(0, -m[0].length) : null;
    const fam = base ? families.get(base) : undefined;
    if (base && fam && fam.efforts.size >= 2) {
      if (seen.has(base)) continue;
      seen.add(base);
      const efforts = AGY_ORDER.filter((e) => fam.efforts.has(e));
      result.push({
        id: base,
        label: fam.label,
        efforts,
        defaultEffort: efforts.includes('medium') ? 'medium' : efforts[0]!,
        effortRequired: true,
      });
    } else result.push(r);
  }
  return result;
}

const cache = new Map<CliKind, { at: number; models: ModelOption[] }>();
const TTL_MS = 10 * 60_000;

export async function listModels(
  dataDir: string,
  cli: CliKind,
  useAppProfiles = true,
): Promise<{ models: ModelOption[]; source: 'cli' | 'builtin'; defaultModel?: string; error?: string }> {
  if (cli === 'claude') return { models: CLAUDE_MODELS, source: 'builtin', defaultModel: CLAUDE_DEFAULT_MODEL };
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

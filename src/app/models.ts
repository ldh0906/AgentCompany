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
  /** 이 모델을 쓰려면 필요한 CLI 최소 버전. */
  minCliVersion?: string;
  /** 지금 설치된 CLI로는 쓸 수 없는 이유(목록에서 잠금). */
  unavailable?: string;
}

const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']; // 실측: claude --help (2.1.202)

/**
 * Claude Code는 목록 명령이 없다. 후보 모델명을 실제로 호출해 확인한 목록
 * (2026-09-30, 앱 전용 프로필, 시스템 프롬프트·도구 없이 한 줄 응답):
 * - Claude Code 2.1.202: Fable 5, Opus 5, Sonnet 5, Opus 4.8/4.7/4.6/4.5, Sonnet 4.6/4.5, Haiku 4.5 동작.
 *   Opus 5.5는 2.1.280+, Fable 5.1은 2.1.251+ 가 필요하다는 400 응답.
 * - Claude Code 2.1.284: 위에 더해 Opus 5.5, Fable 5.1, Sonnet 5.5 동작. 별칭은 opus→claude-opus-5-5,
 *   fable→claude-fable-5-1, sonnet→claude-sonnet-5-5, haiku→claude-haiku-4-5-20251001, 기본값→claude-opus-5-5.
 * - 모두 --effort low/max 를 오류 없이 받았다(지원하지 않는 모델은 CLI가 무시할 수 있다).
 * - claude-opus-4-1 / 4-0 은 실제로 claude-opus-4-8로 실행돼 목록에서 뺐다(오해 방지).
 * - claude-sonnet-4-0, claude-3-x, claude-*-5-1(fable 제외), claude-haiku-5* 등은 "모델이 없거나 접근할 수 없음".
 */
export const CLAUDE_MODELS: ModelOption[] = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', note: 'alias opus', efforts: CLAUDE_EFFORTS, minCliVersion: '2.1.280' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', note: 'alias sonnet', efforts: CLAUDE_EFFORTS },
  { id: 'claude-fable-5-1', label: 'Claude Fable 5.1', note: 'alias fable', efforts: CLAUDE_EFFORTS, minCliVersion: '2.1.251' },
  { id: 'claude-fable-5', label: 'Claude Fable 5', efforts: CLAUDE_EFFORTS },
  { id: 'claude-opus-5', label: 'Claude Opus 5', efforts: CLAUDE_EFFORTS },
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', efforts: CLAUDE_EFFORTS },
  { id: 'claude-opus-4-8', label: 'Claude Opus 4.8', efforts: CLAUDE_EFFORTS },
  { id: 'claude-opus-4-7', label: 'Claude Opus 4.7', efforts: CLAUDE_EFFORTS },
  { id: 'claude-opus-4-6', label: 'Claude Opus 4.6', efforts: CLAUDE_EFFORTS },
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', efforts: CLAUDE_EFFORTS },
  { id: 'claude-opus-4-5', label: 'Claude Opus 4.5', efforts: CLAUDE_EFFORTS },
  { id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5', efforts: CLAUDE_EFFORTS },
  { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5', note: 'alias haiku', efforts: CLAUDE_EFFORTS },
];

/** 모델을 지정하지 않았을 때 CLI가 쓰는 모델(실측): 2.1.280+ 는 claude-opus-5-5, 그 전은 claude-opus-4-8[1m]. */
export function claudeDefaultModel(versionText: string | null): string | undefined {
  const v = versionOf(versionText);
  if (!v) return undefined;
  return lessThan(v, [2, 1, 280]) ? 'claude-opus-4-8[1m]' : 'claude-opus-5-5';
}

/** "2.1.202 (Claude Code)" → [2,1,202] */
function versionOf(text: string | null): number[] | null {
  const m = text?.match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
const lessThan = (a: number[], b: number[]) => (a[0]! - b[0]! || a[1]! - b[1]! || a[2]! - b[2]!) < 0;

/** 설치된 Claude Code 버전보다 새 버전이 필요한 모델을 잠근다. 버전을 모르면 막지 않는다. */
export function annotateClaudeModels(versionText: string | null): ModelOption[] {
  const v = versionOf(versionText);
  return CLAUDE_MODELS.map((m) => {
    const need = versionOf(m.minCliVersion ?? null);
    if (!v || !need || !lessThan(v, need)) return m;
    return { ...m, unavailable: `Claude Code ${m.minCliVersion}+ (installed ${v.join('.')})` };
  });
}

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
  // 목록에서 숨긴 모델(visibility "hide")도 쓸 수 있으므로 넣되, 뒤로 보내고 표시한다.
  return (data.models ?? [])
    .filter((m) => m.slug)
    .sort((a, b) => Number(a.visibility === 'hide') - Number(b.visibility === 'hide') || (a.priority ?? 1e9) - (b.priority ?? 1e9))
    .map((m) => {
      const efforts = (m.supported_reasoning_levels ?? []).map((l) => l.effort).filter((e): e is string => Boolean(e));
      return {
        id: m.slug!,
        label: `${m.display_name || m.slug!}${m.visibility === 'hide' ? ' (hidden)' : ''}`,
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

let claudeVersionCache: { at: number; text: string | null } | null = null;
/** 설치된 Claude Code 버전(claude --version, API 호출 없음). 10분 캐시. */
async function claudeVersion(dataDir: string, useAppProfiles: boolean): Promise<string | null> {
  if (claudeVersionCache && Date.now() - claudeVersionCache.at < TTL_MS) return claudeVersionCache.text;
  const { env } = cliEnv(dataDir, 'claude', useAppProfiles);
  const exe = await locateExecutable('claude', env);
  const text = exe?.launch
    ? await new Promise<string | null>((resolve) =>
        execFile(
          exe.launch!.file,
          [...exe.launch!.argsPrefix, '--version'],
          { env, windowsHide: true, timeout: 20_000, encoding: 'utf8' },
          (error, stdout) => resolve(error ? null : stdout.trim()),
        ),
      )
    : null;
  claudeVersionCache = { at: Date.now(), text };
  return text;
}

const cache = new Map<CliKind, { at: number; models: ModelOption[] }>();
const TTL_MS = 10 * 60_000;

export async function listModels(
  dataDir: string,
  cli: CliKind,
  useAppProfiles = true,
): Promise<{ models: ModelOption[]; source: 'cli' | 'builtin'; defaultModel?: string; error?: string }> {
  if (cli === 'claude') {
    const version = await claudeVersion(dataDir, useAppProfiles);
    const defaultModel = claudeDefaultModel(version);
    return { models: annotateClaudeModels(version), source: 'builtin', ...(defaultModel ? { defaultModel } : {}) };
  }
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

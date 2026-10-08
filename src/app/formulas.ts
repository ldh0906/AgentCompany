// 작업 흐름(formula): 기능 추가·버그 수정·리팩터링처럼 정해진 절차를 비서실장이 틀로 쓴다(Gas Town의 Formulas).
// 비서실장은 단계마다 업무를 만들고 쓰기 범위·세부를 채운다. 코드는 단계가 빠지거나 순서가 틀린 초안을 거부하고,
// 단계별 필수 요구사항과 단계 순서(앞 단계에 의존)를 직접 넣는다. 내장 흐름은 formulas/*.yaml.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TicketDraft } from '../agents/report.ts';
import type { EvidenceType } from '../core/types.ts';
import { parseYaml, type Yaml } from '../cli/yaml.ts';

export interface FormulaStep {
  key: string;
  title: string;
  type: 'impl' | 'doc';
  guide: string;
  requirements: { text: string; evidenceType: EvidenceType }[];
}

export interface Formula {
  name: string;
  title: string;
  description: string;
  steps: FormulaStep[];
}

const EVIDENCE: readonly EvidenceType[] = ['inspection', 'static_check', 'unit_test', 'runtime', 'human_attest'];

function formulasDir(): string {
  // src/app → ../../formulas, dist/app → ../../formulas
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'formulas');
}

export function parseFormula(src: string, where: string): Formula {
  const fail = (m: string): never => {
    throw new Error(`${where}: ${m}`);
  };
  const y = parseYaml(src);
  if (!y || typeof y !== 'object' || Array.isArray(y)) fail('name, steps가 있는 맵이어야 합니다.');
  const o = y as { [k: string]: Yaml };
  if (typeof o.name !== 'string' || !/^[a-z0-9-]+$/.test(o.name)) fail('name은 영문 소문자·숫자·-만 씁니다.');
  if (!Array.isArray(o.steps) || !o.steps.length) fail('steps가 비어 있습니다.');
  const steps = (o.steps as Yaml[]).map((x, i): FormulaStep => {
    const s = (x && typeof x === 'object' && !Array.isArray(x) ? x : fail(`steps ${i + 1}: 맵이어야 합니다.`)) as { [k: string]: Yaml };
    const key = typeof s.key === 'string' && /^[a-z0-9-]+$/.test(s.key) ? s.key : fail(`steps ${i + 1}: key(영문 소문자)가 필요합니다.`);
    const type = s.type === 'doc' ? 'doc' : s.type === 'impl' || s.type === undefined ? 'impl' : fail(`${key}: type은 impl | doc`);
    const reqs = (Array.isArray(s.requirements) ? s.requirements : []).map((r, j) => {
      const q = (r && typeof r === 'object' && !Array.isArray(r) ? r : {}) as { [k: string]: Yaml };
      const ev = String(q.evidence ?? 'inspection');
      if (typeof q.text !== 'string' || !q.text.trim()) fail(`${key} 요구사항 ${j + 1}: text가 없습니다.`);
      if (!EVIDENCE.includes(ev as EvidenceType)) fail(`${key} 요구사항 ${j + 1}: evidence는 ${EVIDENCE.join(' | ')}`);
      return { text: String(q.text).trim(), evidenceType: ev as EvidenceType };
    });
    return {
      key,
      title: typeof s.title === 'string' ? s.title : key,
      type,
      guide: typeof s.guide === 'string' ? s.guide : '',
      requirements: reqs,
    };
  });
  if (new Set(steps.map((s) => s.key)).size !== steps.length) fail('같은 key의 단계가 있습니다.');
  return {
    name: o.name as string,
    title: typeof o.title === 'string' ? o.title : (o.name as string),
    description: typeof o.description === 'string' ? o.description : '',
    steps,
  };
}

export function builtInFormulas(): Formula[] {
  const dir = formulasDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.yaml'))
    .sort()
    .map((f) => parseFormula(readFileSync(path.join(dir, f), 'utf8'), f));
}

export function formulaByName(name: string): Formula | null {
  return builtInFormulas().find((f) => f.name === name) ?? null;
}

/**
 * 초안이 흐름을 따르는지: 모든 단계에 업무가 하나 이상 있고, 단계 순서대로(앞 단계의 업무가 모두 먼저) 놓였는지.
 * 단계 없는 업무는 맨 앞의 공유 계약 업무만 허용한다. 맞으면 null, 아니면 이유.
 */
export function checkFormulaDrafts(f: Formula, drafts: Pick<TicketDraft, 'step' | 'contract'>[]): string | null {
  let at = 0;
  const seen = new Set<string>();
  for (const [i, d] of drafts.entries()) {
    if (!d.step) {
      if (i === 0 && d.contract) continue;
      return `초안 ${i + 1}에 단계(step)가 없습니다.`;
    }
    const k = f.steps.findIndex((s) => s.key === d.step);
    if (k < 0) return `초안 ${i + 1}의 단계 "${d.step}"는 이 흐름에 없습니다.`;
    if (k < at) return `초안 ${i + 1}("${d.step}")이 앞 단계보다 뒤에 와야 하는데 앞에 있습니다.`;
    at = k;
    seen.add(d.step);
  }
  const missing = f.steps.filter((s) => !seen.has(s.key));
  return missing.length ? `빠진 단계: ${missing.map((s) => `${s.title}(${s.key})`).join(', ')}` : null;
}

/**
 * 흐름을 초안에 입힌다: 단계의 업무 종류, 필수 요구사항(이미 있으면 그대로), 앞 단계 업무 모두에 의존.
 * 프로젝트가 만들 수 없는 증거(그 종류의 검사 명령이 없음)는 검수자 판단(inspection)으로 낮춘다(영영 멈추지 않게).
 */
export function applyFormula(f: Formula, drafts: TicketDraft[], verifyTypes: Set<string>): TicketDraft[] {
  const stepOf = (d: TicketDraft) => f.steps.findIndex((s) => s.key === d.step);
  const machine = new Set(['unit_test', 'static_check', 'runtime']);
  return drafts.map((d, i) => {
    const k = stepOf(d);
    if (k < 0) return d;
    const step = f.steps[k]!;
    const have = new Set(d.requirements.map((r) => r.text.trim()));
    const added = step.requirements
      .filter((r) => !have.has(r.text))
      .map((r) => ({
        text: r.text,
        evidenceType: machine.has(r.evidenceType) && !verifyTypes.has(r.evidenceType) ? 'inspection' : r.evidenceType,
      }));
    const before = drafts.flatMap((x, j) => (j < i && stepOf(x) === k - 1 ? [j] : []));
    return {
      ...d,
      type: step.type,
      requirements: [...added, ...d.requirements],
      dependsOn: [...new Set([...d.dependsOn, ...before])].sort((a, b) => a - b),
    };
  });
}

/** 비서실장 지시에 넣을 흐름 설명 */
export function formulaBlock(f: Formula): string {
  const steps = f.steps
    .map(
      (s, i) =>
        `${i + 1}. "${s.key}" — ${s.title} [${s.type}]: ${s.guide}${s.requirements.length ? `\n   Required (added by the system): ${s.requirements.map((r) => `${r.text} [${r.evidenceType}]`).join(' / ')}` : ''}`,
    )
    .join('\n');
  return `## Workflow formula: ${f.title} (chosen by the CEO, required)
Follow these steps in order. Put "step": "<key>" on every ticket. A step may have several tickets (independent parts), but every step needs at least one, and all tickets of a step come before the next step. The only ticket allowed without a step is a first shared-contract ticket. The system adds each step's required requirements and makes each step depend on the previous one; you choose the titles, purposes, extra requirements and write scopes from the repository. A draft that skips a step is rejected.
${steps}
`;
}

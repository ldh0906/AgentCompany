// 직원 보고서: 실행 마지막에 nonce가 들어간 JSON을 내야 한다. 형식은 코드로 검증한다.
// 보고서는 "주장"일 뿐이다. 완료 판정은 오케스트레이터가 만든 증거로 한다.
import { tr } from '../core/i18n.ts';

export interface WorkReport {
  kind: 'work';
  nonce: string;
  status: 'done' | 'blocked' | 'needs_decision';
  summary: string;
  requirements: { id: string; claim: 'met' | 'partial' | 'not_met'; notes: string }[];
  questions: string[];
}

export interface ReviewReport {
  kind: 'review';
  nonce: string;
  verdict: 'approve' | 'request_changes';
  summary: string;
  requirements: { id: string; met: boolean; evidenceIds: string[]; reason: string }[];
}

export type AgentReport = WorkReport | ReviewReport;

export type ReportParse =
  { ok: true; report: AgentReport } | { ok: false; reason: 'no_json' | 'schema_invalid' | 'nonce_mismatch'; detail: string };

/** 최종 텍스트에서 마지막 JSON 객체를 찾는다(```json 블록 우선). */
export function extractLastJson(text: string): unknown | null {
  const fenced = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)\n```/g)].map((m) => m[1]!);
  for (const block of fenced.reverse()) {
    try {
      return JSON.parse(block);
    } catch {
      /* 다음 후보 */
    }
  }
  // 코드 블록이 없으면 마지막 '{'부터 균형 잡힌 객체를 찾는다.
  for (let start = text.lastIndexOf('{'); start >= 0; start = text.lastIndexOf('{', start - 1)) {
    const candidate = balancedObject(text, start);
    if (candidate) {
      try {
        return JSON.parse(candidate);
      } catch {
        /* 계속 */
      }
    }
    if (start === 0) break;
  }
  return null;
}

function balancedObject(text: string, start: number): string | null {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

const isStr = (v: unknown): v is string => typeof v === 'string';
const isArr = Array.isArray;

export function parseReport(
  finalText: string | null,
  expected: { kind: 'work' | 'review'; nonce: string; requirementIds: string[] },
): ReportParse {
  if (!finalText) return { ok: false, reason: 'no_json', detail: tr('최종 응답이 없습니다.', 'No final response.') };
  const raw = extractLastJson(finalText);
  if (!raw || typeof raw !== 'object')
    return {
      ok: false,
      reason: 'no_json',
      detail: tr('최종 응답에서 JSON 보고서를 찾지 못했습니다.', 'No JSON report found in the final response.'),
    };
  const r = raw as Record<string, unknown>;
  if (r.nonce !== expected.nonce) {
    return {
      ok: false,
      reason: 'nonce_mismatch',
      detail: tr(
        `보고서 nonce 불일치(기대 ${expected.nonce}, 받음 ${String(r.nonce)}). 다른 실행의 결과이거나 지시를 따르지 않았습니다.`,
        `Report nonce mismatch (expected ${expected.nonce}, got ${String(r.nonce)}). The result belongs to another run or did not follow instructions.`,
      ),
    };
  }
  const bad = (detail: string): ReportParse => ({ ok: false, reason: 'schema_invalid', detail });
  if (!isStr(r.summary)) return bad(tr('summary가 문자열이 아닙니다.', 'summary must be a string.'));
  if (!isArr(r.requirements)) return bad(tr('requirements가 배열이 아닙니다.', 'requirements must be an array.'));
  const ids = new Set<string>();

  if (expected.kind === 'work') {
    if (!['done', 'blocked', 'needs_decision'].includes(String(r.status))) return bad(tr('status 값이 잘못되었습니다.', 'Invalid status.'));
    const reqs: WorkReport['requirements'] = [];
    for (const x of r.requirements as unknown[]) {
      const q = x as Record<string, unknown>;
      if (!isStr(q?.id) || !['met', 'partial', 'not_met'].includes(String(q.claim)))
        return bad(tr('requirements 항목 형식이 잘못되었습니다.', 'Invalid requirements entry.'));
      ids.add(q.id);
      reqs.push({ id: q.id, claim: q.claim as WorkReport['requirements'][number]['claim'], notes: isStr(q.notes) ? q.notes : '' });
    }
    const missing = expected.requirementIds.filter((id) => !ids.has(id));
    if (missing.length)
      return bad(tr(`보고서에 요구사항 ${missing.join(', ')}이(가) 없습니다.`, `Report is missing requirements: ${missing.join(', ')}.`));
    const questions = isArr(r.questions) ? (r.questions as unknown[]).filter(isStr) : [];
    return {
      ok: true,
      report: {
        kind: 'work',
        nonce: expected.nonce,
        status: r.status as WorkReport['status'],
        summary: r.summary,
        requirements: reqs,
        questions,
      },
    };
  }

  if (!['approve', 'request_changes'].includes(String(r.verdict))) return bad(tr('verdict 값이 잘못되었습니다.', 'Invalid verdict.'));
  const reqs: ReviewReport['requirements'] = [];
  for (const x of r.requirements as unknown[]) {
    const q = x as Record<string, unknown>;
    if (!isStr(q?.id) || typeof q.met !== 'boolean')
      return bad(tr('requirements 항목 형식이 잘못되었습니다.', 'Invalid requirements entry.'));
    ids.add(q.id);
    reqs.push({
      id: q.id,
      met: q.met,
      evidenceIds: isArr(q.evidenceIds) ? (q.evidenceIds as unknown[]).filter(isStr) : [],
      reason: isStr(q.reason) ? q.reason : '',
    });
  }
  const missing = expected.requirementIds.filter((id) => !ids.has(id));
  if (missing.length)
    return bad(tr(`판정에 요구사항 ${missing.join(', ')}이(가) 없습니다.`, `Verdict is missing requirements: ${missing.join(', ')}.`));
  return {
    ok: true,
    report: {
      kind: 'review',
      nonce: expected.nonce,
      verdict: r.verdict as ReviewReport['verdict'],
      summary: r.summary,
      requirements: reqs,
    },
  };
}

// ---- 비서실장 티켓 초안 ----

export interface TicketDraft {
  type: 'impl' | 'doc' | 'review' | 'research';
  title: string;
  purpose: string;
  requirements: { text: string; evidenceType: string }[];
  doneCriteria: string;
  writeScope: string[];
  dependsOn: number[]; // 같은 초안 목록 안의 앞선 인덱스
}

export interface DraftReport {
  kind: 'drafts';
  nonce: string;
  summary: string;
  tickets: TicketDraft[];
  questions: string[];
}

const DRAFT_TYPES = ['impl', 'doc', 'review', 'research'];
const DRAFT_EVIDENCE = ['mockup', 'inspection', 'static_check', 'unit_test', 'runtime', 'human_attest'];

export function parseDrafts(
  finalText: string | null,
  nonce: string,
): { ok: true; report: DraftReport } | { ok: false; reason: 'no_json' | 'nonce_mismatch' | 'schema_invalid'; detail: string } {
  if (!finalText) return { ok: false, reason: 'no_json', detail: tr('최종 응답이 없습니다.', 'No final response.') };
  const raw = extractLastJson(finalText) as Record<string, unknown> | null;
  if (!raw || typeof raw !== 'object')
    return { ok: false, reason: 'no_json', detail: tr('JSON 초안을 찾지 못했습니다.', 'No JSON draft found.') };
  if (raw.nonce !== nonce) return { ok: false, reason: 'nonce_mismatch', detail: tr('nonce 불일치', 'nonce mismatch') };
  if (!Array.isArray(raw.tickets) || raw.tickets.length === 0 || raw.tickets.length > 12) {
    return {
      ok: false,
      reason: 'schema_invalid',
      detail: tr('tickets는 1~12개 배열이어야 합니다.', 'tickets must be an array of 1–12 items.'),
    };
  }
  const tickets: TicketDraft[] = [];
  for (const [i, x] of (raw.tickets as unknown[]).entries()) {
    const d = x as Record<string, unknown>;
    const type = String(d.type);
    const reqs = Array.isArray(d.requirements) ? (d.requirements as Record<string, unknown>[]) : [];
    if (!DRAFT_TYPES.includes(type) || !isStr(d.title) || !d.title.trim() || !reqs.length) {
      return {
        ok: false,
        reason: 'schema_invalid',
        detail: tr(`초안 ${i + 1}의 형식이 잘못되었습니다.`, `Invalid format for draft ${i + 1}.`),
      };
    }
    const writeScope = Array.isArray(d.writeScope) ? (d.writeScope as unknown[]).filter(isStr) : [];
    if ((type === 'impl' || type === 'doc') && !writeScope.length) {
      return {
        ok: false,
        reason: 'schema_invalid',
        detail: tr(`초안 ${i + 1}에 쓰기 범위가 없습니다.`, `Draft ${i + 1} has no write scope.`),
      };
    }
    tickets.push({
      type: type as TicketDraft['type'],
      title: d.title.slice(0, 200),
      purpose: isStr(d.purpose) ? d.purpose : '',
      requirements: reqs
        .map((r) => ({
          text: String(r.text ?? '').slice(0, 2000),
          evidenceType: DRAFT_EVIDENCE.includes(String(r.evidenceType)) ? String(r.evidenceType) : 'inspection',
        }))
        .filter((r) => r.text),
      doneCriteria: isStr(d.doneCriteria) && d.doneCriteria ? d.doneCriteria : '요구사항 충족',
      writeScope,
      dependsOn: Array.isArray(d.dependsOn)
        ? (d.dependsOn as unknown[]).map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n < i)
        : [],
    });
  }
  return {
    ok: true,
    report: {
      kind: 'drafts',
      nonce,
      summary: isStr(raw.summary) ? raw.summary : '',
      tickets,
      questions: Array.isArray(raw.questions) ? (raw.questions as unknown[]).filter(isStr) : [],
    },
  };
}

// 직원 보고서: 실행 마지막에 nonce가 들어간 JSON을 내야 한다. 형식은 코드로 검증한다.
// 보고서는 "주장"일 뿐이다. 완료 판정은 오케스트레이터가 만든 증거로 한다.
import { tr } from '../core/i18n.ts';
import { DELIVERABLE_KINDS, DIFFICULTIES, type DeliverableKind, type Difficulty, type ProjectProfile } from '../core/types.ts';

export interface WorkReport {
  kind: 'work';
  nonce: string;
  status: 'done' | 'blocked' | 'needs_decision';
  summary: string;
  requirements: { id: string; claim: 'met' | 'partial' | 'not_met'; notes: string }[];
  questions: string[];
  /** 전권 위임 중 직원이 멈추지 않고 스스로 정한 것(무엇을, 왜) */
  assumed?: string[];
  /** 내 범위 밖에서 발견한 문제: 대표가 후속 업무로 만들 수 있게 업무방에 올린다. */
  followUps?: { title: string; reason: string }[];
  /** 다른 직원에게 묻는 말(이름). 업무방에 올라가고 그 직원이 답한다. */
  ask?: { to: string; text: string }[];
  /** 대표 직접 확인 요구사항을 기계가 화면에서 보여 줄 순서(자동 화면 점검이 그대로 따라 한다). */
  screenSteps?: ScreenScenario[];
  /** 혼자 하기엔 크다고 판단하면: 나눌 부분(2~4개). 다른 직원이 나눠 맡고, 끝나면 이 업무가 돌아와 마무리한다. */
  split?: SplitPart[];
  /** 범위 밖 파일을 꼭 고쳐야 할 때(예: 옛 동작을 기대하는 기존 테스트): 대표가 한 번에 허용할 수 있게 요청한다. */
  needScope?: { paths: string[]; reason: string } | null;
  /** 대표가 열어 볼 페이지(맨 위 index.html이나 dev 서버가 아닐 때, 예: src/sound/demo.html) */
  previewPage?: string | null;
}

export interface SplitPart {
  title: string;
  purpose: string;
  requirements: { text: string; evidenceType: string }[];
  writeScope: string[];
  difficulty: Difficulty;
}

/** 자동 화면 점검 한 단계. 좌표 대신 글자·선택자로 누를 수 있게 한다(직원은 화면 픽셀을 모른다). */
export type ScreenStep =
  | { do: 'key'; key: string; holdMs?: number; times?: number }
  | { do: 'click'; text?: string; selector?: string; x?: number; y?: number }
  | { do: 'type'; text: string }
  | { do: 'wait'; ms: number }
  | { do: 'reload' }
  /** 같은 앱을 다른 주소로 연다(예: "?check=boss" 같은 빠른 확인 모드). 다른 사이트로는 가지 않는다. */
  | { do: 'open'; path: string }
  /** 저장된 데이터가 필요한 확인(예: 새로고침 뒤 최고 점수)을 위해 localStorage에 값을 넣는다. */
  | { do: 'setStorage'; key: string; value: string }
  | { do: 'shot'; label: string };

export interface ScreenScenario {
  requirementId: string;
  steps: ScreenStep[];
}

export interface ReviewReport {
  kind: 'review';
  nonce: string;
  verdict: 'approve' | 'request_changes';
  summary: string;
  requirements: { id: string; met: boolean; evidenceIds: string[]; reason: string }[];
  /** 이 업무 범위 밖에서 발견한 문제(대표가 후속 업무로 만들 수 있게) */
  followUps?: { title: string; reason: string }[];
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
        assumed: (isArr(r.assumed) ? (r.assumed as unknown[]).filter(isStr) : []).slice(0, 10).map((s) => s.slice(0, 500)),
        followUps: (isArr(r.followUps) ? (r.followUps as Record<string, unknown>[]) : [])
          .filter((f) => isStr(f?.title) && f.title.trim())
          .slice(0, 5)
          .map((f) => ({ title: String(f.title).slice(0, 200), reason: isStr(f.reason) ? f.reason.slice(0, 2000) : '' })),
        ask: (isArr(r.ask) ? (r.ask as Record<string, unknown>[]) : [])
          .filter((a) => isStr(a?.to) && isStr(a?.text) && a.text.trim())
          .slice(0, 3)
          .map((a) => ({ to: String(a.to).replace(/^@/, '').slice(0, 60), text: String(a.text).slice(0, 2000) })),
        screenSteps: screenStepsOf(r.screenSteps, expected.requirementIds),
        split: splitOf(r.split),
        needScope: needScopeOf(r.needScope),
        previewPage: pageOf(r.previewPage),
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
      followUps: followUpsOf(r.followUps),
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
  difficulty: Difficulty; // 비서실장 제안. 모르는 값은 보통
}

/** 비서실장이 제안하는 검증 명령: 요구사항에 필요한 검사를 프로젝트가 아직 못 돌릴 때(예: 타입 검사). */
export interface VerifySuggestion {
  label: string;
  argv: string[];
  evidenceType: 'static_check' | 'unit_test' | 'runtime';
}

export interface DraftReport {
  kind: 'drafts';
  nonce: string;
  summary: string;
  tickets: TicketDraft[];
  questions: string[];
  /** questions와 같은 순서: 비서실장이 제안하는 기본 답(대표가 한 번에 받아들일 수 있게). */
  proposals: (string | null)[];
  verifySuggestions: VerifySuggestion[];
  /** 프로젝트 프로필이 없을 때 비서실장이 제안하는 프로필 */
  profile?: ProjectProfile | null;
  /** 만들기 전에 팀이 토론할 큰 갈림길(드물게) */
  debate?: { topic: string; why: string } | null;
  /** 요청 전체의 인수 시험(V모델 꼭대기): 업무가 다 끝나면 반영된 결과로 확인한다 */
  acceptance?: { id: string; check: string; how: string }[];
}

/** 프로필 제안: 한두 줄 요약이 있을 때만. */
export function profileOf(v: unknown): ProjectProfile | null {
  const o = v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  if (!o || !isStr(o.summary) || !o.summary.trim()) return null;
  const deliverable = (DELIVERABLE_KINDS as readonly string[]).includes(String(o.deliverable))
    ? (o.deliverable as DeliverableKind)
    : 'screen';
  // 화면이 없는 결과물에는 휴대폰·게임 점검이 의미가 없다.
  const screen = deliverable === 'screen';
  return { summary: o.summary.trim().slice(0, 300), mobile: screen && o.mobile === true, game: screen && o.game === true, deliverable };
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
    const scope = Array.isArray(d.writeScope) ? (d.writeScope as unknown[]).filter(isStr) : [];
    // 조사 결과는 보고서 파일로 남긴다(대표가 앱에서 읽고, 시스템이 링크를 확인한다). 범위를 빠뜨리면 기본 폴더를 준다.
    const writeScope = type === 'research' && !scope.length ? ['research/**'] : scope;
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
      difficulty: (DIFFICULTIES as readonly string[]).includes(String(d.difficulty)) ? (d.difficulty as Difficulty) : 'normal',
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
      ...questionsOf(raw.questions),
      verifySuggestions: suggestionsOf(raw.verifySuggestions),
      profile: profileOf(raw.profile),
      debate: debateOf(raw.debate),
      acceptance: acceptanceOf(raw.acceptance),
    },
  };
}

function acceptanceOf(v: unknown): { id: string; check: string; how: string }[] {
  return (Array.isArray(v) ? (v as Record<string, unknown>[]) : [])
    .filter((x) => isStr(x?.check) && x.check.trim())
    .slice(0, 8)
    .map((x, i) => ({ id: `A${i + 1}`, check: String(x.check).slice(0, 500), how: isStr(x.how) ? x.how.slice(0, 500) : '' }));
}

function debateOf(v: unknown): { topic: string; why: string } | null {
  const o = v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  if (!o || !isStr(o.topic) || !o.topic.trim()) return null;
  return { topic: o.topic.trim().slice(0, 300), why: isStr(o.why) ? o.why.slice(0, 1000) : '' };
}

/** 질문은 문자열이나 {question, proposal}. */
function questionsOf(v: unknown): { questions: string[]; proposals: (string | null)[] } {
  const questions: string[] = [];
  const proposals: (string | null)[] = [];
  for (const q of Array.isArray(v) ? v : []) {
    if (isStr(q) && q.trim()) {
      questions.push(q.slice(0, 1000));
      proposals.push(null);
    } else if (q && typeof q === 'object' && isStr((q as Record<string, unknown>).question)) {
      const o = q as Record<string, unknown>;
      questions.push(String(o.question).slice(0, 1000));
      proposals.push(isStr(o.proposal) && o.proposal.trim() ? o.proposal.slice(0, 1000) : null);
    }
  }
  return { questions: questions.slice(0, 20), proposals: proposals.slice(0, 20) };
}

const SUGGEST_TYPES = ['static_check', 'unit_test', 'runtime'];
const SHELL_META = /[;&|`$<>(){}\n]/;

function suggestionsOf(v: unknown): VerifySuggestion[] {
  const out: VerifySuggestion[] = [];
  for (const x of Array.isArray(v) ? v : []) {
    const o = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
    const cmd = isStr(o.command) ? o.command.trim() : Array.isArray(o.argv) ? (o.argv as unknown[]).filter(isStr).join(' ') : '';
    if (!cmd || SHELL_META.test(cmd) || !SUGGEST_TYPES.includes(String(o.evidenceType))) continue;
    out.push({
      label: isStr(o.label) && o.label.trim() ? o.label.slice(0, 60) : cmd.split(/\s+/).slice(0, 3).join(' '),
      argv: cmd.split(/\s+/),
      evidenceType: o.evidenceType as VerifySuggestion['evidenceType'],
    });
  }
  return out.slice(0, 5);
}

const num = (v: unknown, min: number, max: number): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : undefined;

/** 화면 점검 순서: 너그럽게 읽되 모르는 단계는 버리고, 길이·시간에 상한을 둔다. */
export function screenStepsOf(v: unknown, requirementIds: string[]): ScreenScenario[] {
  const out: ScreenScenario[] = [];
  let list = isArr(v) ? (v as Record<string, unknown>[]) : [];
  // 실측(2026-09-30, Codex): 요구사항 없이 단계만 나열했다. 한 순서로 받아 '*'(어느 요구사항인지 모름)로 둔다.
  if (list.length && list.every((x) => isStr(x?.do))) list = [{ requirementId: '*', steps: list }];
  for (const x of list) {
    if (!isStr(x?.requirementId) || !(x.requirementId === '*' || requirementIds.includes(x.requirementId)) || !isArr(x.steps)) continue;
    const steps: ScreenStep[] = [];
    for (const s of x.steps as Record<string, unknown>[]) {
      const d = s?.do;
      if (d === 'key' && isStr(s.key) && /^[A-Za-z0-9]{1,20}$/.test(s.key))
        steps.push({ do: 'key', key: s.key, holdMs: num(s.holdMs, 0, 5000), times: num(s.times, 1, 50) });
      else if (d === 'click' && (isStr(s.text) || isStr(s.selector) || (typeof s.x === 'number' && typeof s.y === 'number')))
        steps.push({
          do: 'click',
          ...(isStr(s.text) ? { text: s.text.slice(0, 100) } : {}),
          ...(isStr(s.selector) ? { selector: s.selector.slice(0, 200) } : {}),
          ...(typeof s.x === 'number' ? { x: num(s.x, 0, 1)!, y: num(s.y, 0, 1)! } : {}),
        });
      else if (d === 'type' && isStr(s.text)) steps.push({ do: 'type', text: s.text.slice(0, 200) });
      else if (d === 'wait') steps.push({ do: 'wait', ms: num(s.ms, 0, 10_000) ?? 500 });
      else if (d === 'reload') steps.push({ do: 'reload' });
      else if (d === 'open' && isStr(s.path) && !/^[a-z][a-z0-9+.-]*:|^\/\//i.test(s.path.trim()))
        steps.push({ do: 'open', path: s.path.trim().slice(0, 300) });
      else if (d === 'setStorage' && isStr(s.key) && isStr(s.value))
        steps.push({ do: 'setStorage', key: s.key.slice(0, 200), value: s.value.slice(0, 5000) });
      else if (d === 'shot') steps.push({ do: 'shot', label: isStr(s.label) ? s.label.slice(0, 80) : '' });
    }
    if (steps.some((s) => s.do === 'shot')) out.push({ requirementId: x.requirementId, steps: steps.slice(0, 30) });
  }
  return out.slice(0, 6);
}

/** 범위 요청: 상대 경로만(절대 경로·상위 폴더·와일드카드 전체는 거부), 최대 5개. */
export function needScopeOf(v: unknown): { paths: string[]; reason: string } | null {
  const o = v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  const paths = (isArr(o?.paths) ? (o!.paths as unknown[]) : [])
    .filter(isStr)
    .map((p) => p.trim().replaceAll('\\', '/'))
    .filter((p) => p && !p.startsWith('/') && !/^[A-Za-z]:/.test(p) && !p.split('/').includes('..') && p !== '**' && p !== '*')
    .slice(0, 5);
  return paths.length ? { paths, reason: isStr(o?.reason) ? o!.reason.slice(0, 1000) : '' } : null;
}

const EVIDENCE_TYPES = ['mockup', 'inspection', 'static_check', 'unit_test', 'runtime', 'human_attest'];

/** 나눌 부분: 너그럽게 읽되 제목·요구사항·쓰기 범위가 없는 것은 버린다. 어려움은 보통으로 낮춘다(선임도 맡게). 2~4개일 때만. */
export function splitOf(v: unknown): SplitPart[] {
  const parts = (isArr(v) ? (v as Record<string, unknown>[]) : [])
    .map((p) => ({
      title: isStr(p?.title) ? p.title.trim().slice(0, 120) : '',
      purpose: isStr(p?.purpose) ? p.purpose.slice(0, 1000) : '',
      requirements: (isArr(p?.requirements) ? (p.requirements as Record<string, unknown>[]) : [])
        .filter((q) => isStr(q?.text) && q.text.trim())
        .slice(0, 8)
        .map((q) => ({
          text: String(q.text).slice(0, 1000),
          evidenceType: EVIDENCE_TYPES.includes(String(q.evidenceType)) ? String(q.evidenceType) : 'inspection',
        })),
      writeScope: (isArr(p?.writeScope) ? (p.writeScope as unknown[]) : []).filter(isStr).slice(0, 10),
      difficulty: (p?.difficulty === 'easy' ? 'easy' : 'normal') as Difficulty,
    }))
    .filter((p) => p.title && p.requirements.length && p.writeScope.length)
    .slice(0, 4);
  return parts.length >= 2 ? parts : [];
}

function followUpsOf(v: unknown): { title: string; reason: string }[] {
  return (isArr(v) ? (v as Record<string, unknown>[]) : [])
    .filter((f) => isStr(f?.title) && f.title.trim())
    .slice(0, 5)
    .map((f) => ({ title: String(f.title).slice(0, 200), reason: isStr(f.reason) ? f.reason.slice(0, 2000) : '' }));
}

/**
 * 요약 글에서 범위 밖·후속 문제를 찾는다(직원이 followUps 칸을 안 채워도 잡아내려고).
 * 실측: "범위 밖 참고: README는 쓰기 범위 밖이라 갱신하지 않았으니 필요하면 후속 티켓으로" 같은 문장이 요약에만 있었다.
 */
export function followUpsFromSummary(summary: string): { title: string; reason: string }[] {
  const sentences = summary
    .split(/(?<=[.!?。])\s+|\n+/)
    .map((x) => x.trim())
    .filter(Boolean);
  return sentences
    .filter((x) => /범위 밖|후속 (티켓|업무)|별도 (티켓|업무)|out of scope|follow-?up/i.test(x))
    .slice(0, 3)
    .map((x) => ({ title: x.replace(/^(범위 밖 참고|참고)\s*[:：]\s*/, '').slice(0, 80), reason: x.slice(0, 1000) }));
}

export interface ChatReply {
  reply: string;
  /** 부르는 동료 이름 */
  mentions: string[];
  openRoom: { name: string; members: string[]; topic: string; message: string } | null;
  /** 대화에서 프로젝트 성격이 바뀌었을 때 직원이 제안하는 새 프로필(대표가 반영) */
  profile?: ProjectProfile | null;
}

/**
 * 대화 답장. 대화는 결과물이 아니므로 관대하게 읽는다: JSON이 있으면 쓰고(nonce가 맞아야 함),
 * 없으면 최종 응답 본문을 그대로 답으로 쓴다.
 */
export function parseChatReply(finalText: string | null, nonce: string): ChatReply | null {
  if (!finalText?.trim()) return null;
  const raw = extractLastJson(finalText) as Record<string, unknown> | null;
  if (raw && typeof raw === 'object' && raw.nonce === nonce && isStr(raw.reply) && raw.reply.trim()) {
    const room = raw.openRoom as Record<string, unknown> | null;
    return {
      reply: raw.reply.slice(0, 6000),
      mentions: isArr(raw.mentions)
        ? (raw.mentions as unknown[])
            .filter(isStr)
            .map((m) => m.replace(/^@/, ''))
            .slice(0, 5)
        : [],
      openRoom:
        room && typeof room === 'object' && isStr(room.name) && isArr(room.members)
          ? {
              name: room.name.slice(0, 60),
              members: (room.members as unknown[])
                .filter(isStr)
                .map((m) => m.replace(/^@/, ''))
                .slice(0, 8),
              topic: isStr(room.topic) ? room.topic.slice(0, 300) : '',
              message: isStr(room.message) ? room.message.slice(0, 4000) : '',
            }
          : null,
      profile: profileOf(raw.profile),
    };
  }
  // JSON 없이 답만 한 경우: 코드 블록을 떼고 본문만.
  const text = finalText.replace(/```[\s\S]*?```/g, '').trim();
  return text ? { reply: text.slice(0, 6000), mentions: [], openRoom: null } : null;
}

/** 열어 볼 페이지 경로: 폴더 안의 상대 경로 .html만(밖으로 나가는 경로는 버린다). */
export function pageOf(v: unknown): string | null {
  if (!isStr(v)) return null;
  const p = v.trim().replaceAll('\\', '/').replace(/^\.\//, '');
  if (!p || p.startsWith('/') || /^[a-z]:/i.test(p) || p.split('/').includes('..') || !/\.html?$/i.test(p)) return null;
  return p.slice(0, 300);
}

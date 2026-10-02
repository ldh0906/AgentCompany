// 전권 위임 모드: 대표가 맡기면 최고 직급 직원이 대표 할 일을 대신 처리한다.
// 대표 요청(2026-10-02): "나는 최고 권한자에게 선택을 다 맡기는 전권 위임 모드가 있으면 좋겠다." 범위는 "전부".
// - 초안 확정(질문은 제안대로, 필요한 검사 명령 추가), 직원 질문에 답(팀장이 직접 판단), 예산 늘리기(업무당 2번까지),
//   범위 허락(보호 파일 제외), 반영 승인(대표 직접 확인은 QA 의견으로: ✅는 대신 확인, ❓는 대표 "나중에 확인"으로 남김).
// - 막지 못하는 것: 시스템 검증 실패, 보호 파일, 하루 한도(회사 일시정지), 원본·git 조작. 상태기계와 검사는 그대로다.
// - 모든 결정은 "위임 결정" 기록으로 남기고 업무방에 알린다(대표는 기록만 읽는다).
import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { buildDelegateDecisionPrompt } from '../agents/prompt.ts';
import { extractLastJson, type VerifySuggestion } from '../agents/report.ts';
import { tr } from '../core/i18n.ts';
import type { Approval, Employee, Project, Ticket } from '../core/types.ts';
import { DEFAULT_BUDGET, RANK_ORDER, deliverableOf, rankOf } from '../core/types.ts';
import { verdictsOf } from '../core/verdicts.ts';
import type { OrchHost } from './orch-host.ts';
import type { CeoRequest, RunRecord } from './records.ts';

export interface DelegationHost extends OrchHost {
  nameOf(id: string): string;
  acceptRequest(requestId: string): Ticket[];
  answerTicket(ticketId: string, answer: string | null, remember: boolean): Ticket;
  raiseTokenBudget(ticketId: string): Ticket;
  addWriteScope(ticketId: string, paths: string[]): Ticket;
  resolveScopeHold(ticketId: string, allow: boolean): Ticket;
  decideIntegration(
    approvalId: string,
    decision: 'approved' | 'rejected',
    opts: { reason?: string; attested?: string[]; deferred?: string[]; by?: string; attestNote?: string },
  ): Ticket;
  scopeRequestOf(ticketId: string): { paths: string[]; reason: string } | null;
  /** 화면 점검·확인용 실행 기록과 QA 의견(없으면 null) */
  qaCheck(ticketId: string): { sha: string; state: string; opinion: string | null; qaState: string | null; at: string } | null;
  screenCheckOn: boolean;
  latestHead(ticketId: string): string | null;
  profileProposal(projectId: string): unknown;
  resolveProfileProposal(projectId: string, accept: boolean): unknown;
}

/** 직원 질문에 답하는 위임 실행(nonce → 업무) */
interface PendingDecision {
  ticketId: string;
  since: string;
}

const MAX_BUDGET_RAISES = 2;
/** 대표 직접 확인 항목: QA 의견을 이만큼 기다려도 없으면 대표 "나중에 확인"으로 넘기고 승인한다. */
const QA_WAIT_MS = 15 * 60_000;

export class Delegation {
  private readonly h: DelegationHost;
  private readonly pending = new Map<string, PendingDecision>();

  constructor(host: DelegationHost) {
    this.h = host;
  }

  get on(): boolean {
    return this.h.company.store.getSetting('delegation') === 'full';
  }

  set(on: boolean): { on: boolean; delegate: string | null } {
    this.h.company.store.setSetting('delegation', on ? 'full' : '');
    const d = this.delegate();
    this.h.company.store.appendEvent('ceo', on ? 'delegation.on' : 'delegation.off', 'company', { delegate: d?.id ?? null });
    this.h.changed('company', 'delegation');
    return { on, delegate: d?.id ?? null };
  }

  /** 위임받는 직원: 활성 직원 중 직급이 가장 높은 직원(같으면 비서실장 역할 먼저). */
  delegate(): Employee | null {
    return (
      this.h.company
        .activeEmployees()
        .sort(
          (a, b) =>
            RANK_ORDER[rankOf(b)] - RANK_ORDER[rankOf(a)] ||
            Number(b.roles.includes('chief-of-staff')) - Number(a.roles.includes('chief-of-staff')),
        )[0] ?? null
    );
  }

  /** 위임 결정 기록: 이벤트로 남기고 업무방(또는 전체 방)에 알린다. */
  private log(entityId: string, text: string, ticketId?: string): void {
    const d = this.delegate();
    if (!d) return;
    this.h.company.store.appendEvent(d.id, 'delegate.decided', entityId, { text });
    const room = ticketId ? this.h.chat.ensureTicketChannel(ticketId) : null;
    if (room) this.h.chat.post(room.id, d.id, `🧭 ${tr('전권 위임', 'Delegated')}: ${text}`, 'event');
    else {
      this.h.chat.ensureGeneral();
      this.h.chat.post('general', d.id, `🧭 ${tr('전권 위임', 'Delegated')}: ${text}`, 'event');
    }
    this.h.changed('company', 'delegation');
  }

  /** 최근 위임 결정(대시보드용) */
  recent(limit = 20): { at: string; by: string; entityId: string; text: string }[] {
    return this.h.company.store
      .eventsOfType('delegate.decided', limit)
      .map((e) => ({ at: e.ts, by: e.actor, entityId: e.entityId, text: String((e.payload as { text?: string }).text ?? '') }));
  }

  /** tick마다: 대표 할 일을 대신 처리한다. 한 번에 하나씩 실패해도 다음 것은 계속한다. */
  step(): void {
    if (!this.on || this.h.paused()) return;
    const d = this.delegate();
    if (!d) return;
    for (const req of this.h.records.requests(50).filter((r) => r.status === 'drafted')) this.tryDo(() => this.acceptDraft(req));
    for (const t of this.h.company.tickets()) {
      if (!t.hold) continue;
      if (t.hold.reason === 'needs_decision') this.tryDo(() => this.decideHold(t, d));
      else if (t.hold.reason === 'needs_permission' && t.status === 'verifying') this.tryDo(() => this.decideScopeViolation(t));
    }
    for (const a of this.h.records.approvals('pending').filter((x) => x.kind === 'integrate')) this.tryDo(() => this.decideApproval(a));
    for (const p of this.h.company.projects().filter((x) => !x.removedAt && this.h.profileProposal(x.id)))
      this.tryDo(() => {
        this.h.resolveProfileProposal(p.id, true);
        this.log(p.id, tr(`${p.name} 프로젝트 프로필 변경 제안을 반영했습니다.`, `Applied the profile proposal for ${p.name}.`));
      });
  }

  private tryDo(fn: () => void): void {
    try {
      fn();
    } catch {
      // 상태가 바뀌었거나 위임으로 처리할 수 없는 경우: 대표 할 일로 남는다(다음 tick에 다시 본다).
    }
  }

  /** 초안 확정: 질문은 비서실장 제안대로, 프로필이 없으면 제안 프로필 저장, 초안에 필요한 검사 명령 추가. */
  private acceptDraft(req: CeoRequest): void {
    if (req.error) return;
    const project = this.h.company.requireProject(req.projectId);
    if (req.profile && !project.profile) this.h.company.updateProject(project.id, { profile: req.profile });
    const have = new Set(project.verifyCommands.map((v) => v.argv.join(' ')));
    const used = new Set(req.drafts.flatMap((x) => x.requirements.map((r) => r.evidenceType)));
    const add = (req.verifySuggestions ?? []).filter(
      (s: VerifySuggestion) =>
        used.has(s.evidenceType) && !have.has(s.argv.join(' ')) && !project.verifyCommands.some((v) => v.evidenceType === s.evidenceType),
    );
    if (add.length)
      this.h.company.updateProject(project.id, {
        verifyCommands: [...project.verifyCommands, ...add.map((s) => ({ label: s.label, argv: s.argv, evidenceType: s.evidenceType }))],
      });
    const created = this.h.acceptRequest(req.id);
    this.log(
      req.id,
      tr(
        `"${req.text.slice(0, 60)}" 초안을 확정해 업무 ${created.length}개를 만들었습니다${req.questions.length ? ` (질문 ${req.questions.length}개는 비서실장 제안대로)` : ''}${add.length ? `, 검사 명령 추가: ${add.map((s) => s.argv.join(' ')).join(', ')}` : ''}.`,
        `Confirmed the draft for "${req.text.slice(0, 60)}": ${created.length} tickets.`,
      ),
    );
  }

  /** "대표 결정 필요" 보류: 예산 → 늘리기, 범위 요청 → 허락, 질문 → 팀장이 판단해 답한다. */
  private decideHold(t: Ticket, d: Employee): void {
    const note = t.hold!.note;
    if (/토큰 예산|Token budget/.test(note)) {
      const key = `delegate_budget:${t.id}`;
      const n = Number(this.h.company.store.getSetting(key) || 0);
      if (n >= MAX_BUDGET_RAISES) return; // 그 이상은 대표가 본다
      this.h.company.store.setSetting(key, String(n + 1));
      this.h.raiseTokenBudget(t.id);
      this.log(
        t.id,
        tr(`${t.id} 예산을 늘려 계속합니다(${n + 1}/${MAX_BUDGET_RAISES}).`, `Raised ${t.id}'s budget (${n + 1}/${MAX_BUDGET_RAISES}).`),
        t.id,
      );
      return;
    }
    const scope = this.h.scopeRequestOf(t.id);
    if (scope) {
      const project = this.h.company.requireProject(t.projectId);
      if (scope.paths.some((p) => project.protectedPaths.some((g) => p === g || p.startsWith(g.replace(/\*+$/, ''))))) return; // 보호 파일은 대표만
      this.h.addWriteScope(t.id, scope.paths);
      this.log(
        t.id,
        tr(
          `${t.id}에 ${scope.paths.join(', ')} 수정을 허락했습니다: ${scope.reason}`,
          `Allowed ${t.id} to edit ${scope.paths.join(', ')}.`,
        ),
        t.id,
      );
      return;
    }
    // 같은 보류에는 한 번만 묻는다(재시작으로 끊기면 설정으로 기억한다).
    const asked = this.h.company.store.getSetting(`delegate_q:${t.id}`);
    if (asked === t.hold!.since) return;
    this.h.company.store.setSetting(`delegate_q:${t.id}`, t.hold!.since);
    this.h.track(`delegate:${t.id}`, this.askDelegate(t, d));
  }

  private async askDelegate(t: Ticket, d: Employee): Promise<void> {
    const room = this.h.chat.ensureTicketChannel(t.id);
    if (!room) return;
    const raw = this.h.company.store.getSetting(`ticket_questions:${t.id}`);
    const questions: string[] = raw ? (JSON.parse(raw) as string[]) : [];
    const project = this.h.company.requireProject(t.projectId);
    const nonce = randomBytes(6).toString('hex');
    this.pending.set(nonce, { ticketId: t.id, since: t.hold!.since });
    const cwd = path.join(this.h.dataDir, 'delegate', t.id);
    await mkdir(cwd, { recursive: true });
    await this.h.launchChat({
      ticket: { id: room.id, round: 1, budget: { ...DEFAULT_BUDGET, runTimeoutMs: 10 * 60_000 } },
      employee: d,
      kind: 'chat',
      cwd,
      prompt: buildDelegateDecisionPrompt({
        employee: d,
        project,
        ticket: t,
        questions,
        note: t.hold!.note,
        decisions: this.h.records.decisions(project.id, 'current'),
        request: this.h.records.requestOfTicket(t)?.text ?? null,
        nonce,
        language: this.h.language,
      }),
      nonce,
      accessLevel: 'read-only',
      baseSha: null,
    });
  }

  /** 위임 실행의 답: 그 답으로 업무를 재개한다(규칙이면 프로젝트 규칙으로 남긴다). */
  onChatReply(run: RunRecord, reply: string, finalText: string | null): boolean {
    const p = this.pending.get(run.nonce);
    if (!p) return false;
    this.pending.delete(run.nonce);
    const t = this.h.company.store.get<Ticket>('tickets', p.ticketId);
    if (!t || t.hold?.reason !== 'needs_decision' || t.hold.since !== p.since) return true;
    const raw = finalText ? (extractLastJson(finalText) as Record<string, unknown> | null) : null;
    const rule = raw?.rule !== false;
    this.h.answerTicket(t.id, reply, rule);
    this.log(
      t.id,
      tr(`${t.id}의 질문에 답하고 재개했습니다${rule ? '(프로젝트 규칙으로 남김)' : ''}.`, `Answered ${t.id}'s questions and resumed.`),
      t.id,
    );
    return true;
  }

  /** 범위 밖 수정: 허락할 수 있으면 허락, 보호 파일·git 조작이면 되돌리게 한다. */
  private decideScopeViolation(t: Ticket): void {
    try {
      this.h.resolveScopeHold(t.id, true);
      this.log(t.id, tr(`${t.id}의 범위 밖 수정을 허락하고 검증을 이어갑니다.`, `Allowed ${t.id}'s out-of-scope changes.`), t.id);
    } catch {
      this.h.resolveScopeHold(t.id, false);
      this.log(
        t.id,
        tr(`${t.id}의 범위 밖 수정은 허락할 수 없어 되돌리게 했습니다.`, `Asked ${t.id} to revert out-of-scope changes.`),
        t.id,
      );
    }
  }

  /** 반영 승인: 대표 직접 확인 항목은 QA 의견으로 판단한다. */
  private decideApproval(a: Approval): void {
    const t = a.ticketId ? this.h.company.store.get<Ticket>('tickets', a.ticketId) : null;
    if (!t || t.status !== 'awaiting_approval' || t.hold) return;
    const d = this.delegate()!;
    const by = `delegate:${d.id}`;
    const checks = t.requirements.filter((r) => r.evidenceType === 'human_attest');
    if (!checks.length || t.type === 'review') {
      this.h.decideIntegration(a.id, 'approved', { by });
      this.log(t.id, tr(`${t.id} "${t.title}"을(를) 승인했습니다(검수 통과).`, `Approved ${t.id} (review passed).`), t.id);
      return;
    }
    const project = this.h.company.requireProject(t.projectId);
    const kind = deliverableOf(project);
    const ids = checks.map((r) => r.id);
    const deferAll = (why: string) => {
      this.h.decideIntegration(a.id, 'approved', { by, deferred: ids });
      this.log(
        t.id,
        tr(
          `${t.id}을(를) 승인했습니다. 직접 확인 ${ids.join(', ')}은(는) ${why} 대표 "나중에 확인"으로 남겼습니다.`,
          `Approved ${t.id}; checks left for the CEO.`,
        ),
        t.id,
      );
    };
    // 문서는 자동 점검이 없다: 검수 통과로 승인하고 읽을 거리는 대표에게 남긴다.
    if (kind === 'document') return deferAll(tr('문서를 대표가 읽어야 해서', 'the CEO should read the document, so'));
    const c = this.h.qaCheck(t.id);
    const head = this.h.latestHead(t.id);
    const waited = Date.now() - Date.parse(a.createdAt) > QA_WAIT_MS;
    if (!this.h.screenCheckOn || c?.state === 'failed') return deferAll(tr('자동 점검을 할 수 없어', 'no automatic check ran, so'));
    if (!c || c.sha !== head || c.state === 'running' || !c.opinion) {
      if (waited) deferAll(tr('QA 의견이 오지 않아', 'no QA opinion arrived, so'));
      return; // QA 의견을 기다린다
    }
    const verdicts = verdictsOf(c.opinion);
    const warn = verdicts.filter((v) => v.mark === '⚠' && !v.unsure);
    if (warn.length) {
      // QA 자동 돌려보내기가 처리한다. 그것도 끝났으면(두 번 다 씀) 팀장이 반려한다.
      if (Number(this.h.company.store.getSetting(`qa_rejects:${t.id}`) || 0) < 2 && project.qaAutoReject !== false) return;
      this.h.decideIntegration(a.id, 'rejected', {
        by,
        reason: tr(
          `전권 위임(${d.name}): QA가 찾은 문제를 고치세요.\n${warn.map((w) => `- ${w.id}: ${w.line}`).join('\n')}`,
          `Delegated: fix what QA found.`,
        ),
      });
      this.log(
        t.id,
        tr(`${t.id}을(를) QA 지적(${warn.map((w) => w.id).join(', ')})으로 반려했습니다.`, `Rejected ${t.id} on QA findings.`),
        t.id,
      );
      return;
    }
    const ok = ids.filter((id) => verdicts.some((v) => v.id === id && v.mark === '✅'));
    const later = ids.filter((id) => !ok.includes(id));
    this.h.decideIntegration(a.id, 'approved', {
      by,
      attested: ok,
      deferred: later,
      attestNote: tr(
        `전권 위임: ${d.name}이(가) QA 의견(✅)과 ${kind === 'program' ? '실행 결과' : '화면 사진'}을 보고 대신 확인했습니다.`,
        `Delegated: ${d.name} confirmed from QA (✅).`,
      ),
    });
    this.log(
      t.id,
      tr(
        `${t.id} "${t.title}"을(를) 승인했습니다. QA ✅ ${ok.length}개는 대신 확인${later.length ? `, ${later.join(', ')}은(는) 대표 "나중에 확인"으로` : ''}.`,
        `Approved ${t.id}: ${ok.length} confirmed from QA${later.length ? `, ${later.join(', ')} left for the CEO` : ''}.`,
      ),
      t.id,
    );
  }
}

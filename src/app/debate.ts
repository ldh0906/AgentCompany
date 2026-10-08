// 토론 모드: 직원들이 한 방에 모여 입장 → 반박 → 사회자 정리 순서로 토론하고, 대표(또는 전권 위임 직원)가 한 번에 결정한다.
// 대표 요청(2026-10-02): "토론 모드도 있어서 필요 시 또는 대표가 사용 시에 다같이 모여서 토론하면 좋겠다."
// 열리는 때: 대표가 주제를 줄 때, 같은 업무가 검수에서 두 번 반려될 때(그동안 업무는 기다린다), 비서실장이 초안에 큰 갈림길을 표시할 때.
// 진행 상태는 설정(debate:<id>)에 저장해 재시작해도 이어진다. 실행 하나가 실패해도 그 사람 몫만 비우고 다음 단계로 간다.
import { randomBytes } from 'node:crypto';
import { buildDebatePrompt, type DebatePhase } from '../agents/debate-prompts.ts';
import { extractLastJson } from '../agents/report.ts';
import { tr } from '../core/i18n.ts';
import type { Employee, Project, Ticket } from '../core/types.ts';
import { DEFAULT_BUDGET, RANK_ORDER, rankOf } from '../core/types.ts';
import { DomainError } from './company.ts';
import type { OrchHost } from './orch-host.ts';
import type { RunRecord } from './records.ts';

export interface DebateOption {
  title: string;
  supporters: string[];
  pros: string[];
  cons: string[];
  decision: string;
}

export interface Debate {
  id: string;
  channelId: string;
  topic: string;
  context: string;
  origin: 'ceo' | 'review' | 'draft';
  projectId: string | null;
  ticketId: string | null;
  requestId: string | null;
  participants: string[];
  moderator: string;
  phase: DebatePhase | 'decide' | 'done';
  /** 단계별 실행: 직원 ID → 실행 ID */
  runs: Record<string, string>;
  /** 단계별 nonce → 직원 ID(답이 실행 번호 저장보다 먼저 와도 찾게) */
  nonces?: Record<string, string>;
  /** 이번 단계에 띄울 실행 수 */
  expected?: number;
  /** 참가자가 읽는 사본 폴더 */
  dir?: string;
  positions: Record<string, string>;
  rebuttals: Record<string, string>;
  summary: string | null;
  options: DebateOption[];
  recommendation: number | null;
  dissent: string;
  decision: string | null;
  decidedBy: string | null;
  createdAt: string;
}

export interface DebateHost extends OrchHost {
  nameOf(id: string): string;
  /** 읽기 전용 프로젝트 사본(업무가 있으면 그 제출물, 없으면 기준 브랜치) */
  debateDir(projectId: string | null, ticketId: string | null, debateId: string): Promise<string>;
  /** 업무 토론의 결론을 담당자에게 전하고 업무를 이어간다 */
  resumeTicket(ticketId: string, text: string): void;
  holdTicket(ticketId: string, note: string, debateId: string): void;
  delegationOn(): boolean;
  delegate(): Employee | null;
  logDelegated(entityId: string, text: string, ticketId?: string): void;
}

const MAX_PARTICIPANTS = 4;

export class Debates {
  private readonly h: DebateHost;
  /** 진행 중인 단계 넘기기(같은 토론을 두 곳에서 동시에 넘기면 단계가 두 번 시작되어 답을 잃는다) */
  private readonly advancing = new Set<string>();

  constructor(host: DebateHost) {
    this.h = host;
  }

  private save(d: Debate): void {
    this.h.company.store.setSetting(`debate:${d.id}`, JSON.stringify(d));
    const ids = this.ids();
    if (!ids.includes(d.id)) {
      // 최근 50개만 남기되 끝나지 않은 토론은 빼지 않는다(색인에서 빠지면 다시 이어지지 않고 업무가 멈춘 채 남았다, QA)
      const all = [d.id, ...ids];
      const open = (id: string) => id === d.id || (this.get(id)?.phase ?? 'done') !== 'done';
      const keep = all.filter((id, i) => i < 50 || open(id));
      this.h.company.store.setSetting('debate_index', JSON.stringify(keep));
    }
    this.h.changed('chat', d.channelId);
  }

  private ids(): string[] {
    const raw = this.h.company.store.getSetting('debate_index');
    return raw ? (JSON.parse(raw) as string[]) : [];
  }

  get(id: string): Debate | null {
    const raw = this.h.company.store.getSetting(`debate:${id}`);
    return raw ? (JSON.parse(raw) as Debate) : null;
  }

  list(limit = 15): Debate[] {
    return this.ids()
      .slice(0, limit)
      .map((id) => this.get(id))
      .filter((d): d is Debate => Boolean(d));
  }

  /** 기본 참가자: 직급 높은 순, 서로 다른 AI가 섞이게(같은 AI끼리는 생각이 비슷하다). 사회자는 최고 직급. */
  private pick(want: string[] | null, must: string[] = []): { participants: string[]; moderator: string } {
    const active = this.h.company.activeEmployees().sort((a, b) => RANK_ORDER[rankOf(b)] - RANK_ORDER[rankOf(a)]);
    if (active.length < 2)
      throw new DomainError(tr('토론하려면 활성 직원이 두 명 이상 필요합니다.', 'A debate needs at least two active employees.'));
    const moderator = active[0]!.id;
    let chosen = (want?.length ? active.filter((e) => want.includes(e.id)) : []).map((e) => e.id);
    if (!chosen.length) {
      const byCli = new Map<string, Employee[]>();
      for (const e of active) byCli.set(e.cli, [...(byCli.get(e.cli) ?? []), e]);
      // 여러 AI에서 번갈아 한 명씩
      const queues = [...byCli.values()];
      while (chosen.length < MAX_PARTICIPANTS && queues.some((q) => q.length))
        for (const q of queues) if (q.length && chosen.length < MAX_PARTICIPANTS) chosen.push(q.shift()!.id);
    }
    chosen = [...new Set([...must, ...chosen])].slice(0, Math.max(MAX_PARTICIPANTS, must.length));
    if (chosen.length < 2) chosen = active.slice(0, 2).map((e) => e.id);
    return { participants: chosen, moderator };
  }

  /** 토론을 연다. 업무 토론이면 그동안 업무를 멈춘다. */
  async start(input: {
    topic: string;
    context?: string;
    origin: Debate['origin'];
    projectId?: string | null;
    ticketId?: string | null;
    requestId?: string | null;
    participants?: string[] | null;
    must?: string[];
  }): Promise<Debate> {
    const topic = input.topic.trim().slice(0, 500);
    if (!topic) throw new DomainError(tr('토론 주제를 적어 주세요.', 'Give the debate a topic.'));
    const { participants, moderator } = this.pick(input.participants ?? null, input.must ?? []);
    const id = `D-${randomBytes(4).toString('hex')}`;
    const room = this.h.chat.createGroup({
      name: tr(`토론: ${topic.slice(0, 40)}`, `Debate: ${topic.slice(0, 40)}`),
      members: [...participants, moderator],
      createdBy: moderator,
      topic,
      projectId: input.projectId ?? null,
      ticketId: input.ticketId ?? null,
    });
    const d: Debate = {
      id,
      channelId: room.id,
      topic,
      context: input.context ?? tr('대표가 토론을 열었습니다.', 'The CEO opened this debate.'),
      origin: input.origin,
      projectId: input.projectId ?? null,
      ticketId: input.ticketId ?? null,
      requestId: input.requestId ?? null,
      participants,
      moderator,
      phase: 'opening',
      runs: {},
      positions: {},
      rebuttals: {},
      summary: null,
      options: [],
      recommendation: null,
      dissent: '',
      decision: null,
      decidedBy: null,
      createdAt: new Date().toISOString(),
    };
    this.h.chat.post(
      room.id,
      'system',
      tr(
        `🗣 토론을 시작합니다: ${topic}\n참가: ${participants.map((p) => this.h.nameOf(p)).join(', ')} · 사회: ${this.h.nameOf(moderator)}\n순서: 각자 입장 → 서로 반박 → 사회자 정리 → ${this.h.delegationOn() ? '위임받은 직원이 결정' : '대표 결정'}`,
        `🗣 Debate: ${topic}\nDebaters: ${participants.map((p) => this.h.nameOf(p)).join(', ')} · Moderator: ${this.h.nameOf(moderator)}`,
      ),
      'event',
    );
    if (d.ticketId)
      this.h.holdTicket(
        d.ticketId,
        tr(`토론 중: ${topic.slice(0, 80)} (결론이 나면 이어갑니다)`, `In debate: ${topic.slice(0, 80)}`),
        d.id,
      );
    this.save(d);
    // 시작도 단계 넘기기와 같은 잠금 안에서: 사본 준비(수 초) 동안 tick이 단계를 넘기지 못하게.
    // 실측(2026-10-02, 가계부 할부 토론): 시작 직후 tick이 "기대 0, 답 0"으로 보고 반박까지 띄워 8개 실행이 함께 돌았다.
    this.advancing.add(d.id);
    try {
      await this.launchPhaseSafe(d.id);
    } finally {
      this.advancing.delete(d.id);
    }
    return this.get(d.id)!;
  }

  /** 최신 기록을 다시 읽어 고친다(답이 시작보다 먼저 와도 서로 덮어쓰지 않게). */
  private update(id: string, fn: (d: Debate) => void): Debate | null {
    const d = this.get(id);
    if (!d) return null;
    fn(d);
    this.save(d);
    return d;
  }

  private async launchPhase(id: string): Promise<void> {
    const d = this.get(id);
    if (!d) return;
    const who = (d.phase === 'summary' ? [d.moderator] : d.participants).filter((x) =>
      this.h.company.employees().some((e) => e.id === x && e.active && !e.removedAt),
    );
    const project = d.projectId ? this.h.company.store.get<Project>('projects', d.projectId) : null;
    // 읽을 사본은 토론당 한 번 만든다(단계마다 다시 맞추면 git 오류로 다음 단계가 시작되지 않았다).
    this.update(id, (x) => ((x.runs = {}), (x.nonces = {}), (x.expected = who.length)));
    const cwd = d.dir ?? (await this.h.debateDir(d.projectId, d.ticketId, d.id));
    if (!d.dir) this.update(id, (x) => (x.dir = cwd));
    const decisions = d.projectId ? this.h.records.decisions(d.projectId, 'current').map((x) => `- [${x.id}] ${x.text}`) : [];
    const named = (m: Record<string, string>) =>
      Object.entries(m).map(([id, text]) => ({ name: this.h.nameOf(id), text: text || '(no answer)' }));
    // 실측(테스트, 2026-10-02): 빠른 답이 실행 번호 저장보다 먼저 와서 입장이 비었다. nonce를 먼저 저장하고 답은 nonce로 찾는다.
    for (const empId of who) {
      const employee = this.h.company.employees().find((e) => e.id === empId)!;
      const nonce = randomBytes(6).toString('hex');
      this.update(id, (x) => (x.nonces![nonce] = empId));
      const runId = await this.h.launchChat({
        ticket: { id: d.channelId, round: 1, budget: { ...DEFAULT_BUDGET, runTimeoutMs: 10 * 60_000 } },
        employee,
        kind: 'chat',
        cwd,
        prompt: buildDebatePrompt({
          employee,
          phase: d.phase as DebatePhase,
          topic: d.topic,
          context: d.context,
          project,
          participants: d.participants.map((p) => this.h.nameOf(p)),
          positions: d.phase === 'opening' ? [] : named(d.positions),
          rebuttals: d.phase === 'summary' ? named(d.rebuttals) : [],
          decisions,
          nonce,
          language: this.h.language,
        }),
        nonce,
        accessLevel: 'read-only',
        baseSha: null,
      });
      this.update(id, (x) => (x.runs[empId] = runId));
    }
  }

  /** 토론 실행이 끝났을 때(답 또는 실패). 처리했으면 true. */
  onChatReply(run: RunRecord, reply: string | null, finalText: string | null): boolean {
    const found = this.list(50).find(
      (x) => (x.nonces?.[run.nonce] || Object.values(x.runs).includes(run.id)) && ['opening', 'rebuttal', 'summary'].includes(x.phase),
    );
    if (!found) return false;
    const d = this.get(found.id)!;
    const text = reply ?? '';
    if (d.phase === 'opening') d.positions[run.employeeId] = text;
    else if (d.phase === 'rebuttal') d.rebuttals[run.employeeId] = text;
    else {
      const raw = finalText ? (extractLastJson(finalText) as Record<string, unknown> | null) : null;
      d.summary = text;
      d.options = (Array.isArray(raw?.options) ? (raw!.options as Record<string, unknown>[]) : []).slice(0, 4).map((o) => ({
        title: String(o.title ?? '').slice(0, 200),
        supporters: Array.isArray(o.supporters) ? (o.supporters as unknown[]).map(String).slice(0, 6) : [],
        pros: Array.isArray(o.pros) ? (o.pros as unknown[]).map(String).slice(0, 5) : [],
        cons: Array.isArray(o.cons) ? (o.cons as unknown[]).map(String).slice(0, 5) : [],
        decision: String(o.decision ?? o.title ?? '').slice(0, 500),
      }));
      const rec = Number(raw?.recommendation);
      d.recommendation = Number.isInteger(rec) && rec >= 0 && rec < d.options.length ? rec : d.options.length ? 0 : null;
      d.dissent = typeof raw?.dissent === 'string' ? raw.dissent.slice(0, 1000) : '';
    }
    this.save(d);
    void this.advance(d.id).catch(() => {});
    return true;
  }

  /** 단계의 실행이 모두 끝났으면 다음 단계로. tick에서도 불러 재시작으로 끊긴 토론을 잇는다. */
  async advance(id: string): Promise<void> {
    if (this.advancing.has(id)) return; // 다음 tick에 다시 본다
    this.advancing.add(id);
    try {
      await this.advanceLocked(id);
    } finally {
      this.advancing.delete(id);
    }
  }

  private async advanceLocked(id: string): Promise<void> {
    const d = this.get(id);
    if (!d || !['opening', 'rebuttal', 'summary'].includes(d.phase)) return;
    // 답이 모두 기록되면 다음 단계로. 실행 상태가 "끝남"이 된 뒤 답이 기록되기까지 틈이 있어, 실행 상태만 보면 늦은 답을 버린다
    // (실측: 테스트에서 입장·반박이 비었다). 재시작으로 답을 잃은 경우만 실행이 끝나고 30초 뒤 그냥 넘어간다.
    const recorded =
      d.phase === 'opening'
        ? Object.keys(d.positions).length
        : d.phase === 'rebuttal'
          ? Object.keys(d.rebuttals).length
          : d.summary !== null
            ? 1
            : 0;
    const ended = (runId: string) => {
      const r = this.h.records.run(runId);
      return !r || (!['prepared', 'running'].includes(r.status) && Date.now() - Date.parse(r.endedAt ?? r.startedAt) > 30_000);
    };
    if (d.expected === undefined) return; // 이 단계 실행이 아직 준비되지 않았다
    const allRecorded = recorded >= d.expected;
    if (!allRecorded && (Object.keys(d.runs).length < (d.expected ?? 0) || !Object.values(d.runs).every(ended))) return;
    delete d.expected; // 다음 단계의 실행 수는 그 단계를 띄울 때 정한다
    if (d.phase === 'opening') d.phase = 'rebuttal';
    else if (d.phase === 'rebuttal') d.phase = 'summary';
    else {
      d.phase = 'decide';
      this.save(d);
      this.h.chat.post(
        d.channelId,
        'system',
        tr('토론이 정리되었습니다. 선택지를 골라 결정하세요(토론 방 위쪽).', 'The debate is summarized. Pick an option to decide.'),
        'event',
      );
      this.h.notice(
        tr(`토론 결정 필요: ${d.topic.slice(0, 60)}`, `Debate needs a decision: ${d.topic.slice(0, 60)}`),
        d.summary?.slice(0, 200) ?? '',
        `/chat/${encodeURIComponent(d.channelId)}`,
      );
      return;
    }
    this.save(d);
    await this.launchPhaseSafe(d.id);
  }

  /** 단계 시작이 실패하면 멈춰 있지 않고 방에 알린다(대표가 직접 결론을 쓸 수 있게 결정 단계로). */
  private async launchPhaseSafe(id: string): Promise<void> {
    try {
      await this.launchPhase(id);
    } catch (e) {
      const d = this.update(id, (x) => ((x.phase = 'decide'), (x.expected = 0)));
      if (d)
        this.h.chat.post(
          d.channelId,
          'system',
          tr(
            `토론을 이어가지 못했습니다(${String((e as Error)?.message ?? e).slice(0, 200)}). 지금까지의 의견을 보고 직접 결론을 적어 결정하세요.`,
            `The debate could not continue (${String((e as Error)?.message ?? e).slice(0, 200)}). Decide with your own conclusion.`,
          ),
          'event',
        );
    }
  }

  /** tick: 끊긴 토론 잇기 + 전권 위임이면 추천안으로 결정 */
  async sweep(): Promise<void> {
    // 끝나지 않은 토론을 먼저 고른다(끝난 최신 토론에 밀려 오래된 토론이 다시 이어지지 않는 일이 없게, QA)
    for (const d of this.list(500)
      .filter((x) => x.phase !== 'done')
      .slice(0, 50)) {
      if (['opening', 'rebuttal', 'summary'].includes(d.phase)) await this.advance(d.id);
      else if (d.phase === 'decide' && this.h.delegationOn() && d.recommendation !== null) {
        const del = this.h.delegate();
        if (del) {
          this.decide(d.id, { option: d.recommendation }, `delegate:${del.id}`);
          this.h.logDelegated(
            d.id,
            tr(
              `토론 "${d.topic.slice(0, 50)}"을(를) 추천안으로 결정했습니다: ${d.options[d.recommendation]?.title ?? ''}`,
              `Decided the debate "${d.topic.slice(0, 50)}" by the recommendation.`,
            ),
            d.ticketId ?? undefined,
          );
        }
      }
    }
  }

  /** 결정: 고른 선택지(또는 대표가 직접 쓴 결론)를 규칙으로 남기고, 업무 토론이면 업무를 이어간다. */
  decide(id: string, choice: { option?: number; text?: string }, by = 'ceo'): Debate {
    const d = this.get(id);
    if (!d || d.phase !== 'decide')
      throw new DomainError(tr('결정할 수 있는 토론이 아닙니다.', 'This debate is not waiting for a decision.'));
    const opt = choice.option !== undefined ? d.options[choice.option] : undefined;
    const text = (choice.text?.trim() || opt?.decision || opt?.title || '').trim();
    if (!text) throw new DomainError(tr('결론을 고르거나 적어 주세요.', 'Pick or write a conclusion.'));
    d.decision = text;
    d.decidedBy = by;
    d.phase = 'done';
    this.save(d);
    if (d.projectId)
      this.h.records.recordDecision(
        d.projectId,
        tr(`토론 결론(${d.topic.slice(0, 80)}): ${text}`, `Debate (${d.topic.slice(0, 80)}): ${text}`),
        [d.id],
      );
    this.h.chat.post(
      d.channelId,
      by.startsWith('delegate:') ? by.slice(9) : by === 'ceo' ? 'ceo' : 'system',
      tr(`✅ 결정: ${text}`, `✅ Decided: ${text}`),
      'chat',
    );
    if (d.ticketId) this.h.resumeTicket(d.ticketId, tr(`토론 결론: ${text}`, `Debate conclusion: ${text}`));
    return d;
  }

  /** 같은 업무가 검수에서 두 번 반려되면 담당자·검수자·사회자가 토론한다(업무당 한 번). */
  async maybeReviewDebate(t: Ticket): Promise<boolean> {
    if (this.h.company.store.getSetting(`review_debate:${t.id}`)) return false;
    const rejections = this.h.records
      .runsForTicket(t.id)
      .filter((r) => r.kind === 'review' && r.report?.kind === 'review' && r.report.verdict === 'request_changes');
    if (rejections.length < 2) return false;
    this.h.company.store.setSetting(`review_debate:${t.id}`, '1');
    const last = rejections.at(-1)!;
    const must = [t.assigneeId, t.reviewerId].filter((x): x is string => Boolean(x));
    await this.start({
      topic: tr(
        `${t.id} "${t.title}": 검수 지적이 맞는지, 어떻게 마무리할지`,
        `${t.id} "${t.title}": is the review right, and how to finish`,
      ),
      context: tr(
        `검수에서 두 번 반려되었습니다. 마지막 검수 의견:\n${last.summary}\n\n담당자 마지막 보고:\n${this.h.records.latestSubmission(t)?.summary ?? ''}`,
        `Rejected twice in review. Last review:\n${last.summary}`,
      ),
      origin: 'review',
      projectId: t.projectId,
      ticketId: t.id,
      must,
      participants: must,
    });
    return true;
  }
}

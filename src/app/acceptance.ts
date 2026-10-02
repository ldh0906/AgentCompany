// 요청 단위 V모델: 업무가 모두 끝나면 반영된 결과 전체를 인수 시험으로 확인하고, 떨어진 항목은 고칠 업무를 만들어 다시 돌린다.
// 대표 요청(2026-10-02): "이미지(V모델)처럼 루프하면서 자가발전하는 부분도 있으면 좋겠다." 범위: 요청 단위 V모델.
//   왼쪽: 요구 분석(대표 요청) → 인수 시험 정하기(비서실장 초안) → 업무 설계 → 모듈(업무) 구현
//   오른쪽: 단위 시험(업무 검사 명령) → 업무 검수 → 통합 시험(반영된 결과에서 검사 명령 다시) → 인수 시험(이 모듈)
// 고치는 바퀴는 최대 MAX_FIX_ROUNDS번. 그다음에도 남으면 대표에게 알린다(끝없이 돌며 토큰을 쓰지 않게).
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { buildAcceptancePrompt } from '../agents/acceptance-prompts.ts';
import { extractLastJson, screenStepsOf, type ScreenScenario } from '../agents/report.ts';
import { tr } from '../core/i18n.ts';
import type { Employee, EvidenceType, Project, Ticket } from '../core/types.ts';
import { DEFAULT_BUDGET, DIFFICULTIES, RANK_ORDER, deliverableOf, rankOf, type Difficulty } from '../core/types.ts';
import type { OrchHost } from './orch-host.ts';
import type { AcceptanceRound, CeoRequest, RunRecord } from './records.ts';

export const MAX_FIX_ROUNDS = 2;

export interface AcceptanceHost extends OrchHost {
  nameOf(id: string): string;
  /** 반영된 결과의 읽기 전용 사본 */
  snapshotDir(projectId: string, key: string): Promise<string>;
  /** 프로젝트 검사 명령을 사본에서 다시 돌린다(통합 시험) */
  integrationChecks(project: Project, dir: string, key: string): Promise<string[]>;
  /** 화면 결과물: 반영된 결과를 띄워 찍은 사진(outDir에 저장). 화면이 아니거나 못 찍으면 null */
  acceptanceScreens(
    project: Project,
    scenarios: ScreenScenario[],
    outDir: string,
  ): Promise<{ shots: { file: string; label: string }[]; errors: string[]; text: string } | null>;
}

export class Acceptance {
  private readonly h: AcceptanceHost;

  constructor(host: AcceptanceHost) {
    this.h = host;
  }

  /** 시험 담당: 업무를 가장 많이 한 AI와 다른 AI의 QA(직급 높은 순). 없으면 아무 QA, 그다음 최고 직급. */
  private pickTester(tickets: Ticket[], screen: boolean): Employee | null {
    const all = this.h.company.activeEmployees().sort((a, b) => RANK_ORDER[rankOf(b)] - RANK_ORDER[rankOf(a)]);
    // 화면 결과물은 사진을 봐야 한다: 사진을 읽는 Claude 직원이 있으면 그중에서 고른다(화면 점검 QA와 같은 기준).
    const claude = all.filter((e) => e.cli === 'claude');
    const active = screen && claude.length ? claude : all;
    const byCli = new Map<string, number>();
    for (const t of tickets) {
      const cli = all.find((e) => e.id === t.assigneeId)?.cli;
      if (cli) byCli.set(cli, (byCli.get(cli) ?? 0) + 1);
    }
    const busiest = [...byCli.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    return (
      active.find((e) => e.roles.includes('qa') && e.cli !== busiest) ??
      active.find((e) => e.roles.includes('qa')) ??
      active.find((e) => e.cli !== busiest) ??
      active[0] ??
      null
    );
  }

  private save(req: CeoRequest, round: AcceptanceRound): void {
    const cur = this.h.records.request(req.id) ?? req;
    const rounds = [...(cur.acceptanceRounds ?? []).filter((r) => r.round !== round.round), round].sort((a, b) => a.round - b.round);
    this.h.records.saveRequest({ ...cur, acceptanceRounds: rounds });
    this.h.changed('request', req.id);
  }

  /** 요청의 업무가 모두 끝났을 때(오케스트레이터가 부른다). 인수 시험이 있고 끝난 업무가 하나라도 있으면 돈다. */
  async onRequestDone(req: CeoRequest, tickets: Ticket[]): Promise<void> {
    if (!req.acceptance?.length || !tickets.some((t) => t.status === 'done')) return;
    const project = this.h.company.store.get<Project>('projects', req.projectId);
    if (!project || project.removedAt || project.acceptanceTests === false) return; // 대표가 끈 프로젝트
    const round = (req.acceptanceRounds?.length ?? 0) + 1;
    const tester = this.pickTester(tickets, deliverableOf(project) === 'screen');
    if (!tester) return;
    const record: AcceptanceRound = {
      round,
      state: 'running',
      at: new Date().toISOString(),
      runId: null,
      results: [],
      report: '',
      fixTickets: [],
    };
    this.save(req, record);
    const room = this.room(req, tester);
    this.h.chat.post(
      room,
      'system',
      tr(
        `✔ 인수 시험 ${round}회차: 요청의 업무가 모두 끝나 ${this.h.nameOf(tester.id)}이(가) 반영된 결과 전체를 인수 시험 ${req.acceptance.length}개로 확인합니다.`,
        `✔ Acceptance test round ${round}: ${this.h.nameOf(tester.id)} checks the merged result against ${req.acceptance.length} tests.`,
      ),
      'event',
    );
    const key = `acc-${req.id}-${round}`;
    const dir = await this.h.snapshotDir(project.id, key);
    const checks = await this.h.integrationChecks(project, dir, key).catch((e: unknown) => [String((e as Error)?.message ?? e)]);
    // 화면 결과물이면 반영된 결과를 띄워, 업무들이 남긴 점검 순서대로 사진을 찍어 함께 보게 한다.
    const screens = await this.h
      .acceptanceScreens(project, this.scenariosOf(tickets), path.join(dir, '.acceptance-shots'))
      .catch(() => null);
    if (screens)
      this.h.chat.post(
        room,
        'system',
        tr(
          `📷 반영된 결과를 띄워 화면 ${screens.shots.length}장을 찍었습니다(콘솔 오류 ${screens.errors.length}개). 화면 항목은 사진으로 판정합니다.`,
          `📷 Took ${screens.shots.length} screenshots of the merged result (${screens.errors.length} console errors).`,
        ),
        'event',
      );
    const nonce = randomBytes(6).toString('hex');
    this.h.company.store.setSetting(`acceptance_nonce:${nonce}`, JSON.stringify({ requestId: req.id, round }));
    record.runId = await this.h.launchChat({
      ticket: { id: room, round, budget: { ...DEFAULT_BUDGET, runTimeoutMs: 20 * 60_000 } },
      employee: tester,
      kind: 'chat',
      cwd: dir,
      prompt: buildAcceptancePrompt({
        employee: tester,
        project,
        request: req.text,
        tests: req.acceptance,
        tickets: tickets.map((t) => {
          const sub = this.h.records.latestSubmission(t);
          return `- ${t.id} [${t.status}] ${t.title}: ${(sub?.summary ?? '').slice(0, 600)}`;
        }),
        checks,
        screens,
        decisions: this.h.records.decisions(project.id, 'current').map((d) => `- [${d.id}] ${d.text}`),
        round,
        maxRounds: MAX_FIX_ROUNDS + 1,
        nonce,
        language: this.h.language,
      }),
      nonce,
      accessLevel: 'read-only',
      baseSha: null,
    });
    this.save(req, record);
  }

  /** 끝난 업무들이 남긴 화면 점검 순서(대표 직접 확인 항목 먼저, 모두 합쳐 최대 6개). 사진 이름에 업무 ID가 붙는다. */
  private scenariosOf(tickets: Ticket[]): ScreenScenario[] {
    const all = tickets
      .filter((t) => t.status === 'done')
      .flatMap((t) => {
        const sub = this.h.records.latestSubmission(t);
        const raw = sub?.finalText ? (extractLastJson(sub.finalText) as Record<string, unknown> | null) : null;
        const attest = new Set(t.requirements.filter((r) => r.evidenceType === 'human_attest').map((r) => r.id));
        return screenStepsOf(
          raw?.screenSteps,
          t.requirements.map((r) => r.id),
        ).map((s) => ({ attest: attest.has(s.requirementId), s: { ...s, requirementId: `${t.id} ${s.requirementId}` } }));
      });
    return [...all.filter((x) => x.attest), ...all.filter((x) => !x.attest)].slice(0, 6).map((x) => x.s);
  }

  /** 요청마다 인수 시험 방(그룹 방) 하나 */
  private room(req: CeoRequest, tester: Employee): string {
    const key = `acceptance_room:${req.id}`;
    const have = this.h.company.store.getSetting(key);
    if (have && this.h.chat.channel(have)) return have;
    const c = this.h.chat.createGroup({
      name: tr(`인수 시험: ${req.text.slice(0, 30)}`, `Acceptance: ${req.text.slice(0, 30)}`),
      members: [tester.id],
      createdBy: tester.id,
      topic: req.text.slice(0, 300),
      projectId: req.projectId,
    });
    this.h.company.store.setSetting(key, c.id);
    const cur = this.h.records.request(req.id);
    if (cur) this.h.records.saveRequest({ ...cur, rooms: { ...cur.rooms, acceptance: c.id } });
    return c.id;
  }

  /** 시험 결과: 기록하고, ⚠가 있으면 고칠 업무를 만든다(최대 회차까지). 처리했으면 true. */
  onChatReply(run: RunRecord, reply: string | null, finalText: string | null): boolean {
    const raw = this.h.company.store.getSetting(`acceptance_nonce:${run.nonce}`);
    if (!raw) return false;
    this.h.company.store.setSetting(`acceptance_nonce:${run.nonce}`, '');
    const { requestId, round } = JSON.parse(raw) as { requestId: string; round: number };
    const req = this.h.records.request(requestId);
    if (!req) return true;
    const json = finalText ? (extractLastJson(finalText) as Record<string, unknown> | null) : null;
    const results = (Array.isArray(json?.results) ? (json!.results as Record<string, unknown>[]) : [])
      .filter((r) => typeof r.id === 'string' && ['✅', '⚠', '❓'].includes(String(r.mark).replace('⚠️', '⚠')))
      .map((r) => ({
        id: String(r.id),
        mark: String(r.mark).replace('⚠️', '⚠') as '✅' | '⚠' | '❓',
        why: String(r.why ?? '').slice(0, 600),
      }));
    const record: AcceptanceRound = {
      round,
      state: reply === null ? 'failed' : 'done',
      at: new Date().toISOString(),
      runId: run.id,
      results,
      report: (reply ?? '').slice(0, 6000),
      fixTickets: [],
    };
    const failed = results.filter((r) => r.mark === '⚠');
    const project = this.h.company.store.get<Project>('projects', req.projectId);
    const fixes = failed.length && project && round <= MAX_FIX_ROUNDS ? this.createFixes(req, project, json, failed, round) : [];
    record.fixTickets = fixes.map((t) => t.id);
    this.save(req, record);
    const room = this.h.company.store.getSetting(`acceptance_room:${req.id}`) ?? '';
    const passed = results.filter((r) => r.mark === '✅').length;
    if (fixes.length) {
      // 고칠 업무를 요청에 붙이고, 그 업무가 끝나면 다시 시험한다(요청 완료 표시를 지워 다시 알림이 오게).
      const cur = this.h.records.request(req.id)!;
      this.h.records.saveRequest({ ...cur, ticketIds: [...cur.ticketIds, ...fixes.map((t) => t.id)] });
      this.h.company.store.setSetting(`request_done:${req.id}`, '');
      if (room)
        this.h.chat.post(
          room,
          'system',
          tr(
            `🔁 인수 시험 ${round}회차: ${passed}/${results.length} 통과. 고칠 업무 ${fixes.map((t) => t.id).join(', ')}을(를) 만들었습니다. 끝나면 다시 시험합니다(${round}/${MAX_FIX_ROUNDS}바퀴).`,
            `🔁 Acceptance round ${round}: ${passed}/${results.length} passed. Created fixes ${fixes.map((t) => t.id).join(', ')}; will retest.`,
          ),
          'event',
        );
    } else {
      const left = failed.length;
      this.h.notice(
        left
          ? tr(
              `인수 시험에 남은 문제가 있습니다 (${passed}/${results.length})`,
              `Acceptance test left issues (${passed}/${results.length})`,
            )
          : tr(`인수 시험 통과 (${passed}/${results.length})`, `Acceptance test passed (${passed}/${results.length})`),
        `${req.text.slice(0, 100)}${
          left
            ? tr(
                `\n고치는 바퀴(${MAX_FIX_ROUNDS})를 다 써서 대표에게 넘깁니다: ${failed
                  .map((f) => `${f.id} ${f.why}`)
                  .join(' / ')
                  .slice(0, 300)}`,
                '',
              )
            : ''
        }`,
        room ? `/chat/${encodeURIComponent(room)}` : '/',
      );
    }
    return true;
  }

  private createFixes(
    req: CeoRequest,
    project: Project,
    json: Record<string, unknown> | null,
    failed: { id: string }[],
    round: number,
  ): Ticket[] {
    const hasUnit = project.verifyCommands.some((v) => v.evidenceType === 'unit_test');
    const out: Ticket[] = [];
    const drafts = (Array.isArray(json?.fixes) ? (json!.fixes as Record<string, unknown>[]) : []).slice(0, 4);
    for (const f of drafts) {
      const title = typeof f.title === 'string' ? f.title.trim() : '';
      const scope = Array.isArray(f.writeScope)
        ? (f.writeScope as unknown[]).filter((x): x is string => typeof x === 'string' && x.trim() !== '')
        : [];
      const reqs = (Array.isArray(f.requirements) ? (f.requirements as Record<string, unknown>[]) : [])
        .filter((r) => typeof r.text === 'string' && r.text.trim())
        .map((r) => {
          const t = String(r.evidenceType);
          const evidenceType: EvidenceType =
            t === 'unit_test' && hasUnit ? 'unit_test' : t === 'human_attest' ? 'human_attest' : 'inspection';
          return { text: String(r.text).slice(0, 1000), evidenceType };
        });
      if (!title || !scope.length || !reqs.length) continue;
      const difficulty: Difficulty =
        (DIFFICULTIES as readonly string[]).includes(String(f.difficulty)) && f.difficulty !== 'hard'
          ? (f.difficulty as Difficulty)
          : 'normal';
      out.push(
        this.h.company.createTicket(
          {
            projectId: project.id,
            type: 'impl',
            title: tr(`[인수 ${round}] ${title}`, `[Acceptance ${round}] ${title}`).slice(0, 200),
            purpose:
              `${typeof f.purpose === 'string' ? f.purpose : ''}\n${tr('인수 시험에서 떨어진 항목', 'Failed acceptance test')}: ${String(f.for ?? failed.map((x) => x.id).join(', '))}`.trim(),
            requirements: reqs,
            doneCriteria: tr('인수 시험 항목을 통과한다', 'The acceptance test passes'),
            writeScope: scope,
            difficulty,
          },
          { kind: 'orchestrator' },
        ),
      );
    }
    return out;
  }
}

// 대표 알림: "지금 대표가 할 일", 알림 목록, 선택형 윈도우 토스트, 요청이 끝났다는 알림.
// orchestrator.ts에서 떼어 냄(2026-10-01: 3500줄이 넘어 기능별로 나눔).
import { tr } from '../core/i18n.ts';

import type { Ticket } from '../core/types.ts';
import { TERMINAL_STATUSES } from '../core/types.ts';
import { requestTokens, tokensText } from './cost.ts';
import { showToast, toastBlocked, type CeoNotice, type CeoTodo } from './notify.ts';
import type { OrchHost } from './orch-host.ts';
import { newId, type CeoRequest } from './records.ts';

export interface CeoDeskHost extends Pick<OrchHost, 'company' | 'records' | 'paused' | 'changed'> {
  /** 요청 하나의 업무가 모두 끝났을 때(게임이면 고급 QA 자동 실행) */
  onRequestDone(req: CeoRequest, tickets: Ticket[]): void;
  /** 출력이 오래 없는 실행(멈췄을 수 있음) */
  stalled(): { runId: string; ticketId: string; employeeId: string; quietMs: number }[];
  /** 결정을 기다리는 토론 */
  debatesToDecide(): { id: string; topic: string; channelId: string }[];
}

export class CeoDesk {
  private readonly h: CeoDeskHost;

  constructor(host: CeoDeskHost) {
    this.h = host;
  }

  /** 지금 대표가 할 일: 승인, 결정·허가가 필요한 보류, 확인할 초안, 실패한 초안, 하루 한도 멈춤. */
  ceoTodos(): CeoTodo[] {
    const out: CeoTodo[] = [];
    for (const a of this.h.records.approvals('pending'))
      out.push({ key: `appr:${a.id}`, kind: 'approval', title: a.summary, link: a.ticketId ? `/tickets/${a.ticketId}` : '/' });
    for (const t of this.h.company.tickets())
      if (t.hold && !TERMINAL_STATUSES.includes(t.status) && t.hold.reason !== 'waiting_dependency')
        out.push({
          key: `hold:${t.id}:${t.hold.since}`,
          kind: t.hold.reason === 'needs_permission' ? 'permission' : 'decision',
          title: `${t.id} ${t.title}: ${t.hold.note.split('\n')[0]!.slice(0, 120)}`,
          link: `/tickets/${t.id}`,
        });
    for (const r of this.h.records.requests())
      if (r.status === 'drafted')
        out.push({
          key: `draft:${r.id}`,
          kind: 'draft',
          title: tr(`초안 확인: ${r.text.slice(0, 60)}`, `Review drafts: ${r.text.slice(0, 60)}`),
          link: '/',
        });
      else if (r.status === 'failed' && r.error && !/자동으로 다시|retrying automatically/.test(r.error))
        out.push({
          key: `failed:${r.id}`,
          kind: 'failed',
          title: tr(`초안 실패: ${r.text.slice(0, 60)}`, `Drafting failed: ${r.text.slice(0, 60)}`),
          link: '/',
        });
    for (const d of this.h.debatesToDecide())
      out.push({
        key: `debate:${d.id}`,
        kind: 'decision',
        title: tr(`토론 결정: ${d.topic.slice(0, 60)}`, `Decide the debate: ${d.topic.slice(0, 60)}`),
        link: `/chat/${encodeURIComponent(d.channelId)}`,
      });
    for (const p of this.h.company.projects())
      if (!p.removedAt && this.h.company.store.getSetting(`profile_proposal:${p.id}`))
        out.push({
          key: `profile:${p.id}:${this.h.company.store.getSetting(`profile_proposal:${p.id}`)!.length}`,
          kind: 'decision',
          title: tr(`${p.name} 프로필 변경 제안 확인`, `Review the profile proposal for ${p.name}`),
          link: '/projects',
        });
    for (const t of this.h.company.tickets()) {
      const later = this.h.company.store.getSetting(`later_checks:${t.id}`);
      if (later && later !== '[]')
        for (const x of JSON.parse(later) as { id: string; text: string }[])
          out.push({
            key: `later:${t.id}:${x.id}`,
            kind: 'later',
            title: tr(`나중에 확인: ${t.id} ${x.text.slice(0, 80)}`, `Check later: ${t.id} ${x.text.slice(0, 80)}`),
            link: `/tickets/${t.id}`,
          });
    }
    for (const s of this.h.stalled())
      out.push({
        key: `stall:${s.runId}`,
        kind: 'stalled',
        title: tr(
          `${s.ticketId} ${this.h.company.employees().find((e) => e.id === s.employeeId)?.name ?? ''}: ${Math.round(s.quietMs / 60_000)}분째 아무 신호 없음 — 멈췄을 수 있습니다`,
          `${s.ticketId}: silent for ${Math.round(s.quietMs / 60_000)} minutes — may be stuck`,
        ),
        link: `/live/${s.runId}`,
      });
    if (this.h.paused() && (this.h.company.store.getSetting('paused_reason') ?? '').startsWith('daily:'))
      out.push({
        key: 'paused:daily',
        kind: 'paused',
        title: tr('하루 토큰 한도에 닿아 회사가 멈췄습니다.', 'Paused: daily token limit reached.'),
        link: '/',
      });
    return out;
  }

  notices(): CeoNotice[] {
    const raw = this.h.company.store.getSetting('ceo_notices');
    return raw ? (JSON.parse(raw) as CeoNotice[]) : [];
  }

  /** 대표에게 알린다(대시보드·브라우저 알림, 켜 두면 윈도우 토스트). 최근 30개만 남긴다. */
  notice(title: string, body: string, link = '/'): void {
    const n: CeoNotice = { id: newId('N'), at: new Date().toISOString(), title, body: body.slice(0, 400), link };
    this.h.company.store.setSetting('ceo_notices', JSON.stringify([...this.notices(), n].slice(-30)));
    if (this.toastOn) showToast(title, body);
    this.h.changed('notice', n.id);
  }

  get toastOn(): boolean {
    return this.h.company.store.getSetting('toast_notifications') === '1';
  }

  setToast(on: boolean): { toast: boolean; blocked: string | null } {
    this.h.company.store.setSetting('toast_notifications', on ? '1' : '');
    // 윈도우 설정에서 알림이 꺼져 있으면 보내도 보이지 않는다(실측: 이 PC는 DisabledForUser). 대표에게 알려 켜게 한다.
    const blocked = on ? toastBlocked() : null;
    if (on && !blocked)
      showToast(
        tr('Agent Company 알림을 켰습니다', 'Agent Company alerts on'),
        tr('대표가 할 일이 생기면 여기로 알려 드립니다.', 'You will be notified here when something needs you.'),
      );
    return { toast: on, blocked };
  }

  private lastTodoKeys: Set<string> | null = null;
  private todoCheckedAt = 0;

  /** 새 할 일이 생기면 토스트로 알린다(켜 둔 경우만, 5초마다, 처음 한 번은 기록만). */
  notifyNewTodos(): void {
    if (Date.now() - this.todoCheckedAt < 5000) return;
    this.todoCheckedAt = Date.now();
    const todos = this.ceoTodos();
    const prev = this.lastTodoKeys;
    this.lastTodoKeys = new Set(todos.map((x) => x.key));
    if (!prev || !this.toastOn) return;
    const fresh = todos.filter((x) => !prev.has(x.key));
    for (const x of fresh.slice(0, 3)) showToast(tr('대표가 할 일', 'Needs you'), x.title);
  }

  /** 요청 하나의 업무가 모두 끝나면 알린다(게임 프로젝트면 고급 QA 자동 실행의 계기). */
  checkRequestDone(ticketId: string): void {
    const req = this.h.records.requests(200).find((r) => r.ticketIds.includes(ticketId));
    if (!req || !req.ticketIds.length) return;
    const tickets = req.ticketIds.map((id) => this.h.company.store.get<Ticket>('tickets', id)).filter((x): x is Ticket => Boolean(x));
    if (!tickets.every((x) => TERMINAL_STATUSES.includes(x.status))) return;
    if (this.h.company.store.getSetting(`request_done:${req.id}`)) return;
    this.h.company.store.setSetting(`request_done:${req.id}`, new Date().toISOString());
    const done = tickets.filter((x) => x.status === 'done').length;
    // 얼마나 들었는지도 함께(요청별 비용 보고): 합계와 업무별.
    const used = requestTokens(this.h.records, req);
    const ko = tr('ko', 'en') === 'ko';
    const each = Object.entries(used.byTicket)
      .map(([id, n]) => `${id} ${tokensText(n, ko)}`)
      .join(' · ');
    this.notice(
      tr(`요청이 끝났습니다 (${done}/${tickets.length} 완료)`, `Request finished (${done}/${tickets.length} done)`),
      `${req.text.slice(0, 120)}\n${tr(`토큰 약 ${tokensText(used.total, ko)} 사용`, `About ${tokensText(used.total, ko)} tokens used`)} (${each})`,
      '/',
    );
    this.h.onRequestDone(req, tickets);
  }
}

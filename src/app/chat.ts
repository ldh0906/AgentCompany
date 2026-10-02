// 사내 대화: 업무방(티켓마다), 1:1(대표↔직원), 그룹방(직원이나 대표가 연다), 전체방.
// - 직원끼리 주고받는 보고·검수 의견·반려 사유·권한 처리는 이벤트 로그에서 그대로 옮겨 온다(투영). 따로 쓰는 코드가 없다.
// - 대표·직원의 대화 메시지는 여기서 저장한다. 누가 답할지(멘션)는 오케스트레이터가 정한다.
// 대표는 모든 방을 본다(멤버가 아니어도).

import { randomBytes } from 'node:crypto';
import { tr } from '../core/i18n.ts';
import type { DomainEvent, Employee, Ticket } from '../core/types.ts';
import type { Store } from '../store/db.ts';

export type ChannelKind = 'general' | 'ticket' | 'dm' | 'group';

export interface Channel {
  id: string;
  kind: ChannelKind;
  name: string;
  projectId: string | null;
  ticketId: string | null;
  /** 직원 ID와 'ceo'. 대표는 멤버가 아니어도 모든 방을 본다. */
  members: string[];
  createdBy: string;
  topic: string;
  createdAt: string;
  lastMessageAt: string;
}

export type MessageKind =
  | 'chat' // 대화
  | 'report' // 작업 보고
  | 'review' // 검수 의견
  | 'feedback' // 반려·수정 요청
  | 'event' // 진행 상황(작게 표시)
  | 'permission' // 위임자의 권한 허용·차단 기록(많아서 기본으로 숨김)
  | 'steer' // 작업 중인 직원에게 보낸 지시
  | 'followup'; // 후속 업무 제안(대표가 업무로 만들 수 있음)

export interface ChatMessage {
  id: string;
  channelId: string;
  /** 'ceo' | 'system' | 직원 ID */
  author: string;
  text: string;
  kind: MessageKind;
  /** 멘션된 직원 ID와 'ceo' */
  mentions: string[];
  /** 본문의 T-12, D-abc 같은 참조 */
  refs: string[];
  createdAt: string;
  runId?: string | null;
  /** 후속 업무 제안 등 대표가 누를 수 있는 동작 */
  followUp?: {
    title: string;
    reason: string;
    projectId: string | null;
    ticketId: string | null;
    requestId?: string | null;
    dismissed?: boolean;
  } | null;
}

export const GENERAL = 'general';
export const ticketChannelId = (ticketId: string) => `t:${ticketId}`;
export const dmChannelId = (employeeId: string) => `dm:${employeeId}`;

const REF_RE = /\b(T-\d+|D-[0-9a-f]{6,})\b/g;

/** 본문에서 멘션을 찾는다. 이름에 공백이 있으므로(예: "Codex 검수") 긴 이름부터 맞춘다. */
export function parseMentions(text: string, employees: Pick<Employee, 'id' | 'name'>[], members: string[]): string[] {
  const out = new Set<string>();
  const names = [...employees].sort((a, b) => b.name.length - a.name.length);
  let rest = text;
  for (const e of names) {
    const tag = `@${e.name}`;
    if (rest.includes(tag)) {
      out.add(e.id);
      rest = rest.split(tag).join(' ');
    }
  }
  // \b는 한글 옆에서 동작하지 않는다: 뒤가 끝·공백·문장부호인지로 본다.
  const end = '(?=$|[\\s.,!?:;)\\]])';
  if (new RegExp(`@(대표|ceo)${end}`, 'i').test(rest)) out.add('ceo');
  if (new RegExp(`@(전체|all|here)${end}`, 'i').test(rest)) for (const m of members) out.add(m);
  return [...out];
}

export function parseRefs(text: string): string[] {
  return [...new Set(text.match(REF_RE) ?? [])];
}

export class Chat {
  private readonly store: Store;
  private readonly employees: () => Employee[];
  private readonly ticket: (id: string) => Ticket | null;
  /** 새 메시지가 생기면 부른다(화면 갱신). */
  onMessage: (m: ChatMessage) => void = () => {};

  constructor(store: Store, deps: { employees: () => Employee[]; ticket: (id: string) => Ticket | null }) {
    this.store = store;
    this.employees = deps.employees;
    this.ticket = deps.ticket;
    // 이 시점 이후의 이벤트는 실시간으로 옮긴다. 그 전 기록만 backfill 대상.
    if (!store.getSetting('chat_live_since')) store.setSetting('chat_live_since', String(store.events(undefined, 1).at(-1)?.seq ?? 0));
    store.onEvent((e) => this.project(e));
  }

  // ---- 방 ----

  channels(): Channel[] {
    return this.store.list<Channel>('channels', 'ORDER BY created_at');
  }

  channel(id: string): Channel | null {
    return this.store.get<Channel>('channels', id);
  }

  private save(c: Channel): Channel {
    this.store.put('channels', c.id, c, { created_at: c.createdAt });
    return c;
  }

  ensureGeneral(): Channel {
    return (
      this.channel(GENERAL) ??
      this.save({
        id: GENERAL,
        kind: 'general',
        name: tr('전체', 'All hands'),
        projectId: null,
        ticketId: null,
        members: [
          'ceo',
          ...this.employees()
            .filter((e) => !e.removedAt)
            .map((e) => e.id),
        ],
        createdBy: 'system',
        topic: tr('요청·결정·완료 소식이 모이는 방', 'Requests, decisions and completions'),
        createdAt: new Date().toISOString(),
        lastMessageAt: new Date().toISOString(),
      })
    );
  }

  /** 업무방: 담당·검수·책임자와 대표. 배정이 바뀌면 멤버를 더한다. */
  ensureTicketChannel(ticketId: string): Channel | null {
    const t = this.ticket(ticketId);
    if (!t) return null;
    const people = ['ceo', t.ownerId, t.assigneeId, t.reviewerId].filter((x): x is string => Boolean(x));
    const existing = this.channel(ticketChannelId(ticketId));
    if (existing) {
      const missing = people.filter((p) => !existing.members.includes(p));
      if (!missing.length && existing.name.endsWith(t.title)) return existing;
      return this.save({ ...existing, name: `${t.id} ${t.title}`, members: [...existing.members, ...missing] });
    }
    const now = new Date().toISOString();
    return this.save({
      id: ticketChannelId(ticketId),
      kind: 'ticket',
      name: `${t.id} ${t.title}`,
      projectId: t.projectId,
      ticketId: t.id,
      members: people,
      createdBy: 'system',
      topic: t.purpose.slice(0, 200),
      createdAt: now,
      lastMessageAt: now,
    });
  }

  ensureDm(employeeId: string): Channel {
    const e = this.employees().find((x) => x.id === employeeId);
    if (!e) throw new Error(tr('직원을 찾을 수 없습니다.', 'Employee not found.'));
    const now = new Date().toISOString();
    return (
      this.channel(dmChannelId(employeeId)) ??
      this.save({
        id: dmChannelId(employeeId),
        kind: 'dm',
        name: e.name,
        projectId: null,
        ticketId: null,
        members: ['ceo', employeeId],
        createdBy: 'ceo',
        topic: '',
        createdAt: now,
        lastMessageAt: now,
      })
    );
  }

  createGroup(input: {
    name: string;
    members: string[];
    createdBy: string;
    topic?: string;
    projectId?: string | null;
    ticketId?: string | null;
  }): Channel {
    const now = new Date().toISOString();
    const known = new Set(this.employees().map((e) => e.id));
    const members = [...new Set(['ceo', input.createdBy, ...input.members])].filter((m) => m === 'ceo' || known.has(m));
    return this.save({
      id: `g:${randomBytes(4).toString('hex')}`,
      kind: 'group',
      name: input.name.trim().slice(0, 60) || tr('그룹 방', 'Group'),
      projectId: input.projectId ?? null,
      ticketId: input.ticketId ?? null,
      members,
      createdBy: input.createdBy,
      topic: (input.topic ?? '').slice(0, 300),
      createdAt: now,
      lastMessageAt: now,
    });
  }

  addMembers(channelId: string, ids: string[]): Channel {
    const c = this.channel(channelId);
    if (!c) throw new Error(tr('방을 찾을 수 없습니다.', 'Channel not found.'));
    // 1:1 방은 대표와 그 직원만: 다른 직원을 들이지 않는다(대표 요청 2026-10-03)
    if (c.kind === 'dm' && ids.some((id) => !c.members.includes(id)))
      throw new Error(
        tr('1:1 방에는 다른 사람을 들일 수 없습니다. 그룹 방을 만들어 주세요.', 'A 1:1 room cannot take more members. Open a group room.'),
      );
    return this.save({ ...c, members: [...new Set([...c.members, ...ids])] });
  }

  // ---- 메시지 ----

  messages(channelId: string, limit = 300): ChatMessage[] {
    const rows = this.store.list<ChatMessage>('chat', 'WHERE channel_id = ? ORDER BY rowid DESC LIMIT ?', channelId, limit);
    return rows.reverse();
  }

  /** 모든 방의 마지막 메시지 시각·최근 메시지(목록용). */
  recent(limit = 400): ChatMessage[] {
    return this.store.list<ChatMessage>('chat', 'ORDER BY rowid DESC LIMIT ?', limit).reverse();
  }

  post(
    channelId: string,
    author: string,
    text: string,
    kind: MessageKind = 'chat',
    extra: { runId?: string | null; followUp?: ChatMessage['followUp']; at?: string } = {},
  ): ChatMessage {
    const c = this.channel(channelId);
    if (!c) throw new Error(tr('방을 찾을 수 없습니다.', 'Channel not found.'));
    const m: ChatMessage = {
      id: `M-${Date.now().toString(36)}${randomBytes(3).toString('hex')}`,
      channelId,
      author,
      text: text.slice(0, 8000),
      kind,
      mentions: parseMentions(text, this.employees(), c.members),
      refs: parseRefs(text),
      createdAt: extra.at ?? new Date().toISOString(),
      runId: extra.runId ?? null,
      followUp: extra.followUp ?? null,
    };
    this.store.put('chat', m.id, m, { channel_id: channelId, created_at: m.createdAt });
    if (m.createdAt > c.lastMessageAt) this.save({ ...c, lastMessageAt: m.createdAt });
    this.onMessage(m);
    return m;
  }

  // ---- 이벤트 → 대화 ----

  /** 대화 기능이 생기기 전의 기록도 방에 채운다(한 번만). */
  backfill(events: DomainEvent[]): void {
    if (this.store.getSetting('chat_backfilled')) return;
    this.store.transact(() => {
      const liveSince = Number(this.store.getSetting('chat_live_since') ?? 0);
      for (const e of events) if (e.seq <= liveSince) this.project(e);
      this.store.setSetting('chat_backfilled', new Date().toISOString());
    });
  }

  /** 직원끼리 오가는 보고·검수·반려와 진행 상황을 업무방에 옮긴다. */
  project(e: DomainEvent): void {
    const p = (e.payload ?? {}) as Record<string, unknown>;
    const s = (v: unknown) => (typeof v === 'string' ? v : '');
    const toTicket = (author: string, text: string, kind: MessageKind) => {
      if (!e.entityId.startsWith('T-') || !text.trim()) return;
      const c = this.ensureTicketChannel(e.entityId);
      if (c) this.post(c.id, author, text, kind, { at: e.ts });
    };
    const toGeneral = (author: string, text: string, kind: MessageKind = 'event') => {
      if (!text.trim()) return;
      this.ensureGeneral();
      this.post(GENERAL, author, text, kind, { at: e.ts });
    };
    switch (e.type) {
      case 'ticket.created':
        toTicket('system', tr(`업무가 만들어졌습니다: ${s(p.title)}`, `Ticket created: ${s(p.title)}`), 'event');
        return;
      case 'ticket.assigned':
        toTicket('system', tr('담당·검수가 배정되었습니다.', 'Assignee and reviewer set.'), 'event');
        return;
      case 'run.work.succeeded':
        toTicket(e.actor, s(p.summary), 'report');
        return;
      case 'run.review.succeeded':
        toTicket(e.actor, s(p.summary), 'review');
        return;
      case 'run.work.failed':
      case 'run.review.failed':
        toTicket(
          'system',
          tr(
            `실행 실패(${s(p.failureClass)}): ${s(p.detail).slice(0, 300)}`,
            `Run failed (${s(p.failureClass)}): ${s(p.detail).slice(0, 300)}`,
          ),
          'event',
        );
        return;
      case 'ticket.changes_requested':
        // 검수자의 의견은 run.review.succeeded로 이미 옮겼다. 대표 반려와 시스템 검증 실패만.
        if (p.source === 'ceo') toTicket('ceo', tr(`반려: ${s(p.reason)}`, `Rejected: ${s(p.reason)}`), 'feedback');
        else if (p.source === 'verification') toTicket('system', s(p.reason).slice(0, 1500), 'feedback');
        return;
      case 'ticket.held':
        if (p.reason === 'needs_decision')
          toTicket(
            'system',
            tr(
              '대표 결정이 필요해 멈췄습니다. 업무 화면이나 이 방에서 답해 주세요.',
              'Paused for a CEO decision. Answer on the ticket page or here.',
            ),
            'event',
          );
        return;
      case 'ticket.awaiting_approval':
        toTicket('system', tr('검수 통과 → 대표 승인 대기', 'Review passed → awaiting CEO approval'), 'event');
        return;
      case 'ticket.done':
        toTicket('system', tr('완료 · 원본에 반영되었습니다.', 'Done · integrated.'), 'event');
        toGeneral('system', tr(`${e.entityId} 완료`, `${e.entityId} done`));
        return;
      case 'approval.delegated':
        toTicket(
          e.actor,
          p.allow
            ? tr(`권한 허용: ${s(p.command) || s(p.summary)}`, `Allowed: ${s(p.command) || s(p.summary)}`)
            : tr(`⛔ 권한 차단: ${s(p.reason)}`, `⛔ Blocked: ${s(p.reason)}`),
          'permission',
        );
        return;
      case 'request.submitted':
        toGeneral('ceo', tr(`비서실장에게 요청: ${s(p.text)}`, `Request to chief of staff: ${s(p.text)}`), 'chat');
        return;
      case 'request.drafted':
        toGeneral(
          e.actor,
          tr(
            `업무 초안 ${String(p.count ?? '')}개를 만들었습니다. 대시보드에서 확정해 주세요.`,
            `Drafted ${String(p.count ?? '')} tickets. Confirm on the dashboard.`,
          ),
        );
        return;
      case 'company.paused':
        toGeneral(
          'ceo',
          tr(
            '회사 전체를 일시정지했습니다. 진행 중인 실행만 마무리하고 새 작업은 시작하지 않습니다.',
            'Company paused: running work finishes, nothing new starts.',
          ),
          'chat',
        );
        return;
      case 'company.resumed':
        toGeneral('ceo', tr('일시정지를 풀었습니다. 다시 일을 시작합니다.', 'Company resumed.'), 'chat');
        return;
      case 'decision.recorded':
        toGeneral('ceo', tr(`결정: ${s(p.text)}`, `Decision: ${s(p.text)}`), 'chat');
        return;
    }
  }
}

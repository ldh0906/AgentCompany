// 사내 대화: 직원끼리 오가는 보고·검수·질문을 보고, 끼어들고, 1:1로 묻고, 그룹 방을 연다.
// 편의 기능: @멘션·#업무 자동완성, / 명령(결정·요청·방·지시), 메시지로 결정 기록·업무 만들기, 답장 인용,
// 안 읽은 방·나를 부른 메시지 표시, 답장 작성 중·작업 중 표시, 진행 기록 숨기기, 방 검색.
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, type Channel, type ChatMessage, type Employee } from '../api.ts';
import { Link, useCompany, useRoute } from '../App.tsx';
import { useT } from '../i18n.ts';
import { Avatar, EmptyState, Icon, Modal, Skeleton, useAction, when } from '../components/ui.tsx';
import { ChipToggles } from '../components/kit.tsx';
import { isUnread, markRead, unreadMentions } from '../components/unread.ts';

const KIND_LABEL: Record<string, [string, string]> = {
  report: ['작업 보고', 'Report'],
  review: ['검수 의견', 'Review'],
  feedback: ['반려·수정 요청', 'Changes requested'],
  steer: ['작업 중 지시', 'Mid-run instruction'],
  followup: ['후속 업무 제안', 'Follow-up'],
};

const SLASH: { cmd: string; ko: string; en: string }[] = [
  { cmd: '/결정 ', ko: '/결정 내용 — 프로젝트 규칙으로 남김(모든 직원이 따름)', en: '/결정 text — record a decision' },
  { cmd: '/요청 ', ko: '/요청 내용 — 비서실장에게 업무 초안 요청', en: '/요청 text — ask the chief of staff for drafts' },
  { cmd: '/방 ', ko: '/방 이름 @직원 @직원 — 그룹 방 열기', en: '/방 name @a @b — open a group room' },
  { cmd: '/지시 ', ko: '/지시 @직원 내용 — 작업 중인 직원에게 지시', en: '/지시 @name text — steer a working employee' },
];

export function ChatPage({ channelId }: { channelId: string | null }) {
  const { state, reload } = useCompany();
  const { lang } = useT();
  const { go } = useRoute();
  const ko = lang === 'ko';
  const [channels, setChannels] = useState<Channel[] | null>(null);
  const [filter, setFilter] = useState('');
  const [creating, setCreating] = useState(false);

  // 방 목록: 상태가 바뀔 때마다(새 메시지·새 업무) 다시 받는다.
  useEffect(() => {
    void api<Channel[]>('channels').then(setChannels);
  }, [state?.channels?.length, state?.tickets.length]);
  const list = useMemo(() => {
    const byId = new Map((channels ?? []).map((c) => [c.id, c]));
    for (const c of state?.channels ?? []) byId.set(c.id, c);
    return [...byId.values()];
  }, [channels, state?.channels]);

  if (!state || channels === null) return <Skeleton />;
  const employees = state.employees.filter((e) => !e.removedAt);
  const current = channelId ? list.find((c) => c.id === channelId) : list.find((c) => c.kind === 'general');
  const mentions = unreadMentions(state.mentions);
  const openTicket = (c: Channel) => {
    const t = state.tickets.find((x) => x.id === c.ticketId);
    return t && !['done', 'failed', 'cancelled'].includes(t.status);
  };
  const q = filter.trim().toLowerCase();
  const match = (c: Channel) => !q || c.name.toLowerCase().includes(q);
  const sections: [string, Channel[]][] = [
    [ko ? '공용' : 'Company', list.filter((c) => c.kind === 'general')],
    [ko ? '그룹 방' : 'Groups', list.filter((c) => c.kind === 'group').sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt))],
    [
      ko ? '진행 중인 업무방' : 'Open tickets',
      list.filter((c) => c.kind === 'ticket' && openTicket(c)).sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt)),
    ],
    [
      ko ? '지난 업무방' : 'Past tickets',
      list.filter((c) => c.kind === 'ticket' && !openTicket(c)).sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt)),
    ],
  ];
  const dmOf = (e: Employee) => list.find((c) => c.id === `dm:${e.id}`);
  const openDm = (e: Employee) =>
    void api<Channel>(`dm/${e.id}`, { body: {} }).then((c) => (reload(), go(`/chat/${encodeURIComponent(c.id)}`)));

  return (
    <div className="chat-layout">
      <aside className="chat-side">
        <div className="row" style={{ marginBottom: 8 }}>
          <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={ko ? '방 찾기' : 'Find a room'} />
          <button className="btn small" onClick={() => setCreating(true)} title={ko ? '그룹 방 만들기' : 'New group'}>
            <Icon name="plus" size={13} />
          </button>
        </div>
        {mentions.length > 0 && (
          <div className="chat-mentions">
            <b>{ko ? `나를 부른 메시지 ${mentions.length}` : `${mentions.length} mentions`}</b>
            {mentions.slice(-3).map((m) => (
              <a key={m.id} onClick={() => go(`/chat/${encodeURIComponent(m.channelId)}`)}>
                {nameOf(state.employees, m.author, ko)}: {m.text.slice(0, 50)}
              </a>
            ))}
          </div>
        )}
        {sections.map(([title, cs]) =>
          cs.filter(match).length ? (
            <div key={title} className="chat-section">
              <div className="nav-label">{title}</div>
              {cs.filter(match).map((c) => (
                <ChannelRow key={c.id} c={c} active={current?.id === c.id} onClick={() => go(`/chat/${encodeURIComponent(c.id)}`)} />
              ))}
            </div>
          ) : null,
        )}
        <div className="chat-section">
          <div className="nav-label">{ko ? '1:1 대화' : 'Direct'}</div>
          {employees
            .filter((e) => !q || e.name.toLowerCase().includes(q))
            .map((e) => {
              const dm = dmOf(e);
              return (
                <button key={e.id} className={`chat-row ${current?.id === `dm:${e.id}` ? 'on' : ''}`} onClick={() => openDm(e)}>
                  <Avatar employees={state.employees} id={e.id} /> <span className="name">{e.name}</span>
                  {dm && isUnread(dm) && current?.id !== dm.id && <span className="dot" />}
                </button>
              );
            })}
        </div>
      </aside>
      <section className="chat-main">
        {current ? (
          <Room key={current.id} channel={current} />
        ) : (
          <EmptyState icon="inbox">{ko ? '방을 고르세요' : 'Pick a room'}</EmptyState>
        )}
      </section>
      {creating && (
        <NewRoomModal onClose={() => setCreating(false)} onCreated={(c) => (setCreating(false), go(`/chat/${encodeURIComponent(c.id)}`))} />
      )}
    </div>
  );
}

function nameOf(employees: Employee[], id: string, ko: boolean): string {
  if (id === 'ceo') return ko ? '대표' : 'CEO';
  if (id === 'system') return ko ? '시스템' : 'System';
  return employees.find((e) => e.id === id)?.name ?? id;
}

function ChannelRow({ c, active, onClick }: { c: Channel; active: boolean; onClick: () => void }) {
  const unread = !active && isUnread(c);
  return (
    <button className={`chat-row ${active ? 'on' : ''} ${unread ? 'unread' : ''}`} onClick={onClick}>
      <span className="hash">{c.kind === 'group' ? '◆' : c.kind === 'general' ? '#' : '▸'}</span>
      <span className="name">{c.name}</span>
      {unread && <span className="dot" />}
    </button>
  );
}

function Room({ channel }: { channel: Channel }) {
  const { state, reload } = useCompany();
  const { lang } = useT();
  const { go } = useRoute();
  const ko = lang === 'ko';
  const [messages, setMessages] = useState<ChatMessage[] | null>(null);
  // 권한 처리 기록(위임자가 허용·차단한 명령)은 많아서 기본으로 숨긴다. 진행 상황(시스템)은 늘 보인다.
  const [showPerms, setShowPerms] = useState(false);
  const [deciding, setDeciding] = useState<string | null>(null);
  const [quote, setQuote] = useState<string>('');
  const bodyRef = useRef<HTMLDivElement>(null);
  const { run } = useAction();

  const load = () => void api<ChatMessage[]>(`channels/${encodeURIComponent(channel.id)}/messages`).then(setMessages);
  useEffect(load, [channel.id, channel.lastMessageAt]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (messages?.length) markRead(channel.id, messages.at(-1)!.createdAt);
    // 새 메시지가 오면 맨 아래로(방 안에서만 스크롤)
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, channel.id]);

  if (!state) return null;
  const employees = state.employees;
  const typing = state.runs.filter((r) => r.kind === 'chat' && r.status === 'running' && r.ticketId === channel.id);
  const working = channel.ticketId
    ? state.runs.filter((r) => r.ticketId === channel.ticketId && r.status === 'running' && r.kind !== 'chat')
    : [];
  // 예전 기록은 권한 처리도 event로 저장돼 있어 글머리로도 가린다.
  const isPerm = (m: ChatMessage) =>
    m.kind === 'permission' ||
    (m.kind === 'event' && m.author !== 'system' && /^(권한 허용|⛔ 권한 차단|Allowed:|⛔ Blocked)/.test(m.text));
  const shown = (messages ?? []).filter((m) => showPerms || !isPerm(m));
  const permCount = (messages ?? []).filter(isPerm).length;
  const ticket = channel.ticketId ? state.tickets.find((t) => t.id === channel.ticketId) : null;

  return (
    <div className="room">
      <header className="room-head">
        <div>
          <div className="title">
            {channel.kind === 'dm' ? `${ko ? '1:1' : 'DM'} · ${channel.name}` : channel.name}
            {ticket && (
              <Link to={`/tickets/${ticket.id}`} className="chip">
                {ko ? '업무 보기' : 'Open ticket'}
              </Link>
            )}
          </div>
          {channel.topic && <div className="sub">{channel.topic}</div>}
        </div>
        <div className="row">
          <span className="members">
            {channel.members.map((m) =>
              m === 'ceo' ? (
                <span key={m} className="avatar ceo" title={ko ? '대표' : 'CEO'}>
                  ★
                </span>
              ) : (
                <Avatar key={m} employees={employees} id={m} />
              ),
            )}
          </span>
          <label className="check-row small">
            <input type="checkbox" checked={showPerms} onChange={() => setShowPerms(!showPerms)} />
            {ko ? `권한 처리 보기 (${permCount})` : `Permissions (${permCount})`}
          </label>
        </div>
      </header>

      <div className="room-body" ref={bodyRef}>
        {messages === null ? (
          <Skeleton />
        ) : shown.length === 0 ? (
          <EmptyState icon="inbox">
            {channel.kind === 'dm'
              ? ko
                ? `${channel.name}에게 무엇이든 물어보세요. 프로젝트를 읽고 답합니다(읽기 전용).`
                : `Ask ${channel.name} anything. They read the project (read-only) and reply.`
              : ko
                ? '아직 대화가 없습니다.'
                : 'No messages yet.'}
          </EmptyState>
        ) : (
          shown.map((m, i) => (
            <Message
              key={m.id}
              m={m}
              prev={shown[i - 1]}
              onDecide={() => setDeciding(m.text)}
              onQuote={() => setQuote(`> ${nameOf(employees, m.author, ko)}: ${m.text.split('\n')[0]!.slice(0, 120)}\n`)}
              onFollowUp={() =>
                run(
                  () => api(`chat/${m.id}/followup`, { body: {} }),
                  ko ? '비서실장에게 업무 초안을 요청했습니다.' : 'Sent to the chief of staff.',
                ).then(() => (load(), reload()))
              }
            />
          ))
        )}
      </div>

      {(typing.length > 0 || working.length > 0) && (
        <div className="room-status">
          {typing.map((r) => (
            <span key={r.id} className="typing">
              {nameOf(employees, r.employeeId, ko)} {ko ? '답장 쓰는 중' : 'is typing'}
              <i />
              <i />
              <i />
            </span>
          ))}
          {working.map((r) => (
            <a key={r.id} className="chip info" onClick={() => go(`/live/${r.id}`)}>
              {nameOf(employees, r.employeeId, ko)} {r.kind === 'review' ? (ko ? '검수 중' : 'reviewing') : ko ? '작업 중' : 'working'} ·{' '}
              {ko ? '로그 보기' : 'log'}
            </a>
          ))}
        </div>
      )}

      <Composer channel={channel} quote={quote} onSent={() => (setQuote(''), load(), reload())} />

      {deciding !== null && (
        <DecisionModal
          text={deciding}
          projectId={channel.projectId ?? state.projects[0]?.id ?? null}
          source={channel.id}
          onClose={() => setDeciding(null)}
        />
      )}
    </div>
  );
}

/** 본문: @멘션 강조, T-12·D-xxx 링크, 코드 블록. */
function RichText({ text }: { text: string }) {
  const { state } = useCompany();
  const names = [...(state?.employees ?? []).map((e) => e.name), '대표', '전체', 'CEO', 'all'].sort((a, b) => b.length - a.length);
  const parts = text.split(/(```[\s\S]*?```)/g);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith('```') ? (
          <pre key={i} className="code">
            {p.replace(/^```\w*\n?|```$/g, '')}
          </pre>
        ) : (
          <span key={i}>{inline(p, names)}</span>
        ),
      )}
    </>
  );
}

function inline(text: string, names: string[]): React.ReactNode[] {
  const esc = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const re = new RegExp(`(@(?:${esc.join('|')})|\\bT-\\d+\\b|\\bD-[0-9a-f]{6,}\\b)`, 'g');
  const out: React.ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    out.push(text.slice(last, m.index));
    const tok = m[0];
    out.push(
      tok.startsWith('@') ? (
        <span key={m.index} className="mention">
          {tok}
        </span>
      ) : tok.startsWith('T-') ? (
        <Link key={m.index} to={`/tickets/${tok}`}>
          {tok}
        </Link>
      ) : (
        <Link key={m.index} to="/projects">
          {tok}
        </Link>
      ),
    );
    last = (m.index ?? 0) + tok.length;
  }
  out.push(text.slice(last));
  return out;
}

function Message({
  m,
  prev,
  onDecide,
  onQuote,
  onFollowUp,
}: {
  m: ChatMessage;
  prev?: ChatMessage;
  onDecide: () => void;
  onQuote: () => void;
  onFollowUp: () => void;
}) {
  const { state } = useCompany();
  const { lang } = useT();
  const ko = lang === 'ko';
  const employees = state?.employees ?? [];
  if (m.kind === 'event' || m.kind === 'permission')
    return (
      <div className="msg-event">
        <span>{m.author !== 'system' ? `${nameOf(employees, m.author, ko)} · ` : ''}</span>
        <RichText text={m.text} />
        <span className="time">{new Date(m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
      </div>
    );
  const grouped =
    prev && prev.author === m.author && prev.kind !== 'event' && Date.parse(m.createdAt) - Date.parse(prev.createdAt) < 5 * 60_000;
  const label = KIND_LABEL[m.kind];
  return (
    <div className={`msg ${grouped ? 'grouped' : ''} kind-${m.kind} ${m.mentions.includes('ceo') && m.author !== 'ceo' ? 'to-me' : ''}`}>
      <div className="msg-avatar">
        {!grouped &&
          (m.author === 'ceo' ? (
            <span className="avatar ceo">★</span>
          ) : m.author === 'system' ? (
            <span className="avatar">⚙</span>
          ) : (
            <Avatar employees={employees} id={m.author} />
          ))}
      </div>
      <div className="msg-main">
        {!grouped && (
          <div className="msg-head">
            <b>{nameOf(employees, m.author, ko)}</b>
            {label && <span className={`chip kind-${m.kind}`}>{ko ? label[0] : label[1]}</span>}
            <span className="time">{when(m.createdAt)}</span>
          </div>
        )}
        <div className="msg-text">
          <RichText text={m.text} />
        </div>
        {m.followUp && (
          <div className="row" style={{ marginTop: 6 }}>
            {m.followUp.requestId ? (
              <span className="chip ok">
                {ko ? `비서실장에게 요청함 (${m.followUp.requestId})` : `Requested (${m.followUp.requestId})`}
              </span>
            ) : (
              <button className="btn small primary" onClick={onFollowUp}>
                <Icon name="plus" size={12} /> {ko ? '업무로 만들기 (비서실장에게)' : 'Make it a ticket'}
              </button>
            )}
          </div>
        )}
        <div className="msg-actions">
          <button onClick={onQuote}>{ko ? '답장' : 'Reply'}</button>
          <button onClick={onDecide}>{ko ? '규칙으로 남기기' : 'Record decision'}</button>
          <button onClick={() => void navigator.clipboard?.writeText(m.text)}>{ko ? '복사' : 'Copy'}</button>
        </div>
      </div>
    </div>
  );
}

function Composer({ channel, quote, onSent }: { channel: Channel; quote: string; onSent: () => void }) {
  const { state, reload } = useCompany();
  const { lang } = useT();
  const { go } = useRoute();
  const ko = lang === 'ko';
  const { busy, run } = useAction();
  const [text, setText] = useState('');
  const [caret, setCaret] = useState(0);
  const [pick, setPick] = useState(0);
  const ta = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (quote) {
      setText((t) => quote + t);
      ta.current?.focus();
    }
  }, [quote]);
  if (!state) return null;
  const employees = state.employees.filter((e) => !e.removedAt && e.active);

  // 자동완성: 커서 앞 단어가 @… / #… / (맨 앞) /…
  const before = text.slice(0, caret);
  const at = before.match(/@([^\s@]*)$/);
  const hash = before.match(/#(T?-?\d*)$/i);
  const slash = /^\/[^\s]*$/.test(before) ? before : null;
  const members = channel.members;
  const suggestions: { label: string; insert: string; hint?: string }[] = at
    ? [
        ...employees
          .filter((e) => e.name.toLowerCase().includes(at[1]!.toLowerCase()))
          .sort((a, b) => Number(members.includes(b.id)) - Number(members.includes(a.id)))
          .map((e) => ({ label: `@${e.name}`, insert: `@${e.name} `, hint: e.roles.join('·') })),
        ...['전체', '대표'].filter((x) => x.includes(at[1]!)).map((x) => ({ label: `@${x}`, insert: `@${x} ` })),
      ].slice(0, 8)
    : hash
      ? state.tickets
          .filter((t) => `${t.id} ${t.title}`.toLowerCase().includes(hash[1]!.toLowerCase().replace(/^#/, '')))
          .slice(-8)
          .reverse()
          .map((t) => ({ label: `${t.id} ${t.title}`, insert: `${t.id} ` }))
      : slash
        ? SLASH.filter((s) => s.cmd.startsWith(slash)).map((s) => ({ label: ko ? s.ko : s.en, insert: s.cmd }))
        : [];
  const apply = (s: { insert: string }) => {
    const start = at ? caret - at[0].length : hash ? caret - hash[0].length : 0;
    const next = text.slice(0, start) + s.insert + text.slice(caret);
    setText(next);
    const pos = start + s.insert.length;
    setCaret(pos);
    setPick(0);
    requestAnimationFrame(() => ta.current?.setSelectionRange(pos, pos));
  };

  const projectId = channel.projectId ?? state.projects[0]?.id ?? null;
  const mentionIds = (s: string) => employees.filter((e) => s.includes(`@${e.name}`)).map((e) => e.id);
  const send = () => {
    const body = text.trim();
    if (!body) return;
    const done = (ok: boolean) => ok && (setText(''), onSent());
    if (body.startsWith('/결정 ')) {
      if (!projectId) return;
      return void run(
        () => api('decisions', { body: { projectId, text: body.slice(4).trim(), sourceRefs: [channel.id] } }),
        ko ? '규칙으로 남겼습니다.' : 'Decision recorded.',
      ).then(done);
    }
    if (body.startsWith('/요청 ')) {
      if (!projectId) return;
      return void run(
        () => api('requests', { body: { projectId, text: body.slice(4).trim() } }),
        ko ? '비서실장에게 보냈습니다.' : 'Sent.',
      ).then(done);
    }
    if (body.startsWith('/방 ')) {
      const name =
        employees
          .reduce((s, e) => s.split(`@${e.name}`).join(' '), body.slice(3))
          .replace(/\s+/g, ' ')
          .trim() || (ko ? '새 방' : 'Room');
      return void run(async () => {
        const c = await api<Channel>('channels', { body: { name, members: mentionIds(body), projectId } });
        reload();
        go(`/chat/${encodeURIComponent(c.id)}`);
      }).then(done);
    }
    if (body.startsWith('/지시 ')) {
      const who = mentionIds(body)[0];
      const live = state.runs.find((r) => r.employeeId === who && r.status === 'running' && r.kind !== 'chat');
      if (!who || !live)
        return void run(async () => Promise.reject(new Error(ko ? '작업 중인 직원을 @로 지정하세요.' : 'Mention a working employee.')));
      const msg = body.replace(/^\/지시\s+/, '');
      return void run(() => api(`runs/${live.id}/steer`, { body: { text: msg } }), ko ? '지시를 보냈습니다.' : 'Sent.').then(done);
    }
    void run(() => api(`channels/${encodeURIComponent(channel.id)}/messages`, { body: { text: body } })).then(done);
  };

  const hint =
    channel.kind === 'dm'
      ? ko
        ? `${channel.name}에게 보내기 — 늘 답합니다`
        : `Message ${channel.name} — they always reply`
      : ko
        ? '@이름 으로 부르면 그 직원이 답합니다. 작업 중이면 지시로 전달 · # 업무 · / 명령'
        : '@name gets a reply (steers them if working) · # ticket · / commands';
  return (
    <div className="composer">
      {suggestions.length > 0 && (
        <div className="suggest">
          {suggestions.map((s, i) => (
            <button key={s.label} className={i === pick ? 'on' : ''} onMouseDown={(e) => (e.preventDefault(), apply(s))}>
              {s.label}
              {s.hint && <span className="sub"> {s.hint}</span>}
            </button>
          ))}
        </div>
      )}
      <textarea
        ref={ta}
        value={text}
        rows={Math.min(6, Math.max(2, text.split('\n').length))}
        placeholder={hint}
        onChange={(e) => {
          setText(e.target.value);
          setCaret(e.target.selectionStart);
          setPick(0);
        }}
        onClick={(e) => setCaret(e.currentTarget.selectionStart)}
        onKeyUp={(e) => setCaret(e.currentTarget.selectionStart)}
        onKeyDown={(e) => {
          if (suggestions.length && ['ArrowDown', 'ArrowUp', 'Tab'].includes(e.key)) {
            e.preventDefault();
            if (e.key === 'Tab') apply(suggestions[pick]!);
            else setPick((p) => (p + (e.key === 'ArrowDown' ? 1 : suggestions.length - 1)) % suggestions.length);
            return;
          }
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            if (suggestions.length && (at || hash || slash)) apply(suggestions[pick]!);
            else send();
          }
        }}
      />
      <button className="btn primary" disabled={busy || !text.trim()} onClick={send}>
        {ko ? '보내기' : 'Send'}
      </button>
    </div>
  );
}

function DecisionModal({
  text,
  projectId,
  source,
  onClose,
}: {
  text: string;
  projectId: string | null;
  source: string;
  onClose: () => void;
}) {
  const { lang } = useT();
  const ko = lang === 'ko';
  const { busy, run } = useAction();
  const [value, setValue] = useState(text);
  return (
    <Modal
      title={ko ? '규칙으로 남기기' : 'Record a decision'}
      onClose={onClose}
      actions={
        <button
          className="btn primary"
          disabled={busy || !value.trim() || !projectId}
          onClick={() =>
            run(
              () => api('decisions', { body: { projectId, text: value.trim(), sourceRefs: [source] } }),
              ko ? '규칙으로 남겼습니다.' : 'Recorded.',
            ).then((ok) => ok && onClose())
          }
        >
          {ko ? '기록' : 'Record'}
        </button>
      }
    >
      <div className="form">
        <textarea value={value} onChange={(e) => setValue(e.target.value)} autoFocus />
        <div className="hint">
          {ko
            ? '규칙은 프로젝트 화면에 모이고, 이후 모든 직원(검수자 포함)이 따릅니다.'
            : 'Current decisions reach every employee, reviewers included.'}
        </div>
      </div>
    </Modal>
  );
}

function NewRoomModal({ onClose, onCreated }: { onClose: () => void; onCreated: (c: Channel) => void }) {
  const { state, reload } = useCompany();
  const { lang } = useT();
  const ko = lang === 'ko';
  const { busy, run } = useAction();
  const [name, setName] = useState('');
  const [topic, setTopic] = useState('');
  const [members, setMembers] = useState<string[]>([]);
  const [projectId, setProjectId] = useState(state?.projects[0]?.id ?? '');
  if (!state) return null;
  return (
    <Modal
      title={ko ? '그룹 방 만들기' : 'New group room'}
      onClose={onClose}
      actions={
        <button
          className="btn primary"
          disabled={busy || !name.trim() || !members.length}
          onClick={() =>
            run(async () => {
              const c = await api<Channel>('channels', { body: { name, topic, members, projectId: projectId || null } });
              reload();
              onCreated(c);
            })
          }
        >
          {ko ? '만들기' : 'Create'}
        </button>
      }
    >
      <div className="form">
        <label>
          {ko ? '방 이름' : 'Name'}
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={ko ? '예: 디자인 싱크' : 'e.g. Design sync'}
            autoFocus
          />
        </label>
        <label>
          {ko ? '주제' : 'Topic'}
          <input value={topic} onChange={(e) => setTopic(e.target.value)} />
        </label>
        {state.projects.length > 1 && (
          <label>
            {ko ? '프로젝트(직원이 읽을 저장소)' : 'Project (what they read)'}
            <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              {state.projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          {ko ? '멤버' : 'Members'}
          <ChipToggles
            options={state.employees.filter((e) => e.active && !e.removedAt).map((e) => ({ value: e.id, label: e.name }))}
            selected={members}
            onToggle={(v) => setMembers(members.includes(v) ? members.filter((x) => x !== v) : [...members, v])}
          />
        </label>
        <div className="hint">
          {ko
            ? '대표는 모든 방을 봅니다. 방에서 @이름으로 부르면 그 직원이 답합니다.'
            : 'You can see every room. Mention someone with @name to get their reply.'}
        </div>
      </div>
    </Modal>
  );
}

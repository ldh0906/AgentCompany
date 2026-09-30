// 대화방 읽음 표시(이 브라우저에만 저장). 방마다 마지막으로 본 시각.
import type { Channel, ChatMessage } from '../api.ts';

const KEY = 'ac-chat-read';

function load(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, string>;
  } catch {
    return {};
  }
}

export function markRead(channelId: string, at = new Date().toISOString()): void {
  try {
    const all = load();
    if ((all[channelId] ?? '') < at) {
      all[channelId] = at;
      localStorage.setItem(KEY, JSON.stringify(all));
    }
  } catch {
    // 저장 불가(사생활 보호 모드 등): 읽음 표시 없이 동작
  }
}

export function isUnread(c: Channel): boolean {
  const read = load()[c.id];
  // 처음 보는 방은 만든 뒤 대화가 있었을 때만 안 읽음
  return read ? c.lastMessageAt > read : c.lastMessageAt > c.createdAt;
}

/** 대표를 부른 메시지 중 아직 안 본 것 */
export function unreadMentions(mentions: ChatMessage[] = []): ChatMessage[] {
  const read = load();
  return mentions.filter((m) => m.createdAt > (read[m.channelId] ?? ''));
}

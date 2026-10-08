// 실행 중인 직원이 지금 무엇을 하는지(무엇을 기다리는지) 나눈다. 순수 함수.
// 전에는 출력이 끊긴 시간만 봐서, 대표 허락을 기다리는 직원과 끝나지 않는 명령에 걸린 직원이 똑같이 "멈췄을 수 있음"이었다.
// OpenRig 비교(2026-10-08): 관측 근거를 우선순위로 따지고, 근거가 없으면 "알 수 없음"으로 둔다(seat-activity-service).

export type RunStateKind = 'working' | 'waiting_ceo' | 'waiting_colleague' | 'running_command' | 'quiet' | 'unknown';

export interface RunState {
  kind: RunStateKind;
  /** 마지막 출력 뒤로 지난 시간(ms) */
  quietMs: number;
  /** 무엇을 기다리는지·어떤 명령인지(사람이 읽는 한 줄) */
  detail: string;
}

/** 대표에게 "멈췄을 수 있다"고 알릴 상태: 기다리는 대상이 분명한 상태(대표 허락·동료 답)는 아니다. */
export const STUCK_KINDS: RunStateKind[] = ['running_command', 'quiet', 'unknown'];

const obj = (v: unknown): Record<string, any> | null => (v && typeof v === 'object' ? (v as Record<string, any>) : null);
const oneLine = (s: unknown, n = 160) => {
  const t = String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

/**
 * 시작했지만 결과가 아직 없는 도구 호출(마지막 것). Claude: tool_use ↔ tool_result(tool_use_id),
 * Codex 중계기: item.started ↔ item.completed(같은 item.id). 없으면 null.
 */
export function openCall(events: unknown[]): string | null {
  const open = new Map<string, string>();
  for (const raw of events) {
    const e = obj(raw);
    if (!e) continue;
    if (e.type === 'assistant' && obj(e.message)) {
      for (const c of (e.message.content ?? []) as Record<string, any>[]) {
        if (c?.type !== 'tool_use' || !c.id) continue;
        const input = obj(c.input);
        open.set(String(c.id), oneLine(input?.command ?? input?.file_path ?? input?.description ?? c.name));
      }
    } else if (e.type === 'user' && obj(e.message)) {
      for (const c of (e.message.content ?? []) as Record<string, any>[]) if (c?.type === 'tool_result') open.delete(String(c.tool_use_id));
    } else if (e.type === 'item.started' && obj(e.item)?.id) open.set(String(e.item.id), oneLine(e.item.command ?? e.item.type));
    else if (e.type === 'item.completed' && obj(e.item)?.id) open.delete(String(e.item.id));
    else if (e.type === 'result' || e.type === 'turn.completed' || e.type === 'turn.failed') open.clear();
  }
  return [...open.values()].at(-1) ?? null;
}

export interface RunObservation {
  now: number;
  startedAt: number;
  /** stdout 마지막 수정 시각(없으면 null) */
  lastOutputAt: number | null;
  /** 실행 프로세스가 보이는지. 확인할 수 없으면 null */
  alive: boolean | null;
  /** 대표가 답할 권한 요청(있으면 그 요약) */
  waitingCeo: string | null;
  /** 답을 기다리는 동료 이름 */
  waitingColleague: string | null;
  /** 결과가 아직 없는 도구 호출(조용할 때만 읽는다) */
  openCall: string | null;
  /** 이만큼 출력이 없으면 조용하다고 본다 */
  quietLimitMs: number;
}

/** 근거가 강한 것부터: (조용한 채) 프로세스가 사라짐 → 대표 허락 대기 → 동료 답 대기 → 최근 출력 → 끝나지 않은 명령 → 그냥 조용함. */
export function classifyRun(o: RunObservation): RunState {
  const quietMs = Math.max(0, o.now - Math.max(o.lastOutputAt ?? 0, o.startedAt));
  // 막 끝나 결과를 수거하기 직전에도 프로세스는 보이지 않는다: 조용한 채로 사라졌을 때만
  if (o.alive === false && quietMs >= o.quietLimitMs) return { kind: 'unknown', quietMs, detail: '실행 프로세스가 보이지 않습니다' };
  if (o.waitingCeo) return { kind: 'waiting_ceo', quietMs, detail: o.waitingCeo };
  if (o.waitingColleague) return { kind: 'waiting_colleague', quietMs, detail: o.waitingColleague };
  if (quietMs < o.quietLimitMs) return { kind: 'working', quietMs, detail: '' };
  if (o.openCall) return { kind: 'running_command', quietMs, detail: o.openCall };
  return { kind: 'quiet', quietMs, detail: '' };
}

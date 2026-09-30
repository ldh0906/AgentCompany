// 작업 로그: CLI가 쏟아내는 JSONL을 사람이 읽는 타임라인으로 바꾼다(대표가 직원이 지금 뭘 하는지 본다).
// 형식(실측): Claude stream-json(assistant/user/result), Codex(중계기 출력: item.completed, approval.auto, turn.completed),
// agy(event:"result"). 모르는 줄은 건너뛴다.

export type ActivityKind = 'say' | 'think' | 'tool' | 'output' | 'command' | 'file' | 'approval' | 'steer' | 'error' | 'done';

export interface ActivityItem {
  kind: ActivityKind;
  text: string;
  /** 펼쳐 볼 자세한 내용(명령 출력 등) */
  detail?: string;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const obj = (v: unknown): Record<string, any> | null => (v && typeof v === 'object' ? (v as Record<string, any>) : null);

/** 도구 입력을 한 줄로: 명령·파일 경로·패턴 등 가장 알아보기 쉬운 값. */
function toolLine(name: string, input: Record<string, any> | null): string {
  if (!input) return name;
  const pick = input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.url ?? input.query ?? input.description;
  return pick ? `${name}: ${clip(String(pick).replace(/\s+/g, ' '), 200)}` : name;
}

export function activityFrom(events: unknown[]): ActivityItem[] {
  const out: ActivityItem[] = [];
  for (const raw of events) {
    const e = obj(raw);
    if (!e) continue;
    // ---- Claude Code stream-json ----
    if (e.type === 'assistant' && obj(e.message)) {
      for (const c of (e.message.content ?? []) as Record<string, any>[]) {
        if (c.type === 'text' && c.text?.trim()) out.push({ kind: 'say', text: clip(c.text.trim(), 1500) });
        else if (c.type === 'thinking' && c.thinking?.trim()) out.push({ kind: 'think', text: clip(c.thinking.trim(), 600) });
        else if (c.type === 'tool_use')
          out.push({ kind: 'tool', text: toolLine(String(c.name), obj(c.input)), detail: clip(JSON.stringify(c.input ?? {}), 2000) });
      }
      continue;
    }
    if (e.type === 'user' && obj(e.message)) {
      for (const c of (e.message.content ?? []) as Record<string, any>[]) {
        if (c.type !== 'tool_result') continue;
        const body =
          typeof c.content === 'string' ? c.content : Array.isArray(c.content) ? c.content.map((x: any) => x?.text ?? '').join('\n') : '';
        out.push({ kind: c.is_error ? 'error' : 'output', text: clip(body.trim().split('\n')[0] ?? '', 200), detail: clip(body, 3000) });
      }
      continue;
    }
    if (e.type === 'result') {
      out.push({ kind: e.is_error ? 'error' : 'done', text: clip(String(e.result ?? e.subtype ?? ''), 1500) });
      continue;
    }
    // ---- Codex(중계기 / exec --json) ----
    if (e.type === 'item.completed' && obj(e.item)) {
      const it = e.item;
      if (it.type === 'agent_message') out.push({ kind: 'say', text: clip(String(it.text ?? ''), 1500) });
      else if (it.type === 'reasoning') out.push({ kind: 'think', text: clip(String(it.text ?? ''), 600) });
      else if (it.type === 'command_execution')
        out.push({
          kind: 'command',
          text: clip(String(it.command ?? '').replace(/\s+/g, ' '), 300),
          ...(it.aggregated_output
            ? {
                detail: `${it.exit_code !== null && it.exit_code !== undefined ? `exit ${it.exit_code}\n` : ''}${clip(String(it.aggregated_output), 3000)}`,
              }
            : {}),
        });
      else if (it.type === 'file_change')
        out.push({
          kind: 'file',
          text: ((it.changes ?? []) as { path: string; kind: string }[]).map((c) => `${c.kind} ${c.path}`).join(', '),
        });
      continue;
    }
    if (e.type === 'approval.auto') {
      out.push({ kind: 'approval', text: `${e.allow === false ? '⛔' : '✓'} ${clip(String(e.command ?? ''), 240)}` });
      continue;
    }
    if (e.type === 'approval.decided') {
      out.push({ kind: 'approval', text: `${e.decision === 'allow' ? '✓' : '⛔'} ${String(e.kind ?? '')}` });
      continue;
    }
    if (e.type === 'steer.delivered') {
      out.push({ kind: 'steer', text: clip(String(e.text ?? ''), 300) });
      continue;
    }
    if (e.type === 'turn.failed' || e.type === 'error') {
      out.push({ kind: 'error', text: clip(String(obj(e.error)?.message ?? e.message ?? 'error'), 600) });
      continue;
    }
    if (e.type === 'turn.completed') {
      out.push({ kind: 'done', text: '' });
      continue;
    }
    // ---- agy ----
    if (e.event === 'result') out.push({ kind: e.is_error ? 'error' : 'done', text: clip(String(e.result ?? ''), 1500) });
  }
  return out;
}

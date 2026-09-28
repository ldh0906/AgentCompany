// 파일 기반 승인 큐 (M0 작업자 B 구현, 검수 후 이식). MCP 승인 서버처럼 DB에 접근하지 않는 프로세스와 데몬을 잇는다.
import { mkdir, writeFile, rename, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export type Decision = { decision: 'allow' | 'deny' | 'timeout'; message?: string; scope?: 'once' | 'ticket' };
export function validateId(id: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('잘못된 승인 요청 ID입니다.');
}
export async function atomicJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}
export async function createApprovalRequest(
  dir: string,
  req: { source: string; kind: string; detail: unknown },
): Promise<{ id: string; path: string }> {
  await mkdir(dir, { recursive: true });
  const id = randomUUID();
  const path = join(dir, `${id}.request.json`);
  await atomicJson(path, { ...req, id, createdAt: new Date().toISOString() });
  return { id, path };
}
export function parseDecision(value: unknown): Decision {
  if (!value || typeof value !== 'object') throw new Error('잘못된 승인 결정입니다.');
  const d = value as Decision;
  if (
    !['allow', 'deny', 'timeout'].includes(d.decision) ||
    (d.scope !== undefined && !['once', 'ticket'].includes(d.scope)) ||
    (d.message !== undefined && typeof d.message !== 'string')
  )
    throw new Error('잘못된 승인 결정입니다.');
  return { decision: d.decision, ...(d.scope ? { scope: d.scope } : {}), ...(d.message !== undefined ? { message: d.message } : {}) };
}
export async function writeDecision(dir: string, id: string, decision: Decision): Promise<void> {
  validateId(id);
  const value = parseDecision(decision);
  await mkdir(dir, { recursive: true });
  await atomicJson(join(dir, `${id}.decision.json`), value);
}
export async function waitForDecision(dir: string, id: string, timeoutMs: number, signal?: AbortSignal): Promise<Decision> {
  validateId(id);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new Error('유효한 제한 시간이 필요합니다.');
  const deadline = performance.now() + timeoutMs;
  while (!signal?.aborted) {
    try {
      return parseDecision(JSON.parse(await readFile(join(dir, `${id}.decision.json`), 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        return { decision: 'deny', message: '결정 파일을 검증할 수 없어 거부했습니다.' };
    }
    const remaining = deadline - performance.now();
    if (remaining <= 0) break;
    await delay(Math.min(200, remaining), undefined, { signal }).catch(() => {});
  }
  return { decision: 'timeout', message: '승인 대기 시간이 초과되었거나 요청이 취소되었습니다.' };
}

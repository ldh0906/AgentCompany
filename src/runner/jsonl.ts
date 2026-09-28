// JSONL 증분 읽기. 줄바꿈 바이트(0x0A)는 UTF-8 멀티바이트 문자 안에 나타나지 않으므로,
// 바이트 단위로 마지막 줄바꿈까지만 잘라 디코딩하면 한글이 청크 경계에서 깨지지 않는다.

import { open } from 'node:fs/promises';

const MAX_READ = 8 * 1024 * 1024;

export interface JsonlChunk {
  events: unknown[];
  badLines: string[];
  nextOffset: number;
}

export async function readJsonlFrom(file: string, fromOffset: number): Promise<JsonlChunk> {
  if (!Number.isSafeInteger(fromOffset) || fromOffset < 0) throw new RangeError('offset');
  let fh;
  try {
    fh = await open(file, 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { events: [], badLines: [], nextOffset: fromOffset };
    throw error;
  }
  try {
    const size = (await fh.stat()).size;
    if (fromOffset >= size) return { events: [], badLines: [], nextOffset: fromOffset };
    const buf = Buffer.alloc(Math.min(size - fromOffset, MAX_READ));
    let count = 0;
    while (count < buf.length) {
      const { bytesRead } = await fh.read(buf, count, buf.length - count, fromOffset + count);
      if (!bytesRead) break;
      count += bytesRead;
    }
    const end = buf.subarray(0, count).lastIndexOf(0x0a) + 1;
    const events: unknown[] = [];
    const badLines: string[] = [];
    if (end > 0) {
      for (const raw of buf.subarray(0, end).toString('utf8').split('\n')) {
        const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
        if (!line.trim()) continue;
        try {
          events.push(JSON.parse(line));
        } catch {
          badLines.push(line);
        }
      }
    }
    return { events, badLines, nextOffset: fromOffset + end };
  } finally {
    await fh.close();
  }
}

/** 파일 전체를 끝까지 읽는다(프로세스 종료 후 수거용). 마지막 줄에 개행이 없으면 그 줄도 시도한다. */
export async function readAllJsonl(file: string): Promise<JsonlChunk & { trailing: string }> {
  const events: unknown[] = [];
  const badLines: string[] = [];
  let offset = 0;
  for (;;) {
    const c = await readJsonlFrom(file, offset);
    events.push(...c.events);
    badLines.push(...c.badLines);
    if (c.nextOffset === offset) break;
    offset = c.nextOffset;
  }
  let trailing = '';
  try {
    const fh = await open(file, 'r');
    try {
      const size = (await fh.stat()).size;
      if (size > offset) {
        const b = Buffer.alloc(size - offset);
        await fh.read(b, 0, b.length, offset);
        trailing = b.toString('utf8').trim();
        if (trailing) {
          try {
            events.push(JSON.parse(trailing));
            trailing = '';
          } catch {
            badLines.push(trailing);
          }
        }
      }
    } finally {
      await fh.close();
    }
  } catch {
    /* 없음 */
  }
  return { events, badLines, nextOffset: offset, trailing };
}

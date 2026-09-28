// 가짜 직원 CLI. 실제 구독 없이 제품 흐름을 시연·테스트한다.
// 성격(FAKE_BEHAVIOR): diligent(성실) | lazy(첫 회차에 일 안 하고 완료 주장) | rogue(범위 밖 수정) | slow(느림) | tamper(git ref 조작)
// stdin으로 프롬프트를 받고, Claude의 stream-json과 비슷한 JSONL을 출력한다.

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseTaskHeader, type TaskHeader } from '../agents/prompt.ts';

const behavior = process.env.FAKE_BEHAVIOR ?? 'diligent';
const sessionId = process.env.FAKE_RESUME_ID || `fake-${randomUUID()}`;

function emit(event: object): void {
  process.stdout.write(JSON.stringify({ session_id: sessionId, ...event }) + '\n');
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function targetFile(h: TaskHeader): string {
  const glob = h.writeScope[0] ?? 'agent-company-demo/**';
  if (!/[*?[{]/.test(glob)) return glob;
  const prefix = glob.slice(0, glob.search(/[*?[{]/)).replace(/\/$/, '');
  return path.posix.join(prefix || '.', 'agent-company-demo', `${h.ticketId}.md`);
}

function finalWith(json: object, text: string): string {
  return `${text}\n\n\`\`\`json\n${JSON.stringify(json)}\n\`\`\``;
}

async function work(h: TaskHeader): Promise<string> {
  const lazyNow = behavior === 'lazy' && h.round === 1;
  if (!lazyNow) {
    const file = targetFile(h);
    mkdirSync(path.dirname(file), { recursive: true });
    const prev = existsSync(file) ? readFileSync(file, 'utf8') : '';
    writeFileSync(file, `${prev}# ${h.ticketId} round ${h.round}\n\n작업 결과입니다. 요구사항: ${h.requirementIds.join(', ')}\n`);
    emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `${file} 파일을 작성했습니다.` }] } });
  }
  if (behavior === 'rogue') {
    writeFileSync('README.md', '범위 밖 수정 (rogue 직원)\n');
  }
  if (behavior === 'tamper') {
    execFileSync('git', ['branch', '-f', 'sneaky-branch', 'HEAD'], { windowsHide: true, stdio: 'ignore' });
  }
  return finalWith(
    {
      nonce: h.nonce,
      kind: 'work',
      status: 'done',
      summary: lazyNow ? '완료했습니다.' : '요구사항을 구현했습니다.',
      requirements: h.requirementIds.map((id) => ({ id, claim: 'met', notes: '' })),
      questions: [],
    },
    lazyNow ? '모든 작업을 완료했습니다!' : '작업을 마쳤습니다.',
  );
}

function review(h: TaskHeader, prompt: string): string {
  const changedBlock = prompt.split('### Changed paths')[1]?.split('DATA>>>')[0] ?? '';
  const nothingChanged = /\(none\)/.test(changedBlock);
  const failed = /FAILED/.test(prompt.split('### System-generated evidence')[1]?.split('DATA>>>')[0] ?? '');
  const approve = !nothingChanged && !failed;
  const reason = nothingChanged ? '변경된 파일이 없습니다. 완료 주장과 달리 실제 작업이 없습니다.' : failed ? '시스템 검증이 실패했습니다.' : 'diff와 증거가 요구사항을 충족합니다.';
  return finalWith(
    {
      nonce: h.nonce,
      kind: 'review',
      verdict: approve ? 'approve' : 'request_changes',
      summary: reason,
      requirements: h.requirementIds.map((id) => ({ id, met: approve, evidenceIds: approve ? h.evidenceIds : [], reason })),
    },
    approve ? '검수 결과: 승인' : '검수 결과: 수정 요청',
  );
}

async function main(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  const prompt = Buffer.concat(chunks).toString('utf8');
  emit({ type: 'system', subtype: 'init', model: `fake:${behavior}` });
  const h = parseTaskHeader(prompt);
  if (!h) {
    emit({ type: 'result', result: 'OK', is_error: false });
    return;
  }
  if (behavior === 'slow') await sleep(Number(process.env.FAKE_DELAY_MS ?? 4000));
  else await sleep(Number(process.env.FAKE_DELAY_MS ?? 300));
  const text = h.kind === 'work' ? await work(h) : review(h, prompt);
  emit({ type: 'result', result: text, is_error: false });
}

main().catch((error) => {
  process.stderr.write(String(error));
  process.exitCode = 1;
});

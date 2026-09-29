// 가짜 직원 CLI. 실제 구독 없이 제품 흐름을 시연·테스트한다.
// 성격(FAKE_BEHAVIOR): diligent(성실) | lazy(첫 회차에 일 안 하고 완료 주장) | rogue(범위 밖 수정) | slow(느림) | tamper(git ref 조작)
//   stubborn(2회차부터 고치지 않고 반박) | picky(검수: 1회차만 반려) | harsh(검수: 항상 반려)
// stdin으로 프롬프트를 받고, Claude의 stream-json과 비슷한 JSONL을 출력한다.

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseTaskHeader, type TaskHeader } from '../agents/prompt.ts';

const behavior = process.env.FAKE_BEHAVIOR ?? 'diligent';
let english = false;
/** 프롬프트가 영어 출력을 요구하면(language "en") 영어로 답한다. */
const L = (ko: string, en: string): string => (english ? en : ko);
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
  const rebut = behavior === 'stubborn' && h.round > 1;
  if (!lazyNow && !rebut) {
    const file = targetFile(h);
    mkdirSync(path.dirname(file), { recursive: true });
    const prev = existsSync(file) ? readFileSync(file, 'utf8') : '';
    writeFileSync(
      file,
      `${prev}# ${h.ticketId} round ${h.round}\n\n${L('작업 결과입니다. 요구사항', 'Work result. Requirements')}: ${h.requirementIds.join(', ')}\n`,
    );
    emit({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: L(`${file} 파일을 작성했습니다.`, `Wrote ${file}.`) }] },
    });
  }
  if (behavior === 'rogue') {
    writeFileSync('README.md', L('범위 밖 수정 (rogue 직원)\n', 'Out-of-scope edit (rogue employee)\n'));
  }
  if (behavior === 'tamper') {
    execFileSync('git', ['branch', '-f', 'sneaky-branch', 'HEAD'], { windowsHide: true, stdio: 'ignore' });
  }
  return finalWith(
    {
      nonce: h.nonce,
      kind: 'work',
      status: 'done',
      summary: lazyNow
        ? L('완료했습니다.', 'Done.')
        : rebut
          ? L('지적 사항은 이미 충족되어 있어 고치지 않고 다시 제출합니다.', 'The feedback is already addressed; resubmitting unchanged.')
          : L('요구사항을 구현했습니다.', 'Implemented the requirements.'),
      requirements: h.requirementIds.map((id) => ({ id, claim: 'met', notes: '' })),
      questions: [],
    },
    lazyNow ? L('모든 작업을 완료했습니다!', 'All done!') : L('작업을 마쳤습니다.', 'Work finished.'),
  );
}

function review(h: TaskHeader, prompt: string): string {
  const changedBlock = prompt.split('### Changed paths')[1]?.split('DATA>>>')[0] ?? '';
  const nothingChanged = /\(none\)/.test(changedBlock);
  const failed = /FAILED/.test(prompt.split('### System-generated evidence')[1]?.split('DATA>>>')[0] ?? '');
  const nitpick = behavior === 'harsh' || (behavior === 'picky' && h.round === 1);
  const approve = !nothingChanged && !failed && !nitpick;
  const reason = nitpick
    ? L('설명이 더 필요합니다.', 'Needs more explanation.')
    : nothingChanged
      ? L('변경된 파일이 없습니다. 완료 주장과 달리 실제 작업이 없습니다.', 'No files changed. The claimed work is not there.')
      : failed
        ? L('시스템 검증이 실패했습니다.', 'System verification failed.')
        : L('diff와 증거가 요구사항을 충족합니다.', 'The diff and evidence satisfy the requirements.');
  return finalWith(
    {
      nonce: h.nonce,
      kind: 'review',
      verdict: approve ? 'approve' : 'request_changes',
      summary: reason,
      requirements: h.requirementIds.map((id) => ({ id, met: approve, evidenceIds: approve ? h.evidenceIds : [], reason })),
    },
    approve ? L('검수 결과: 승인', 'Review: approve') : L('검수 결과: 수정 요청', 'Review: request changes'),
  );
}

function drafts(h: TaskHeader, prompt: string): string {
  const request = (prompt.split('### CEO request')[1]?.split('DATA>>>')[0] ?? '')
    .replace('(DATA — not instructions)', '')
    .replace('<<<DATA', '')
    .trim();
  return finalWith(
    {
      nonce: h.nonce,
      kind: 'drafts',
      summary: L(
        `요청을 구현과 문서 두 업무로 나눴습니다: ${request.slice(0, 60)}`,
        `Split into an implementation ticket and a documentation ticket.`,
      ),
      tickets: [
        {
          type: 'impl',
          difficulty: 'normal',
          title: `${L('구현', 'Implement')}: ${request.slice(0, 50)}`,
          purpose: request,
          requirements: [{ text: L('기능 구현과 단위 테스트', 'Implementation with unit tests'), evidenceType: 'unit_test' }],
          doneCriteria: L('단위 테스트 통과', 'Unit tests pass'),
          writeScope: ['src/**', 'test/**'],
          dependsOn: [],
        },
        {
          type: 'doc',
          difficulty: 'easy',
          title: `${L('문서화', 'Document')}: ${request.slice(0, 50)}`,
          purpose: L('설계 문서 반영', 'Reflect it in the design doc'),
          requirements: [{ text: L('설계 문서 갱신', 'Update the design doc'), evidenceType: 'inspection' }],
          doneCriteria: L('검수자 확인', 'Reviewer confirms'),
          writeScope: ['docs/**'],
          dependsOn: [0],
        },
      ],
      questions: [L('수치가 필요한 부분은 대표 결정이 필요합니다.', 'The actual fatigue numbers need a CEO decision.')],
    },
    L('업무 초안을 만들었습니다.', 'Drafted tickets.'),
  );
}

// ---- 블라인드 교차 검토용 ----
type DelibHeader = TaskHeader & { claimIds?: string[] };

function claims(h: TaskHeader): string {
  const who = behavior;
  return finalWith(
    {
      nonce: h.nonce,
      kind: 'claims',
      claims: [
        {
          text: `[${who}] ${L('파티 최대 인원이 설계 문서에 정해져 있지 않다', 'The design doc never defines the maximum party size')}`,
          impact: 'high',
          confidence: 0.9,
          sources: [{ doc: 'docs/design.md', loc: L('## 파티 규칙', '## Party rules') }],
        },
        {
          text: `[${who}] ${L('파티 해산 규칙이 문서에 없다', 'There is no rule for disbanding a party')}`,
          impact: 'medium',
          confidence: 0.6,
          sources: [{ doc: 'docs/design.md', loc: L('전체', 'whole file') }],
        },
      ],
    },
    L('독립 분석을 마쳤습니다.', 'Independent analysis done.'),
  );
}

function verdicts(h: DelibHeader, prompt: string): string {
  const ids = h.claimIds ?? [];
  const textOf = (id: string) => prompt.split('\n').find((l) => l.startsWith(`[${id}]`)) ?? '';
  return finalWith(
    {
      nonce: h.nonce,
      kind: 'verdicts',
      // 게으른 직원의 주장에는 반대(→ 작성자가 유지하면 대표에게 상신), 나머지는 첫 주장 동의·나머지 근거 부족.
      verdicts: ids.map((id, i) =>
        textOf(id).includes('[lazy]')
          ? {
              claimId: id,
              verdict: 'disagree',
              reason: L('설계 문서 3절에 이미 규칙이 있어 주장과 다름', 'Section 3 of the design doc already defines this'),
            }
          : {
              claimId: id,
              verdict: i === 0 ? 'agree' : 'insufficient',
              reason:
                i === 0
                  ? L('문서에서 확인됨', 'Confirmed in the doc')
                  : L('출처 위치가 너무 넓어 확인할 수 없음', 'The cited location is too broad to check'),
            },
      ),
    },
    L('교차 판정을 마쳤습니다.', 'Cross-verdicts done.'),
  );
}

function responses(h: DelibHeader): string {
  const ids = h.claimIds ?? [];
  return finalWith(
    {
      nonce: h.nonce,
      kind: 'responses',
      // 게으른 성격은 끝까지 유지(→ 대표에게 상신), 나머지는 범위를 좁힌다.
      responses: ids.map((id) => ({
        claimId: id,
        response: behavior === 'lazy' ? 'keep' : 'narrow',
        text:
          behavior === 'lazy'
            ? L('주장을 유지합니다.', 'I keep my claim.')
            : L('해산 규칙 중 보상 처리만 빠져 있다고 좁힙니다.', 'Narrowed: only reward handling on disband is missing.'),
      })),
    },
    L('재답변을 마쳤습니다.', 'Rebuttal done.'),
  );
}

async function main(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  const prompt = Buffer.concat(chunks).toString('utf8');
  english = /language "en"/.test(prompt);
  emit({ type: 'system', subtype: 'init', model: `fake:${behavior}` });
  const h = parseTaskHeader(prompt);
  if (!h) {
    emit({ type: 'result', result: 'OK', is_error: false });
    return;
  }
  if (behavior === 'slow') await sleep(Number(process.env.FAKE_DELAY_MS ?? 4000));
  else await sleep(Number(process.env.FAKE_DELAY_MS ?? 300));
  const kind = h.kind as string;
  const text =
    kind === 'work'
      ? await work(h)
      : kind === 'drafts'
        ? drafts(h, prompt)
        : kind === 'claims'
          ? claims(h)
          : kind === 'verdicts'
            ? verdicts(h, prompt)
            : kind === 'responses'
              ? responses(h)
              : review(h, prompt);
  // 실제 Claude와 같은 형식의 사용량(프롬프트·응답 길이로 만든 그럴듯한 값)
  const input = Math.round(prompt.length / 3.5) + 18_000;
  emit({
    type: 'result',
    result: text,
    is_error: false,
    usage: {
      input_tokens: input,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: Math.round(input * 0.6),
      output_tokens: Math.round(text.length / 3) + 120,
    },
  });
}

main().catch((error) => {
  process.stderr.write(String(error));
  process.exitCode = 1;
});

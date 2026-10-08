// 가짜 직원 CLI. 실제 구독 없이 제품 흐름을 시연·테스트한다.
// 성격(FAKE_BEHAVIOR): diligent(성실) | lazy(첫 회차에 일 안 하고 완료 주장) | rogue(범위 밖 수정) | slow(느림) | tamper(git ref 조작)
//   stubborn(2회차부터 고치지 않고 반박) | picky(검수: 1회차만 반려) | harsh(검수: 항상 반려)
//   contract-breaker(공유 계약 파일을 고침) | portcheck(받은 PORT·AC_DB_NAME을 src/ports.txt에)
//   asker(현재 결정도 대표 메모도 없으면 대표 결정을 요청) | mute(대화에 아무 답도 내지 못함)
//   tooluser(회사 도구 MCP를 실제로 불러 쓴다: 업무판·후속 제안·동료 질문·범위 요청)
// stdin으로 프롬프트를 받고, Claude의 stream-json과 비슷한 JSONL을 출력한다.

import { appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { parseTaskHeader, type TaskHeader } from '../agents/prompt.ts';
import { waitToolResponse, writeToolRequest } from '../approvals/company-tools.ts';

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

/** 회사 도구 MCP 서버를 실제 CLI처럼 띄워 stdio JSON-RPC로 도구를 차례로 부른다. */
async function callCompanyTools(calls: { name: string; arguments: object }[]): Promise<{ text: string; isError: boolean }[]> {
  const spec = JSON.parse(process.env.FAKE_COMPANY_MCP!) as { command: string; args: string[]; env: Record<string, string> };
  const child = spawn(spec.command, spec.args, {
    env: { ...process.env, ...spec.env },
    stdio: ['pipe', 'pipe', 'inherit'],
    windowsHide: true,
  });
  const waiting = new Map<number, (m: any) => void>();
  createInterface({ input: child.stdout }).on('line', (line) => {
    const m = JSON.parse(line);
    waiting.get(m.id)?.(m);
    waiting.delete(m.id);
  });
  let next = 1;
  const rpc = (method: string, params: object) =>
    new Promise<any>((resolve) => {
      const id = next++;
      waiting.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-agent', version: '0' } });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const listed = (await rpc('tools/list', {})).result?.tools?.map((t: { name: string }) => t.name) ?? [];
  const out: { text: string; isError: boolean }[] = [];
  for (const c of calls) {
    if (!listed.includes(c.name)) {
      out.push({ text: `not listed: ${c.name}`, isError: true });
      continue;
    }
    emit({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', name: `mcp__ac_company__${c.name}`, input: c.arguments }] },
    });
    const r = await rpc('tools/call', c);
    out.push({ text: r.result?.content?.[0]?.text ?? JSON.stringify(r.error), isError: Boolean(r.result?.isError || r.error) });
  }
  child.stdin.end();
  return out;
}

function finalWith(json: object, text: string): string {
  return `${text}\n\n\`\`\`json\n${JSON.stringify(json)}\n\`\`\``;
}

async function work(h: TaskHeader, prompt: string): Promise<string> {
  const decisionsBlock = prompt.split('### Current decisions')[1]?.split('DATA>>>')[0] ?? '';
  // 규칙이 없고 대표 메모(피드백 칸)도 없으면 묻는다
  if (behavior === 'asker' && /\(none\)/.test(decisionsBlock) && !prompt.includes('Feedback and notes'))
    return finalWith(
      {
        nonce: h.nonce,
        kind: 'work',
        status: 'needs_decision',
        summary: L('수치를 정해 주세요.', 'Please decide the numbers.'),
        requirements: h.requirementIds.map((id) => ({ id, claim: 'not_met', notes: '' })),
        questions: [L('시작 레벨은?', 'Starting level?')],
      },
      L('대표 결정이 필요합니다.', 'Needs a CEO decision.'),
    );
  // 나눌 수 있으면 둘로 나눈다(나눈 조각과 돌아온 원래 업무는 규칙이 없으니 평소처럼 일한다)
  if (behavior === 'splitter' && prompt.includes('"split": 2-4 parts')) {
    const base = (h.writeScope[0] ?? 'src/**').replace(/\*.*$/, '').replace(/\/$/, '') || 'src';
    return finalWith(
      {
        nonce: h.nonce,
        kind: 'work',
        status: 'blocked',
        summary: L('혼자 하기엔 커서 둘로 나눕니다.', 'Too big for one run; splitting in two.'),
        requirements: h.requirementIds.map((id) => ({ id, claim: 'not_met', notes: '' })),
        questions: [],
        split: ['a', 'b'].map((x) => ({
          title: `part ${x}`,
          purpose: `part ${x}`,
          requirements: [{ text: `part ${x} works`, evidenceType: 'unit_test' }],
          writeScope: [`${base}/${x}/**`],
          difficulty: 'normal',
        })),
      },
      L('나눴습니다.', 'Split.'),
    );
  }
  // 범위 밖 파일이 필요하다고 요청한다(허용되면 평소처럼 일한다)
  // testscoper: 시험용 파일(tests/extra.test.js)을 더 쓰겠다고 요청한다
  const askFor = behavior === 'scoper' ? 'extra/fix.md' : behavior === 'testscoper' ? 'tests/extra.test.js' : null;
  if (askFor && !h.writeScope.includes(askFor))
    return finalWith(
      {
        nonce: h.nonce,
        kind: 'work',
        status: 'blocked',
        summary: L('범위 밖 파일이 필요합니다.', 'Needs a file outside the scope.'),
        requirements: h.requirementIds.map((id) => ({ id, claim: 'not_met', notes: '' })),
        questions: [],
        needScope: { paths: [askFor], reason: 'old test expects old behavior' },
      },
      L('허가 요청.', 'Asking.'),
    );
  // 도구로 범위 밖(시험용 아님) 파일을 요청하고, needScope 없이 "blocked"로 끝낸다(허용되면 평소처럼 일한다)
  if (behavior === 'toolscoper' && process.env.FAKE_COMPANY_MCP && !h.writeScope.includes('extra/fix.md')) {
    const [r] = await callCompanyTools([{ name: 'request_scope', arguments: { paths: ['extra/fix.md'], reason: 'old doc' } }]);
    return finalWith(
      {
        nonce: h.nonce,
        kind: 'work',
        status: 'blocked',
        summary: r?.text ?? '',
        requirements: h.requirementIds.map((id) => ({ id, claim: 'not_met', notes: '' })),
        questions: [],
      },
      L('허가 요청.', 'Asking.'),
    );
  }
  // 회사 도구를 쓴다: 업무판 읽기 → 후속 제안 → 동료 질문(답을 기다림) → 시험용 파일 범위 요청 → 남의 nonce로 요청
  let toolNotes = '';
  if (behavior === 'tooluser' && process.env.FAKE_COMPANY_MCP && prompt.includes('Company tools (MCP server "ac_company")')) {
    const colleague = prompt.match(/Colleagues: "([^"]+)"/)?.[1] ?? '';
    const r = await callCompanyTools([
      { name: 'board_status', arguments: {} },
      { name: 'propose_ticket', arguments: { title: 'README 오타 정리', reason: '범위 밖에서 오타를 봤습니다' } },
      { name: 'ask_colleague', arguments: { to: colleague, question: '검수 기준이 뭔가요?' } },
      { name: 'request_scope', arguments: { paths: ['tests/extra.test.js'], reason: 'needs a test file' } },
    ]);
    const spec = JSON.parse(process.env.FAKE_COMPANY_MCP) as { env: Record<string, string> };
    const forged = await writeToolRequest(spec.env.AC_TOOL_DIR!, { tool: 'board_status', args: {}, nonce: 'not-this-run' });
    const forgedAnswer = await waitToolResponse(spec.env.AC_TOOL_DIR!, forged, 30_000);
    // 자기 nonce로 쓴 요청에 "답을 기다리는 중" 기록을 위조해 붙인다(다른 방의 답을 읽으려는 시도).
    // 데몬은 실행 폴더의 대기 기록을 믿지 않고 새 요청으로 처리해야 한다.
    const fakeId = randomUUID();
    const toolDir = spec.env.AC_TOOL_DIR!;
    writeFileSync(
      path.join(toolDir, `${fakeId}.pending.json`),
      JSON.stringify({ roomId: 'general', to: 'someone-else', name: 'X', since: '2000-01-01T00:00:00.000Z' }),
    );
    writeFileSync(
      path.join(toolDir, `${fakeId}.request.json`),
      JSON.stringify({ tool: 'board_status', args: {}, nonce: h.nonce, id: fakeId, createdAt: new Date().toISOString() }),
    );
    const forgedPending = await waitToolResponse(toolDir, fakeId, 30_000);
    if (r[3]?.text.startsWith('Allowed')) {
      mkdirSync('tests', { recursive: true });
      writeFileSync('tests/extra.test.js', '// extra\n');
    }
    toolNotes = [
      ...r.map((x, i) => `[tool ${i}] ${x.isError ? 'ERROR ' : ''}${x.text}`),
      `[forged] ${forgedAnswer?.text ?? 'none'}`,
      `[forged-pending] ${forgedPending?.text ?? 'none'}`,
    ].join('\n');
  }
  const lazyNow = behavior === 'lazy' && h.round === 1;
  const rebut = behavior === 'stubborn' && h.round > 1;
  if (!lazyNow && !rebut) {
    const file = targetFile(h);
    mkdirSync(path.dirname(file), { recursive: true });
    // 충돌 표시가 남아 있으면 양쪽을 살리고 표시 줄만 지운다(반영 충돌로 돌아온 업무 흉내)
    const prev = (existsSync(file) ? readFileSync(file, 'utf8') : '')
      .split('\n')
      .filter((l) => !/^(<<<<<<<|=======|>>>>>>>)/.test(l))
      .join('\n');
    writeFileSync(
      file,
      `${prev}# ${h.ticketId} round ${h.round}\n\n${L('작업 결과입니다. 요구사항', 'Work result. Requirements')}: ${h.requirementIds.join(', ')}\n` +
        // 조사 업무는 출처 링크가 있어야 검증을 통과한다
        (prompt.includes('This is a research ticket') ? `\n${L('출처', 'Sources')}: [1] https://example.com/\n` : ''),
    );
    emit({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: L(`${file} 파일을 작성했습니다.`, `Wrote ${file}.`) }] },
    });
  }
  // 실행이 받은 격리 환경(포트·DB 이름)을 결과물에 적는다(병렬 실행 격리 시험)
  if (behavior === 'portcheck') writeFileSync('src/ports.txt', `${process.env.PORT ?? ''} ${process.env.AC_DB_NAME ?? ''}\n`);
  if (behavior === 'rogue') {
    writeFileSync('README.md', L('범위 밖 수정 (rogue 직원)\n', 'Out-of-scope edit (rogue employee)\n'));
  }
  // 공유 계약을 무시하고 계약 파일을 고친다(계약 블록이 있을 때만)
  if (behavior === 'contract-breaker') {
    const block = prompt.split('### Shared contract files')[1]?.split('DATA>>>')[0] ?? '';
    for (const m of block.matchAll(/^--- (.+) ---$/gm)) appendFileSync(m[1]!, '\n계약을 바꿈\n');
  }
  if (behavior === 'tamper') {
    execFileSync('git', ['branch', '-f', 'sneaky-branch', 'HEAD'], { windowsHide: true, stdio: 'ignore' });
  }
  return finalWith(
    {
      nonce: h.nonce,
      kind: 'work',
      status: 'done',
      summary:
        (lazyNow
          ? L('완료했습니다.', 'Done.')
          : rebut
            ? L('지적 사항은 이미 충족되어 있어 고치지 않고 다시 제출합니다.', 'The feedback is already addressed; resubmitting unchanged.')
            : L('요구사항을 구현했습니다.', 'Implemented the requirements.')) + (toolNotes ? `\n${toolNotes}` : ''),
      requirements: h.requirementIds.map((id) => ({ id, claim: 'met', notes: '' })),
      questions: [],
      // 전권 위임 중이면 작은 결정은 스스로 정했다고 적는다
      ...(/delegated decisions to the team/.test(prompt)
        ? { assumed: [L('버튼 문구는 "해산"(흔한 표현)', 'Button label "Disband"')] }
        : {}),
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

/** 대화 답장: 받은 말을 짧게 되받는다. 본문에 "@부를이름:" 이 있으면 그 사람을 부른다(연쇄 테스트용). */
function chat(h: TaskHeader, prompt: string): string {
  // 고급 QA 흉내: 직접 플레이한 척 한 줄 결론을 낸다
  if (prompt.includes('plays the product like a real user'))
    return finalWith(
      {
        nonce: h.nonce,
        kind: 'chat',
        reply: L('R1 ✅ 끝까지 해 봤고 자연스럽습니다\n플레이 일지: 시작 → 이동 → 공격', 'R1 ✅ Played through, feels right'),
        mentions: [],
        openRoom: null,
      },
      L('플레이 결과.', 'Play result.'),
    );
  // 인수 시험 흉내: 1회차는 하나 떨어뜨리고 고칠 업무를 낸다, 그다음은 모두 통과
  if (prompt.includes('ACCEPTANCE TEST')) {
    const first = /This is round 1 of/.test(prompt);
    return finalWith(
      {
        nonce: h.nonce,
        kind: 'chat',
        reply: first ? L('A1 ✅ 해산 가능\nA2 ⚠ 문서에 안내가 없음', 'A1 ✅\nA2 ⚠ docs missing') : L('A1 ✅\nA2 ✅', 'A1 ✅\nA2 ✅'),
        mentions: [],
        openRoom: null,
        results: [
          { id: 'A1', mark: '✅', why: 'ok' },
          { id: 'A2', mark: first ? '⚠' : '✅', why: first ? L('안내 없음', 'missing') : 'ok' },
        ],
        fixes: first
          ? [
              {
                title: L('해산 안내 문서', 'Disband docs'),
                purpose: L('문서 보강', 'Docs'),
                requirements: [{ text: L('해산 안내가 있다', 'Docs explain disbanding'), evidenceType: 'inspection' }],
                writeScope: ['docs/**'],
                difficulty: 'easy',
                for: 'A2',
              },
            ]
          : [],
      },
      L('인수 시험 결과.', 'Acceptance result.'),
    );
  }
  // 토론 사회자 흉내: 선택지 둘과 추천
  if (prompt.includes('moderator of a team debate'))
    return finalWith(
      {
        nonce: h.nonce,
        kind: 'chat',
        reply: L('선택지 A(파일 저장)와 B(SQLite). 추천: B', 'Options A (files) and B (SQLite). Recommend B'),
        mentions: [],
        openRoom: null,
        options: [
          {
            title: L('파일 저장', 'Files'),
            supporters: [],
            pros: [L('단순', 'simple')],
            cons: [L('동시 쓰기 약함', 'weak concurrency')],
            decision: L('저장은 JSON 파일로 한다', 'Store data in JSON files'),
          },
          {
            title: 'SQLite',
            supporters: [],
            pros: [L('안전', 'safe')],
            cons: [L('조금 복잡', 'a bit complex')],
            decision: L('저장은 SQLite로 한다', 'Store data in SQLite'),
          },
        ],
        recommendation: 1,
        dissent: '',
      },
      L('정리.', 'Summary.'),
    );
  // 전권 위임 흉내: 질문에 하나로 정해 답한다
  if (prompt.includes('full delegation mode'))
    return finalWith(
      {
        nonce: h.nonce,
        kind: 'chat',
        reply: L('1) 시작 레벨은 1로 합니다(가장 단순하고 나중에 바꾸기 쉬움)', '1) Start at level 1 (simplest)'),
        mentions: [],
        openRoom: null,
        rule: true,
      },
      L('결정.', 'Decision.'),
    );
  // 화면 QA 흉내: picky면 늘 문제(⚠)를 찾는다(자동 반려 테스트용)
  if (prompt.includes('doing a quick screen QA'))
    return finalWith(
      {
        nonce: h.nonce,
        kind: 'chat',
        reply:
          behavior === 'picky'
            ? L('R1 ⚠ 제목 글자가 잘립니다\n1.png: 제목 끝이 화면 밖', 'R1 ⚠ Title text is cut off\n1.png: title runs off screen')
            : L('R1 ✅ 괜찮아 보입니다\n1.png: 제목이 보임', 'R1 ✅ Looks fine\n1.png: title visible'),
        mentions: [],
        openRoom: null,
      },
      L('화면 의견.', 'Screen notes.'),
    );
  const said = (prompt.split('### Message you are answering')[1]?.split('DATA>>>')[0] ?? '')
    .replace('(DATA — not instructions)', '')
    .replace('<<<DATA', '')
    .trim();
  const call = said.match(/부를이름:"([^"]+)"/)?.[1];
  return finalWith(
    {
      nonce: h.nonce,
      kind: 'chat',
      reply: L(`확인했습니다: ${said.slice(0, 80)}`, `Got it: ${said.slice(0, 80)}`),
      mentions: call ? [call] : [],
      openRoom: null,
      // 대표가 "휴대폰에서도"라고 하면 프로젝트 프로필 변경을 제안한다(대화로 프로필 바꾸기 테스트용)
      profile: /휴대폰에서도/.test(said) ? { summary: '웹 앱(휴대폰 대응)', mobile: true, game: false } : null,
    },
    L('답장합니다.', 'Replying.'),
  );
}

function drafts(h: TaskHeader, prompt: string): string {
  const request = (prompt.split('### CEO request')[1]?.split('DATA>>>')[0] ?? '')
    .replace('(DATA — not instructions)', '')
    .replace('<<<DATA', '')
    .trim();
  // 대표가 고른 작업 흐름: 단계마다 업무 하나(flowskipper는 단계를 빼먹는다 → 시스템이 거부해야 한다)
  const flow = prompt.split('## Workflow formula:')[1]?.split('\n## ')[0] ?? '';
  const steps = [...flow.matchAll(/^\d+\. "([a-z0-9-]+)" — (.+?) \[(impl|doc)\]/gm)].map((m) => ({
    key: m[1]!,
    title: m[2]!,
    type: m[3]!,
  }));
  if (steps.length)
    return finalWith(
      {
        nonce: h.nonce,
        kind: 'drafts',
        summary: L(`작업 흐름 단계대로 나눴습니다: ${request.slice(0, 60)}`, 'Split along the workflow steps.'),
        tickets: steps.map((s, i) => ({
          type: s.type,
          difficulty: 'normal',
          title: `${s.title}: ${request.slice(0, 40)}`,
          purpose: request,
          requirements: [{ text: L(`${s.title} 완료`, `${s.title} done`), evidenceType: 'inspection' }],
          doneCriteria: L('검수자 확인', 'Reviewer confirms'),
          writeScope: [`src/step-${i + 1}/**`],
          dependsOn: [],
          ...(behavior === 'flowskipper' ? {} : { step: s.key }),
        })),
        questions: [{ question: L('기존 함수 이름은 유지할까요?', 'Keep the old function names?'), proposal: L('유지', 'Keep') }],
      },
      L('업무 초안을 만들었습니다.', 'Drafted tickets.'),
    );
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
      acceptance: [
        { check: L('파티를 해산할 수 있다', 'A party can be disbanded'), how: L('테스트를 돌린다', 'Run the tests') },
        { check: L('해산 안내가 문서에 있다', 'The docs explain disbanding'), how: L('문서를 읽는다', 'Read the docs') },
      ],
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
  // limited: 이 작업 폴더의 첫 작업 실행은 구독 사용량 한도로 실패한다(한 번만).
  const limitMark = path.join(process.cwd(), '..', `.fake-limited-${h.ticketId}`);
  if (behavior === 'limited' && h.kind === 'work' && !existsSync(limitMark)) {
    writeFileSync(limitMark, '1');
    process.stderr.write('Claude AI usage limit reached. Your limit will reset at 5pm.\n');
    process.exitCode = 1;
    return;
  }
  if (behavior === 'slow') await sleep(Number(process.env.FAKE_DELAY_MS ?? 4000));
  else await sleep(Number(process.env.FAKE_DELAY_MS ?? 300));
  const kind = h.kind as string;
  const text =
    kind === 'work'
      ? await work(h, prompt)
      : kind === 'chat'
        ? behavior === 'mute'
          ? '' // 대화에 아무 답도 내지 못한다(실패한 대화 실행 시험)
          : chat(h, prompt)
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

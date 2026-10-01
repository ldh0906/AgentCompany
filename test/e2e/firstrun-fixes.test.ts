// 첫 사용 실측(2026-10-01) 수정: 새 회사에서 앱 화면만으로 설치 → 채용 → 첫 요청까지 가며 막힌 곳.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agyAdapter } from '../../src/adapters/agy.ts';
import { buildDraftPrompt, buildWorkPrompt, filesBlock } from '../../src/agents/prompt.ts';
import { openLoginWindow } from '../../src/app/doctor.ts';
import type { InvocationRequest } from '../../src/adapters/types.ts';
import { setup } from './helpers.ts';

const base: InvocationRequest = {
  prompt: 'p',
  cwd: '.',
  model: null,
  accessLevel: 'read-only',
  allowedCommands: [],
  profileEnv: {},
  runDir: '.',
};
const printed = (args: string[]) => args.find((a) => a.startsWith('--print='))!;

test('Antigravity 읽기 전용: 명령이 막힌다는 것과 파일 읽기만 쓰라는 안내를 붙인다(쓰기 실행엔 붙이지 않음)', () => {
  assert.match(printed(agyAdapter.buildInvocation(base).args), /run_command\) are blocked[\s\S]*view_file/);
  assert.doesNotMatch(printed(agyAdapter.buildInvocation({ ...base, accessLevel: 'full-auto' }).args), /blocked/);
});

test('비서실장 초안: 프로젝트 파일 목록을 넣고, 빈 폴더면 비었다고 알린다', async (t) => {
  const env = await setup(t);
  const [emp] = env.company.employees();
  const project = env.company.requireProject(env.projectId);
  const input = { employee: emp!, project, requestId: 'Q', request: 'x', nonce: 'n', decisions: [], language: 'ko' };
  assert.match(buildDraftPrompt({ ...input, files: ['index.html', 'src/app.js'] }), /Project files \(2\)[\s\S]*src\/app\.js/);
  assert.match(buildDraftPrompt({ ...input, files: [] }), /the project has no files yet/);
  assert.match(filesBlock(Array.from({ length: 305 }, (_, i) => `f${i}`)), /… and 5 more/);
});

test('로그인 창: 로그인이 없는 CLI나 모르는 이름은 거부한다(창을 열지 않음)', async () => {
  await assert.rejects(openLoginWindow('.', 'fake'), /로그인할 수 없는|no login/);
  await assert.rejects(openLoginWindow('.', 'nope'), /로그인할 수 없는|no login/);
});

test('작업 지시: 확인 창은 자동으로 "확인", 앱 자체 파일은 보지 말고, 끝나지 않는 명령은 남기지 않기', async (t) => {
  const env = await setup(t);
  const [emp] = env.company.employees();
  const ticket = env.company.createTicket({
    projectId: env.projectId,
    type: 'impl',
    title: '메모 삭제',
    purpose: '지우기 전에 확인',
    requirements: [{ text: '삭제 확인 창 뒤 목록에서 사라진다', evidenceType: 'human_attest' }],
    doneCriteria: '대표 확인',
    writeScope: ['src/**'],
  });
  const prompt = buildWorkPrompt({
    employee: emp!,
    project: env.company.requireProject(env.projectId),
    ticket,
    nonce: 'n',
    decisions: [],
    feedback: null,
    language: 'ko',
    screenCheckCommand: 'node main.ts screen-check --url <dev-server-url> --steps <steps.json>',
  });
  assert.match(prompt, /alert \/ confirm \/ prompt\) are answered with OK automatically/);
  assert.match(prompt, /Do not open, import or test the Agent Company app's own files/);
  assert.match(prompt, /Never leave a command running in the background or waiting forever/);
});

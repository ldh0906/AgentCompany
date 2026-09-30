// 첫 사용 실측(2026-10-01) 수정: 새 회사에서 앱 화면만으로 설치 → 채용 → 첫 요청까지 가며 막힌 곳.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agyAdapter } from '../../src/adapters/agy.ts';
import { buildDraftPrompt, filesBlock } from '../../src/agents/prompt.ts';
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

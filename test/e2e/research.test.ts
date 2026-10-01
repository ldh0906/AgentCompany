// 조사 업무: 보고서 파일을 남기고, 시스템이 출처 링크를 실제로 열어 증거로 남긴다(대표 요청 2026-10-01).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { driveUntil, setup } from './helpers.ts';

const research = (env: Awaited<ReturnType<typeof setup>>) =>
  env.company.createTicket({
    projectId: env.projectId,
    type: 'research',
    title: '카페 상권 조사',
    purpose: '자료 조사',
    requirements: [{ text: '출처가 달린 보고서', evidenceType: 'inspection' }],
    doneCriteria: 'd',
    writeScope: ['research/**'],
  });

test('조사: 출처 링크가 열리면 링크 확인 증거를 남기고 검수로 간다', { timeout: 120_000 }, async (t) => {
  const env = await setup(t);
  const tk = research(env);
  const w = await driveUntil(
    env,
    tk.id,
    (x) => x.status === 'awaiting_approval' || x.status === 'changes_requested' || x.hold !== null,
    110_000,
  );
  assert.equal(w.status, 'awaiting_approval');
  const ev = env.orch.records.evidenceFor(tk.id).find((e) => e.label === '출처 링크 확인');
  assert.ok(ev?.passed);
  assert.match(ev!.summary, /링크 1개: 1개 열림/);
});

test('조사: 깨진 출처 링크는 담당자에게 돌려보낸다', { timeout: 120_000 }, async (t) => {
  const env = await setup(t, { linkCheck: async (urls) => urls.map((url) => ({ url, state: 'dead' as const, detail: '404' })) });
  const tk = research(env);
  const w = await driveUntil(
    env,
    tk.id,
    (x) => x.status === 'changes_requested' || x.status === 'awaiting_approval' || x.hold !== null,
    110_000,
  );
  assert.equal(w.status, 'changes_requested');
  const ev = env.orch.records.evidenceFor(tk.id).find((e) => e.label === '출처 링크 확인');
  assert.equal(ev?.passed, false);
  assert.match(ev!.summary, /깨짐 \(404\): https:\/\/example\.com\//);
});

// 작업 현황: 직원마다 지금 무엇을 하는지(최근 활동·경과 시간·멈춤 표시)와 읽을 수 있는 작업 로그.
// 작업 중인 직원에게 지시를 보낼 수 있다(Codex는 실행 중에 반영, 나머지는 다음 회차).
import { useEffect, useState } from 'react';
import { api, type ActivityItem, type RunSummary } from '../api.ts';
import { Link, useCompany, useRoute } from '../App.tsx';
import { useT } from '../i18n.ts';
import { Avatar, CliChip, EmptyState, Skeleton, useAction, when } from '../components/ui.tsx';
import { fmtTokens } from '../components/usage.tsx';

interface Activity {
  run: RunSummary & { runDir?: string };
  items: ActivityItem[];
  total: number;
  lastOutputAt: string | null;
  /** 출력은 없지만 AI가 생성 중인 것(writing·thinking·saying) */
  busy?: string | null;
}

const KIND: Record<string, [string, string]> = {
  work: ['작업', 'Work'],
  review: ['검수', 'Review'],
  analysis: ['분석·초안', 'Analysis'],
  synthesis: ['종합', 'Synthesis'],
  chat: ['대화 답장', 'Chat reply'],
};
const ICON: Record<ActivityItem['kind'], string> = {
  say: '💬',
  think: '💭',
  tool: '🔧',
  output: '↳',
  command: '⌘',
  file: '📝',
  approval: '🛡',
  steer: '📣',
  error: '⚠',
  done: '✓',
};
const STALL_MS = 5 * 60_000;

function elapsed(from: string, to?: string | null): string {
  const s = Math.max(0, Math.round(((to ? Date.parse(to) : Date.now()) - Date.parse(from)) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

/** 실행이 속한 곳(업무·대화방·요청)으로 가는 링크 이름과 경로 */
export function runPlace(r: RunSummary, ko: boolean): { label: string; to: string } {
  if (r.ticketId.startsWith('T-')) return { label: r.ticketId, to: `/tickets/${r.ticketId}` };
  if (r.ticketId.startsWith('Q-')) return { label: ko ? '비서실장 초안' : 'Drafts', to: '/' };
  return { label: ko ? '대화방' : 'Chat', to: `/chat/${encodeURIComponent(r.ticketId)}` };
}

export function Live({ runId }: { runId: string | null }) {
  const { state } = useCompany();
  const { lang } = useT();
  const { go } = useRoute();
  const ko = lang === 'ko';
  const [, tick] = useState(0);
  const [last, setLast] = useState<Record<string, { at: string | null; line: string; busy?: string | null }>>({});
  useEffect(() => {
    const t = setInterval(() => tick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const running = (state?.runs ?? []).filter((r) => r.status === 'running' || r.status === 'prepared');
  // state.runs는 최신순이다.
  const recent = (state?.runs ?? []).filter((r) => r.status !== 'running' && r.status !== 'prepared').slice(0, 12);

  // 실행 중인 것의 최근 활동 한 줄과 마지막 출력 시각(멈춤 감지)
  useEffect(() => {
    let live = true;
    const poll = async () => {
      const next: Record<string, { at: string | null; line: string; busy?: string | null }> = {};
      for (const r of running) {
        const a = await api<Activity>(`runs/${r.id}/activity`).catch(() => null);
        if (a)
          next[r.id] = {
            at: a.lastOutputAt,
            busy: a.busy,
            line: [...a.items].reverse().find((i) => i.text && i.kind !== 'output')?.text ?? '',
          };
        // 카드 한 줄은 명령 결과(예: "Exit code 1")가 아니라 직원이 한 말·행동으로: 중간 결과가 오류처럼 보였다(실측).
      }
      if (live) setLast(next);
    };
    void poll();
    const t = setInterval(poll, 4000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [running.map((r) => r.id).join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!state) return <Skeleton />;
  // 고른 실행만 연다. 대표 요청(2026-10-03): 작업 현황에 들어가면 원하든 말든 첫 진행 중 작업이 열려 닫을 수도 없었다.
  const selected = runId;

  const Card = ({ r }: { r: RunSummary }) => {
    const info = last[r.id];
    const stalled = r.status === 'running' && info?.at && Date.now() - Date.parse(info.at) > STALL_MS;
    const place = runPlace(r, ko);
    return (
      <button
        className={`live-card ${selected === r.id ? 'on' : ''}`}
        onClick={() => go(selected === r.id ? '/live' : `/live/${r.id}`)}
        title={selected === r.id ? (ko ? '한 번 더 누르면 닫힙니다' : 'Click again to close') : undefined}
      >
        <div className="spread">
          <span className="row">
            <Avatar employees={state.employees} id={r.employeeId} />
            <b>{state.employees.find((e) => e.id === r.employeeId)?.name ?? r.employeeId}</b>
            <span className="chip">{ko ? KIND[r.kind]?.[0] : KIND[r.kind]?.[1]}</span>
          </span>
          <span className="sub">{r.status === 'running' ? elapsed(r.startedAt) : when(r.endedAt)}</span>
        </div>
        <div className="sub" style={{ marginTop: 4 }}>
          {place.label}
          {r.usage?.total ? ` · ${fmtTokens(r.usage.total, lang)} ${ko ? '토큰' : 'tokens'}` : ''}
          {r.status !== 'running' && ` · ${r.status}`}
        </div>
        {r.status === 'running' && (
          <div className={`live-line ${stalled ? 'stalled' : ''}`}>
            {stalled
              ? ko
                ? `⚠ ${Math.round((Date.now() - Date.parse(info!.at!)) / 60000)}분째 아무 신호 없음 (큰 파일을 한 번에 쓰면 그럴 수 있어요) · `
                : '⚠ quiet · '
              : info?.busy
                ? ko
                  ? `${({ writing: '✍ 파일 작성 중', thinking: '💭 생각 중', saying: '💬 보고 쓰는 중' } as Record<string, string>)[info.busy] ?? '…'} · `
                  : `${info.busy}… · `
                : ''}
            {info?.line ?? (ko ? '시작하는 중…' : 'Starting…')}
          </div>
        )}
      </button>
    );
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{ko ? '작업 현황' : 'Live work'}</h1>
          <div className="sub">
            {ko
              ? '직원이 지금 무엇을 하는지 실시간으로 봅니다. 생각·파일 작성 중이면 그렇게 보여 주고, 5분 넘게 아무 신호가 없으면 표시합니다.'
              : 'What each employee is doing right now. Runs quiet for 5+ minutes are flagged.'}
          </div>
        </div>
      </div>
      <div className="live-layout">
        <div className="live-list">
          <div className="nav-label">{ko ? `진행 중 ${running.length}` : `Running ${running.length}`}</div>
          {running.length === 0 && (
            <div className="sub" style={{ padding: 8 }}>
              {ko ? '지금 일하는 직원이 없습니다.' : 'Nobody is working right now.'}
            </div>
          )}
          {running.map((r) => (
            <Card key={r.id} r={r} />
          ))}
          <div className="nav-label" style={{ marginTop: 12 }}>
            {ko ? '최근 끝난 실행' : 'Recently finished'}
          </div>
          {recent.map((r) => (
            <Card key={r.id} r={r} />
          ))}
        </div>
        <div className="live-detail">
          {selected ? (
            <RunLog key={selected} runId={selected} onClose={() => go('/live')} />
          ) : (
            <EmptyState icon="activity">{ko ? '실행을 고르세요' : 'Pick a run'}</EmptyState>
          )}
        </div>
      </div>
    </>
  );
}

function RunLog({ runId, onClose }: { runId: string; onClose: () => void }) {
  const { state } = useCompany();
  const { lang } = useT();
  const ko = lang === 'ko';
  const [a, setA] = useState<Activity | null>(null);
  const [hideThinking, setHideThinking] = useState(false);
  const [steer, setSteer] = useState('');
  const { busy, run } = useAction();
  useEffect(() => {
    let live = true;
    const load = () =>
      api<Activity>(`runs/${runId}/activity`)
        .then((x) => live && setA(x))
        .catch(() => {});
    void load();
    const t = setInterval(() => {
      if (a?.run.status === 'running' || !a) void load();
    }, 2000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [runId, a?.run.status]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!a || !state) return <Skeleton />;
  const r = a.run;
  const emp = state.employees.find((e) => e.id === r.employeeId);
  const place = runPlace(r, ko);
  const items = a.items.filter((i) => !hideThinking || i.kind !== 'think');
  return (
    <div className="card">
      <div className="card-head">
        <span className="row">
          <Avatar employees={state.employees} id={r.employeeId} /> {emp?.name ?? r.employeeId} ·{' '}
          {ko ? KIND[r.kind]?.[0] : KIND[r.kind]?.[1]}
          {emp && <CliChip cli={emp.cli} model={emp.model} effort={emp.effort} />}
        </span>
        <span className="row">
          <Link to={place.to}>{place.label}</Link>
          <span className="sub">
            {r.status === 'running'
              ? `${ko ? '진행' : 'running'} ${elapsed(r.startedAt)}`
              : `${r.status} · ${elapsed(r.startedAt, r.endedAt)}`}
          </span>
          <button className="btn small" onClick={onClose}>
            {ko ? '닫기' : 'Close'}
          </button>
        </span>
      </div>
      <div className="body">
        {/* 오래 조용하면(10분+) 멈췄을 수 있다: 대표가 끊고 다시 시킬 수 있다 */}
        {r.status === 'running' && state.stalledRuns?.some((s) => s.runId === r.id) && (
          <div className="banner warn" style={{ marginBottom: 10 }}>
            <div>
              {ko
                ? `⚠ ${Math.round((state.stalledRuns.find((s) => s.runId === r.id)!.quietMs ?? 0) / 60000)}분째 아무 신호가 없습니다. 끝나지 않는 명령(서버·시험 스크립트 등)을 기다리고 있을 수 있습니다.`
                : '⚠ No output for a long time; it may be waiting on a command that never ends.'}
            </div>
            <div className="sub">
              {ko
                ? '끊으면 이 실행은 실패로 처리되고, 작업이면 "끝나지 않는 명령을 기다리지 말 것"이라는 메모와 함께 다시 시킵니다(실행 1회 사용). 그냥 두면 30분 시간 제한에서 끝납니다.'
                : 'Cutting it ends this run; work is retried with a note not to wait on endless commands. Otherwise it ends at the 30-minute limit.'}
            </div>
            <button
              className="btn small"
              style={{ marginTop: 8 }}
              disabled={busy}
              onClick={() =>
                run(() => api(`runs/${r.id}/restart`, { body: {} }), ko ? '끊었습니다. 곧 다시 시킵니다.' : 'Cut. It will be retried.')
              }
            >
              {ko ? '끊고 다시 시키기' : 'Cut and restart'}
            </button>
          </div>
        )}
        <label className="check-row small">
          <input type="checkbox" checked={hideThinking} onChange={() => setHideThinking(!hideThinking)} />
          {ko ? '생각 과정 숨기기' : 'Hide thinking'}
        </label>
        <div className="timeline">
          {items.length === 0 && <div className="sub">{ko ? '아직 출력이 없습니다.' : 'No output yet.'}</div>}
          {items.map((i, n) => (
            <div key={n} className={`tl tl-${i.kind}`}>
              <span className="tl-icon">{ICON[i.kind]}</span>
              {i.detail ? (
                <details>
                  <summary>{i.text || i.kind}</summary>
                  <pre className="code">{i.detail}</pre>
                </details>
              ) : (
                <span className="tl-text">{i.text}</span>
              )}
            </div>
          ))}
        </div>
        {a.total > a.items.length && (
          <div className="sub">
            {ko ? `앞의 ${a.total - a.items.length}개는 생략` : `${a.total - a.items.length} earlier items omitted`}
          </div>
        )}
        {r.status === 'running' && r.kind !== 'chat' && (
          <div className="composer" style={{ marginTop: 10 }}>
            <textarea
              value={steer}
              rows={2}
              onChange={(e) => setSteer(e.target.value)}
              placeholder={
                r.cli === 'codex'
                  ? ko
                    ? '작업 중인 직원에게 지시 — 다음 단계에서 바로 반영됩니다'
                    : 'Steer — applied at the next step'
                  : ko
                    ? '지시 — 이 AI는 일하는 도중엔 지시를 받지 못해 다음 차례에 전달됩니다'
                    : 'Instruction — delivered next round (this CLI cannot take mid-run input)'
              }
            />
            <button
              className="btn primary"
              disabled={busy || !steer.trim()}
              onClick={() =>
                run(() => api(`runs/${r.id}/steer`, { body: { text: steer } }), ko ? '지시를 보냈습니다.' : 'Sent.').then(
                  (ok) => ok && setSteer(''),
                )
              }
            >
              {ko ? '지시 보내기' : 'Send'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

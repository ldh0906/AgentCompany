// 토큰 사용량 표시: 숫자 서식, 오늘/누적 요약, 14일 막대, 직원별 막대. 시리즈는 하나라 한 가지 색(강조색)만 쓴다.
import { useState } from 'react';
import { api } from '../api.ts';
import { useCompany } from '../App.tsx';
import { useT } from '../i18n.ts';
import { Avatar, EmptyState, Icon } from './ui.tsx';

export function fmtTokens(n: number, lang: string): string {
  if (lang === 'ko') {
    if (n >= 1e8) return `${(n / 1e8).toFixed(n >= 1e9 ? 1 : 2)}억`;
    if (n >= 1e4) return `${(n / 1e4).toFixed(n >= 1e5 ? 0 : 1)}만`;
    return n.toLocaleString('ko-KR');
  }
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 1 : 2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}K`;
  return String(n);
}

const localDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** 최근 N일 막대(값이 0인 날도 자리를 둔다). 마우스를 올리면 날짜와 값. */
function DailyBars({ daily, days = 14 }: { daily: Record<string, { total: number }>; days?: number }) {
  const { lang } = useT();
  const [hover, setHover] = useState<number | null>(null);
  const list = Array.from({ length: days }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - (days - 1 - i));
    const key = localDay(d);
    return { key, label: `${d.getMonth() + 1}/${d.getDate()}`, v: daily[key]?.total ?? 0 };
  });
  const max = Math.max(1, ...list.map((x) => x.v));
  const h = hover === null ? null : list[hover]!;
  return (
    <div className="daily">
      <div className="daily-tip" aria-live="polite">
        {h ? (
          <>
            <b>{fmtTokens(h.v, lang)}</b> <span className="sub">{h.label}</span>
          </>
        ) : (
          <span className="sub">{lang === 'ko' ? `최근 ${days}일` : `Last ${days} days`}</span>
        )}
      </div>
      <div
        className="daily-bars"
        onMouseLeave={() => setHover(null)}
        role="img"
        aria-label={lang === 'ko' ? '일별 토큰 사용량' : 'Daily token usage'}
      >
        {list.map((x, i) => (
          <div key={x.key} className={`daily-slot ${hover === i ? 'on' : ''}`} onMouseEnter={() => setHover(i)}>
            <div className="daily-bar" style={{ height: `${x.v ? Math.max(4, (x.v / max) * 100) : 0}%` }} />
          </div>
        ))}
      </div>
      <div className="daily-axis sub">
        <span>{list[0]!.label}</span>
        <span>{lang === 'ko' ? '오늘' : 'Today'}</span>
      </div>
    </div>
  );
}

/** 하루 토큰 한도: 넘으면 회사 전체가 멈추고 다음 날 자동으로 다시 시작한다. */
function DailyLimit() {
  const { lang } = useT();
  const { state, reload } = useCompany();
  const ko = lang === 'ko';
  const [edit, setEdit] = useState<string | null>(null);
  if (!state?.usage) return null;
  const limit = state.dailyLimit ?? 0;
  const used = state.usage.today.total;
  const pct = limit ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  const save = (v: number) =>
    void api('daily-limit', { body: { tokens: v } })
      .then(() => (setEdit(null), reload()))
      .catch(() => {});
  return (
    <div className="daily-limit">
      <div className="spread">
        <span className="sub">
          {ko ? '하루 한도' : 'Daily limit'}: <b>{limit ? `${fmtTokens(used, lang)} / ${fmtTokens(limit, lang)}` : ko ? '없음' : 'none'}</b>
          {state.pausedReason?.startsWith('daily:') && <span className="chip warn">{ko ? '한도 도달로 멈춤' : 'paused by limit'}</span>}
        </span>
        {edit === null ? (
          <button className="btn small" onClick={() => setEdit(limit ? String(Math.round(limit / 1e4)) : '')}>
            {ko ? '한도 정하기' : 'Set limit'}
          </button>
        ) : (
          <span className="row">
            <input
              style={{ width: 90 }}
              value={edit}
              onChange={(e) => setEdit(e.target.value.replace(/[^0-9]/g, ''))}
              placeholder={ko ? '만 토큰' : '10k tokens'}
            />
            <span className="sub">{ko ? '만' : '×10k'}</span>
            <button className="btn small primary" onClick={() => save(Number(edit || 0) * 1e4)}>
              {ko ? '저장' : 'Save'}
            </button>
          </span>
        )}
      </div>
      {limit > 0 && (
        <div className="bar" style={{ marginTop: 6 }}>
          <i style={{ width: `${pct}%`, background: pct >= 90 ? 'var(--bad)' : pct >= 70 ? 'var(--warn)' : 'var(--ok)' }} />
        </div>
      )}
      <div className="hint">
        {ko
          ? '한도에 닿으면 새 작업을 멈추고(진행 중인 것은 마무리) 다음 날 자동으로 다시 시작합니다. 0이면 한도 없음.'
          : 'At the limit, new work stops (running work finishes) and resumes tomorrow. 0 = no limit.'}
      </div>
    </div>
  );
}

export function UsagePanel() {
  const { lang } = useT();
  const { state } = useCompany();
  const ko = lang === 'ko';
  if (!state?.usage) return null;
  const { usage, employees } = state;
  const people = employees
    .map((e) => ({ e, v: usage.byEmployee[e.id]?.total ?? 0 }))
    .filter((x) => x.v > 0)
    .sort((a, b) => b.v - a.v);
  const top = Math.max(1, ...people.map((x) => x.v));
  const cacheRate = usage.all.input ? Math.round((usage.all.cacheRead / usage.all.input) * 100) : 0;
  return (
    <div className="card">
      <h2>
        <span className="row">
          <Icon name="spark" /> {ko ? '토큰 사용량' : 'Token usage'}
        </span>
        <span className="sub">{ko ? 'AI가 보고한 값' : 'as reported by the CLIs'}</span>
      </h2>
      <div className="body" style={{ paddingBottom: 0 }}>
        <DailyLimit />
      </div>
      {usage.all.runs === 0 ? (
        <EmptyState icon="spark">
          {ko ? '아직 사용량 기록이 없습니다. 직원이 일하면 여기에 쌓입니다.' : 'No usage yet. It accumulates as employees work.'}
        </EmptyState>
      ) : (
        <div className="body usage">
          <div className="usage-kpis">
            <div>
              <div className="sub">{ko ? '오늘' : 'Today'}</div>
              <div className="usage-hero">{fmtTokens(usage.today.total, lang)}</div>
              <div className="sub">{ko ? `실행 ${usage.today.runs}회` : `${usage.today.runs} runs`}</div>
            </div>
            <div>
              <div className="sub">{ko ? '누적' : 'All time'}</div>
              <div className="usage-num">{fmtTokens(usage.all.total, lang)}</div>
              <div className="sub">
                {ko
                  ? `입력 ${fmtTokens(usage.all.input, lang)} · 출력 ${fmtTokens(usage.all.output, lang)}`
                  : `in ${fmtTokens(usage.all.input, lang)} · out ${fmtTokens(usage.all.output, lang)}`}
              </div>
            </div>
            <div>
              <div className="sub">{ko ? '캐시 재사용' : 'Cache reuse'}</div>
              <div className="usage-num">{cacheRate}%</div>
              {usage.all.costUsd > 0 && (
                <div
                  className="sub"
                  title={
                    ko
                      ? 'Claude가 보고한 API 기준 추정치(구독 요금과 다름)'
                      : 'API-equivalent estimate reported by Claude (not your subscription price)'
                  }
                >
                  {ko ? 'Claude 추정' : 'Claude est.'} ${usage.all.costUsd.toFixed(2)}
                </div>
              )}
            </div>
          </div>
          <DailyBars daily={usage.daily} />
          {people.length > 0 && (
            <div className="usage-people">
              {people.map(({ e, v }) => (
                <div className="usage-row" key={e.id} title={`${e.name}: ${v.toLocaleString()}`}>
                  <Avatar employees={employees} id={e.id} />
                  <span className="nm">{e.name}</span>
                  <span className="track">
                    <span className="fill" style={{ width: `${Math.max(2, (v / top) * 100)}%` }} />
                  </span>
                  <span className="val">{fmtTokens(v, lang)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

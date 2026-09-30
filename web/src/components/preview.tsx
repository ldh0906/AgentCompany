// 실행해 보기: 제출물이나 최신 결과물을 띄워 대표가 직접 확인한다.
import { useEffect, useState } from 'react';
import { api, type PreviewInfo } from '../api.ts';
import { useCompany } from '../App.tsx';
import { useT } from '../i18n.ts';
import { empName, Icon, Modal, useAction } from './ui.tsx';
import { verdictsOf } from '../../../src/core/verdicts.ts';

export function PreviewButton({ projectId, ticketId = null }: { projectId: string; ticketId?: string | null }) {
  const { state, reload } = useCompany();
  const { lang } = useT();
  const ko = lang === 'ko';
  const { busy, run } = useAction();
  const [last, setLast] = useState<PreviewInfo | null>(null);
  const key = `${projectId}:${ticketId ?? 'base'}`;
  const fromState = state?.previews?.find((p) => p.key === key);
  const live = fromState ?? (state?.previews ? null : last);
  const open = (url: string) => window.open(url, '_blank', 'noopener');
  const start = () =>
    run(async () => {
      const info = await api<PreviewInfo>(`projects/${projectId}/preview`, { body: ticketId ? { ticketId } : {} });
      setLast(info);
      reload();
      if (info.url) open(info.url);
      else if (info.state === 'failed')
        throw new Error(ko ? '실행하지 못했습니다. 아래 기록을 확인하세요.' : 'Could not start. See the log below.');
    });
  const stop = () =>
    run(async () => {
      await api(`projects/${projectId}/preview-stop`, { body: ticketId ? { ticketId } : {} });
      setLast(null);
      reload();
    });

  return (
    <span className="preview">
      {live?.state === 'running' && live.url && !live.stale ? (
        <>
          <button className="btn small ok" onClick={() => open(live.url!)}>
            <Icon name="arrow" size={13} /> {ko ? '열기' : 'Open'}
          </button>
          <button className="btn small" disabled={busy} onClick={() => void stop()}>
            {ko ? '중지' : 'Stop'}
          </button>
        </>
      ) : (
        <button
          className="btn small"
          disabled={busy}
          onClick={() => void start()}
          title={ko ? '설치 후 개발 서버를 띄웁니다' : 'Installs and starts the dev server'}
        >
          <Icon name="bolt" size={13} />{' '}
          {busy
            ? ko
              ? '띄우는 중…'
              : 'Starting…'
            : live?.stale
              ? ko
                ? '새 제출물로 다시 실행'
                : 'Run the new submission'
              : ko
                ? '실행해 보기'
                : 'Run it'}
        </button>
      )}
      {live && live.state === 'failed' && (
        <details className="advanced">
          <summary>{ko ? '실행 기록' : 'Run log'}</summary>
          <pre className="code">{live.log.slice(-3000)}</pre>
        </details>
      )}
    </span>
  );
}

/** 자동 화면 점검: 앱이 결과물을 띄워 찍은 사진과 QA 직원 의견. 대표는 이걸 보고 체크한다. */
export function ScreenCheckPanel({ ticketId }: { ticketId: string }) {
  const { state, reload } = useCompany();
  const { lang } = useT();
  const ko = lang === 'ko';
  const { busy, run } = useAction();
  const c = state?.screenChecks?.[ticketId];
  const [imgs, setImgs] = useState<{ label: string; dataUrl: string }[]>([]);
  const [zoom, setZoom] = useState<{ label: string; dataUrl: string } | null>(null);
  useEffect(() => {
    if (c?.state !== 'done') return setImgs([]);
    api<{ label: string; dataUrl: string }[]>(`tickets/${ticketId}/screens`)
      .then(setImgs)
      .catch(() => setImgs([]));
  }, [ticketId, c?.state, c?.at]);
  if (!c) return null;
  const again = () => run(() => api(`tickets/${ticketId}/screen-check`, { body: {} })).then(reload);
  const qaName = c.qaBy ? empName(state?.employees ?? [], c.qaBy) : null;
  return (
    <div className="screen-check">
      <div className="spread">
        <b>{ko ? '자동 화면 점검' : 'Automatic screen check'}</b>
        {c.state !== 'running' && (
          <button className="btn small" disabled={busy} onClick={() => void again()}>
            {ko ? '다시 찍기' : 'Retake'}
          </button>
        )}
      </div>
      {c.state === 'running' && (
        <div className="hint">{ko ? '결과물을 띄워 화면을 찍는 중…' : 'Starting the submission and taking screenshots…'}</div>
      )}
      {c.state === 'failed' && <div className="hint">{c.note}</div>}
      {c.state === 'done' && (
        <>
          <div className="shots">
            {c.shots.map((s, i) => (
              <button key={i} className="shot" onClick={() => imgs[i] && setZoom(imgs[i]!)} title={ko ? '크게 보기' : 'Enlarge'}>
                {imgs[i] ? <img src={imgs[i]!.dataUrl} alt={s.label} /> : <span className="shot-empty" />}
                <span>{s.label}</span>
              </button>
            ))}
          </div>
          {(c.clips ?? []).length > 0 && (
            <div className="row" style={{ flexWrap: 'wrap' }}>
              {(c.clips ?? []).map((x, i) => (
                <ClipButton
                  key={`${c.at}-${i}`}
                  ticketId={ticketId}
                  index={i}
                  label={x.label}
                  seconds={Math.max(1, Math.round(x.count / x.fps))}
                />
              ))}
            </div>
          )}
          {(c.downloads ?? []).map((f) => (
            <details key={f.name} className="advanced">
              <summary>
                {ko ? '내려받은 파일' : 'Downloaded'}: <b>{f.name}</b> ({Math.max(1, Math.round(f.size / 1024))}KB)
                {f.verdict ? ` — ${f.verdict}` : ''}
              </summary>
              {f.text && <pre className="code">{f.text.preview}</pre>}
            </details>
          ))}
          {c.errors.length > 0 ? (
            <details className="advanced">
              <summary>{ko ? `브라우저 콘솔 오류 ${c.errors.length}개` : `${c.errors.length} console errors`}</summary>
              <pre className="code">{c.errors.join('\n')}</pre>
            </details>
          ) : (
            <div className="hint">{ko ? '브라우저 콘솔 오류 없음' : 'No console errors'}</div>
          )}
          {qaName && c.opinion && verdictsOf(c.opinion).length > 0 && (
            // 한 줄 결론: 요구사항마다 ✅/⚠/❓. 긴 의견은 아래에 접어 둔다(실측: 카드가 너무 길었다).
            <div className="verdicts">
              {verdictsOf(c.opinion).map((v) => (
                <div key={v.id} className={`verdict ${v.mark === '✅' ? 'ok' : v.mark === '⚠' ? 'bad' : 'unk'}`}>
                  <b>
                    {v.id} {v.mark}
                  </b>{' '}
                  {v.line}
                  {v.ceo && <div className="sub">👉 {v.ceo}</div>}
                </div>
              ))}
            </div>
          )}
          {qaName && c.opinion && verdictsOf(c.opinion).length > 0 ? (
            <details className="advanced">
              <summary>{ko ? `${qaName} 의견 자세히` : `${qaName}'s full notes`}</summary>
              <div className="note qa-opinion">{c.opinion}</div>
            </details>
          ) : (
            qaName && (
              <div className="note qa-opinion">
                <b>{qaName}</b>{' '}
                {c.opinion ??
                  (c.qaState === 'running' || c.qaState === 'prepared'
                    ? ko
                      ? '화면을 보고 의견을 쓰는 중…'
                      : 'Looking at the screenshots…'
                    : ko
                      ? '의견을 받지 못했습니다. 업무방에서 불러 물어볼 수 있습니다.'
                      : 'No opinion. You can ask in the ticket room.')}
              </div>
            )
          )}
          <div className="hint">
            {c.scripted
              ? ko
                ? '담당 직원이 남긴 확인 순서대로 기계가 조작하고 찍었습니다. 사진과 의견은 참고용이고, 체크는 대표가 합니다.'
                : 'The machine followed the check steps the implementer left. Use this as a hint; the ticks are yours.'
              : ko
                ? '담당 직원이 확인 순서를 남기지 않아, 기계가 흔한 조작(클릭·Enter·방향키·스페이스·Z)만 해 봤습니다. 사진과 의견은 참고용이고, 체크는 대표가 합니다.'
                : 'No check steps were left, so the machine only clicked and pressed Enter/arrows/Space/Z. The ticks are yours.'}
          </div>
        </>
      )}
      {zoom && (
        <Modal title={zoom.label} onClose={() => setZoom(null)}>
          <img src={zoom.dataUrl} alt={zoom.label} style={{ width: '100%', borderRadius: 8 }} />
        </Modal>
      )}
    </div>
  );
}

/** 녹화 재생: 누를 때만 불러와(대시보드를 무겁게 하지 않게) 초당 몇 장으로 되풀이해 보여 준다. */
function ClipButton({ ticketId, index, label, seconds }: { ticketId: string; index: number; label: string; seconds: number }) {
  const { lang } = useT();
  const ko = lang === 'ko';
  const [clip, setClip] = useState<{ label: string; fps: number; frames: string[] } | null>(null);
  const [error, setError] = useState('');
  const [i, setI] = useState(0);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!clip) return;
    const t = setInterval(() => setI((n) => (n + 1) % clip.frames.length), 1000 / clip.fps);
    return () => clearInterval(t);
  }, [clip]);
  const open = () => {
    setLoading(true);
    api<{ label: string; fps: number; frames: string[] }>(`tickets/${ticketId}/clips?n=${index}`)
      .then((x) => (setI(0), setClip(x)))
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  };
  return (
    <>
      <button className="btn small" disabled={loading} onClick={open} title={error || undefined}>
        ▶ {ko ? `${label} 움직임 보기 (${seconds}초)` : `${label} motion (${seconds}s)`}
      </button>
      {clip && (
        <Modal title={ko ? `${clip.label} 움직임 (${i + 1}/${clip.frames.length})` : `${clip.label} motion`} onClose={() => setClip(null)}>
          <img src={clip.frames[i]} alt="" style={{ width: '100%', borderRadius: 8 }} />
          <div className="hint">
            {ko
              ? '기계가 조작하는 동안과 그 직후 몇 초만, 초당 4장으로 찍었습니다. 끊겨 보이는 건 정상입니다.'
              : 'Recorded at 4 frames per second during and right after each action.'}
          </div>
        </Modal>
      )}
    </>
  );
}

/** 고급 QA: 직원이 직접 플레이해 보고 요구사항마다 한 줄 결론과 플레이 일지를 남긴다. 누를 때만(또는 요청 완료 때 자동) 돈다. */
export function PlaytestPanel({ ticketId, requestId }: { ticketId?: string; requestId?: string }) {
  const { state, reload } = useCompany();
  const { lang } = useT();
  const ko = lang === 'ko';
  const { busy, run } = useAction();
  const key = ticketId ?? `Q:${requestId}`;
  const p = state?.playtests?.[key];
  const [shots, setShots] = useState<{ name: string; dataUrl: string }[] | null>(null);
  const [zoom, setZoom] = useState<string | null>(null);
  const start = () =>
    run(
      () => api(ticketId ? `tickets/${ticketId}/playtest` : `requests/${requestId}/playtest`, { body: {} }),
      ko ? '고급 QA가 플레이를 시작합니다.' : 'Play test started.',
    ).then(reload);
  const v = p?.opinion ? verdictsOf(p.opinion) : [];
  return (
    <div className="screen-check">
      <div className="spread">
        <b>{ko ? '🎮 고급 QA (직접 플레이)' : '🎮 Play test'}</b>
        {p?.state !== 'running' && (
          <button
            className="btn small"
            disabled={busy}
            onClick={() => void start()}
            title={ko ? '한 번에 약 300만~700만 토큰(실측 637만, 약 $2.4)' : 'About 3-7M tokens'}
          >
            {p ? (ko ? '다시 플레이' : 'Play again') : ko ? '직접 플레이해 보기' : 'Play it'}
          </button>
        )}
      </div>
      {!p && (
        <div className="hint">
          {ko
            ? 'QA 직원이 사람처럼 보고·누르며 직접 플레이하고, 손맛·흐름·버그를 적습니다. 한 번에 약 300만~700만 토큰(실측 637만, 약 $2.4).'
            : 'A QA colleague plays it like a person and reports feel, flow and bugs.'}
        </div>
      )}
      {p?.state === 'running' && <div className="hint">{ko ? '플레이 중… (보통 5~20분)' : 'Playing… (usually 5-20 min)'}</div>}
      {p?.state === 'failed' && <div className="hint">{ko ? `플레이하지 못했습니다: ${p.note}` : `Failed: ${p.note}`}</div>}
      {p?.state === 'done' && (
        <>
          {v.length > 0 && (
            <div className="verdicts">
              {v.map((x) => (
                <div key={x.id} className={`verdict ${x.mark === '✅' ? 'ok' : x.mark === '⚠' ? 'bad' : 'unk'}`}>
                  <b>
                    {x.id} {x.mark}
                  </b>{' '}
                  {x.line}
                </div>
              ))}
            </div>
          )}
          <details className="advanced">
            <summary>{ko ? '플레이 일지·문제 자세히' : 'Full report'}</summary>
            <div className="note qa-opinion">{p.opinion}</div>
          </details>
          {shots === null ? (
            <button
              className="btn small"
              onClick={() => void api<{ name: string; dataUrl: string }[]>(`playtests/${encodeURIComponent(key)}/shots`).then(setShots)}
            >
              {ko ? '플레이 사진 보기' : 'Show screenshots'}
            </button>
          ) : (
            <div className="shots">
              {shots.map((s) => (
                <button key={s.name} className="shot" onClick={() => setZoom(s.dataUrl)}>
                  <img src={s.dataUrl} alt={s.name} />
                  <span>{s.name}</span>
                </button>
              ))}
            </div>
          )}
        </>
      )}
      {zoom && (
        <Modal title={ko ? '플레이 사진' : 'Screenshot'} onClose={() => setZoom(null)}>
          <img src={zoom} alt="" style={{ width: '100%', borderRadius: 8 }} />
        </Modal>
      )}
    </div>
  );
}

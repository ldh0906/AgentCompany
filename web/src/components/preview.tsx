// 실행해 보기: 제출물이나 최신 결과물을 띄워 대표가 직접 확인한다.
import { useEffect, useState } from 'react';
import { api, type PreviewInfo } from '../api.ts';
import { useCompany } from '../App.tsx';
import { useT } from '../i18n.ts';
import { empName, Icon, Modal, useAction } from './ui.tsx';

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
          {c.errors.length > 0 ? (
            <details className="advanced">
              <summary>{ko ? `브라우저 콘솔 오류 ${c.errors.length}개` : `${c.errors.length} console errors`}</summary>
              <pre className="code">{c.errors.join('\n')}</pre>
            </details>
          ) : (
            <div className="hint">{ko ? '브라우저 콘솔 오류 없음' : 'No console errors'}</div>
          )}
          {qaName && (
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
          )}
          <div className="hint">
            {ko
              ? '기계가 한 조작은 클릭·Enter·방향키·스페이스·Z 정도입니다. 사진과 의견은 참고용이고, 체크는 대표가 합니다.'
              : 'The machine only clicked and pressed Enter/arrows/Space/Z. Use this as a hint; the ticks are yours.'}
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

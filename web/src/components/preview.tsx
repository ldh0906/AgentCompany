// 실행해 보기: 제출물이나 최신 결과물을 띄워 대표가 직접 확인한다.
import { useState } from 'react';
import { api, type PreviewInfo } from '../api.ts';
import { useCompany } from '../App.tsx';
import { useT } from '../i18n.ts';
import { Icon, useAction } from './ui.tsx';

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

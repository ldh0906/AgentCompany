import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Employee, Ticket } from '../api.ts';
import { useT } from '../i18n.ts';

export function statusTone(s: string): string {
  if (s === 'done') return 'ok';
  if (s === 'failed' || s === 'cancelled') return 'bad';
  if (s === 'awaiting_approval') return 'warn';
  if (s === 'in_progress' || s === 'verifying' || s === 'in_review' || s === 'integrating') return 'info';
  if (s === 'changes_requested') return 'accent';
  return '';
}

export function StatusChip({ status }: { status: string }) {
  const { status: label } = useT();
  const live = ['in_progress', 'verifying', 'in_review', 'integrating'].includes(status);
  return <span className={`chip ${statusTone(status)} ${live ? 'pulse' : ''}`}>{label(status)}</span>;
}

export function HoldChip({ ticket }: { ticket: Ticket }) {
  const { hold } = useT();
  if (!ticket.hold) return null;
  return (
    <span className="chip bad">
      <Icon name="pause" size={11} /> {hold(ticket.hold.reason)}
    </span>
  );
}

export function CliChip({ cli, model }: { cli: string; model?: string | null }) {
  const names: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', agy: 'Antigravity', fake: 'Demo' };
  return (
    <span className="chip accent" title={model ?? ''}>
      {names[cli] ?? cli}
      {model ? ` · ${model}` : ''}
    </span>
  );
}

// ---- 아이콘 (의존성 없는 인라인 SVG, 24x24 선 아이콘) ----
const ICONS = {
  dashboard: 'M3 3h7v9H3zM14 3h7v5h-7zM14 12h7v9h-7zM3 16h7v5H3z',
  board: 'M4 3h4v18H4zM10 3h4v12h-4zM16 3h4v8h-4z',
  team: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  book: 'M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5zM4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5',
  cpu: 'M6 6h12v12H6zM9 9h6v6H9zM9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4',
  plus: 'M12 5v14M5 12h14',
  inbox:
    'M22 12h-6l-2 3h-4l-2-3H2M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z',
  pause: 'M10 4H6v16h4zM18 4h-4v16h4z',
  activity: 'M22 12h-4l-3 9L9 3l-3 9H2',
  check: 'M20 6 9 17l-5-5',
  bolt: 'M13 2 3 14h9l-1 8 10-12h-9z',
  shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
  spark: 'M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M5.6 18.4l2.8-2.8M15.6 8.4l2.8-2.8',
  arrow: 'M5 12h14M13 6l6 6-6 6',
} as const;
export type IconName = keyof typeof ICONS;

export function Icon({ name, size }: { name: IconName; size?: number }) {
  return (
    <svg className="icon" viewBox="0 0 24 24" aria-hidden="true" style={size ? { width: size, height: size } : undefined}>
      <path d={ICONS[name]} />
    </svg>
  );
}

export function EmptyState({ icon, children }: { icon: IconName; children: ReactNode }) {
  return (
    <div className="emptystate">
      <span className="glyph">
        <Icon name={icon} />
      </span>
      <div>{children}</div>
    </div>
  );
}

export function Skeleton() {
  return (
    <div className="skeleton" aria-busy="true">
      <div className="bar" style={{ width: 180, height: 22 }} />
      <div className="grid cols-4">
        <div className="block" />
        <div className="block" />
        <div className="block" />
        <div className="block" />
      </div>
      <div className="block" style={{ height: 240 }} />
    </div>
  );
}

/** CLI별 색으로 구분되는 이니셜 아바타. */
export function Avatar({ employees, id }: { employees: Employee[]; id: string | null }) {
  const e = employees.find((x) => x.id === id);
  if (!e) return null;
  return (
    <span className={`avatar ${e.cli}`} title={e.name}>
      {[...e.name.trim()][0]?.toUpperCase() ?? '?'}
    </span>
  );
}

export function empName(employees: Employee[], id: string | null): string {
  if (!id) return '—';
  return employees.find((e) => e.id === id)?.name ?? id;
}

export function when(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return `${Math.max(1, Math.round(diff))}s`;
  if (diff < 3600) return `${Math.round(diff / 60)}m`;
  if (diff < 86400) return `${Math.round(diff / 3600)}h`;
  return d.toLocaleDateString();
}

export function Modal({
  title,
  onClose,
  children,
  actions,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  actions?: ReactNode;
}) {
  const { t } = useT();
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label={title}>
        <div className="head">
          <h2>{title}</h2>
          <button className="btn small" onClick={onClose}>
            {t('close')}
          </button>
        </div>
        <div className="content">{children}</div>
        {actions && <div className="actions">{actions}</div>}
      </div>
    </div>
  );
}

type ToastMsg = { text: string; error?: boolean } | null;
const ToastContext = createContext<(text: string, error?: boolean) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [msg, setMsg] = useState<ToastMsg>(null);
  useEffect(() => {
    if (!msg) return;
    const id = setTimeout(() => setMsg(null), msg.error ? 7000 : 3500);
    return () => clearTimeout(id);
  }, [msg]);
  return (
    <ToastContext.Provider value={(text, error) => setMsg({ text, error })}>
      {children}
      {msg && <div className={`toast ${msg.error ? 'error' : ''}`}>{msg.text}</div>}
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}

/** 버튼 클릭 → API 호출 → 성공/실패 알림을 한 번에. */
export function useAction() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    try {
      await fn();
      if (ok) toast(ok);
      return true;
    } catch (error) {
      toast(String((error as Error).message ?? error), true);
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, run };
}

export function DiffView({ text }: { text: string }) {
  if (!text) return <div className="emptystate">—</div>;
  return (
    <pre className="code diff">
      {text.split('\n').map((line, i) => {
        const cls =
          line.startsWith('+') && !line.startsWith('+++')
            ? 'add'
            : line.startsWith('-') && !line.startsWith('---')
              ? 'del'
              : line.startsWith('@@')
                ? 'hunk'
                : '';
        return (
          <div key={i} className={cls}>
            {line || ' '}
          </div>
        );
      })}
    </pre>
  );
}

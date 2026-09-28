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
  return <span className="chip bad">⏸ {hold(ticket.hold.reason)}</span>;
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

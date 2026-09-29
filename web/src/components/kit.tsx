// 입력 도우미 부품: 세그먼트 버튼, 토글 칩, 폴더 찾아보기, CLI 상태·모델 목록 훅.
import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import { useT } from '../i18n.ts';
import { Icon, Modal } from './ui.tsx';

export function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string; hint?: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="segmented" role="radiogroup">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          className={value === o.value ? 'on' : ''}
          title={o.hint}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function ChipToggles({
  options,
  selected,
  onToggle,
}: {
  options: { value: string; label: string }[];
  selected: string[];
  onToggle: (v: string) => void;
}) {
  return (
    <div className="chip-toggles">
      {options.map((o) => {
        const on = selected.includes(o.value);
        return (
          <button
            key={o.value}
            type="button"
            className={`chip-toggle ${on ? 'on' : ''}`}
            aria-pressed={on}
            onClick={() => onToggle(o.value)}
          >
            {on && <Icon name="check" size={12} />} {o.label}
          </button>
        );
      })}
    </div>
  );
}

// ---- CLI 상태(로그인 여부) ----
export interface CliCheck {
  kind: string;
  displayName: string;
  found: boolean;
  version: string | null;
  login: 'ok' | 'missing' | 'unknown';
  loginHelp: string;
}
let doctorCache: Promise<{ clis: CliCheck[] }> | null = null;
export function useCliStatus(): CliCheck[] | null {
  const [clis, setClis] = useState<CliCheck[] | null>(null);
  useEffect(() => {
    doctorCache ??= api<{ clis: CliCheck[] }>('doctor').catch((e) => {
      doctorCache = null;
      throw e;
    });
    doctorCache.then((d) => setClis(d.clis)).catch(() => setClis([]));
  }, []);
  return clis;
}

// ---- 모델 목록 ----
export interface ModelOption {
  id: string;
  label: string;
  note?: string;
}
const modelCache = new Map<string, Promise<{ models: ModelOption[]; error?: string }>>();
export function useModels(cli: string): { models: ModelOption[]; loading: boolean; error?: string } {
  const [st, setSt] = useState<{ models: ModelOption[]; loading: boolean; error?: string }>({ models: [], loading: true });
  useEffect(() => {
    let live = true;
    setSt({ models: [], loading: true });
    if (!modelCache.has(cli))
      modelCache.set(
        cli,
        api<{ models: ModelOption[]; error?: string }>(`models?cli=${cli}`).catch((e) => {
          modelCache.delete(cli);
          return { models: [], error: String((e as Error).message) };
        }),
      );
    modelCache.get(cli)!.then((r) => live && setSt({ models: r.models, loading: false, error: r.error }));
    return () => {
      live = false;
    };
  }, [cli]);
  return st;
}

// ---- 폴더 찾아보기 ----
interface DirListing {
  path: string;
  parent: string | null;
  dirs: { name: string; isGit: boolean }[];
  roots: string[];
}

export function FolderPicker({ initial, onPick, onClose }: { initial: string; onPick: (p: string) => void; onClose: () => void }) {
  const { lang } = useT();
  const ko = lang === 'ko';
  const [cur, setCur] = useState<DirListing | null>(null);
  const [error, setError] = useState('');
  const load = (p: string): Promise<boolean> =>
    api<DirListing>(`dirs?path=${encodeURIComponent(p)}`)
      .then((d) => {
        setCur(d);
        setError('');
        return true;
      })
      .catch((e) => {
        setError(String((e as Error).message));
        return false;
      });
  useEffect(() => {
    // 받은 경로를 못 열면 드라이브(루트) 목록부터 보여 준다.
    void load(initial).then((ok) => {
      if (!ok && initial) void load('').then((ok2) => ok2 && setError(''));
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const sep = cur?.path.includes('\\') ? '\\' : '/';
  const join = (name: string) => (cur!.path.endsWith(sep) ? cur!.path + name : cur!.path + sep + name);

  return (
    <Modal
      title={ko ? '저장소 폴더 고르기' : 'Choose a repository folder'}
      onClose={onClose}
      actions={
        <button className="btn primary" disabled={!cur} onClick={() => cur && (onPick(cur.path), onClose())}>
          {ko ? '이 폴더 선택' : 'Use this folder'}
        </button>
      }
    >
      <div className="picker">
        <div className="row picker-bar">
          {cur?.roots.map((r) => (
            <button key={r} className="btn small" onClick={() => load(r)}>
              {r}
            </button>
          ))}
          <button className="btn small" disabled={!cur?.parent} onClick={() => cur?.parent && load(cur.parent)}>
            ↑ {ko ? '위로' : 'Up'}
          </button>
        </div>
        <div className="picker-path mono">{cur?.path ?? '…'}</div>
        {error && <div className="banner bad">{error}</div>}
        <div className="picker-list">
          {cur?.dirs.length === 0 && (
            <div className="sub" style={{ padding: 12 }}>
              {ko ? '하위 폴더가 없습니다.' : 'No subfolders.'}
            </div>
          )}
          {cur?.dirs.map((d) => (
            <button
              key={d.name}
              className={`picker-item ${d.isGit ? 'git' : ''}`}
              onDoubleClick={() => onPick(join(d.name))}
              onClick={() => load(join(d.name))}
            >
              <Icon name="folder" /> <span className="name">{d.name}</span>
              {d.isGit && <span className="chip ok">git</span>}
            </button>
          ))}
        </div>
        <div className="sub">
          {ko
            ? '폴더를 눌러 들어가고, git 표시가 있는 폴더를 두 번 누르면 바로 선택됩니다.'
            : 'Click to open a folder; double-click a git folder to choose it.'}
        </div>
      </div>
    </Modal>
  );
}

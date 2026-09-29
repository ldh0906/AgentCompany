// 입력 도우미 부품: 세그먼트 버튼, 토글 칩, 폴더 찾아보기, CLI 상태·모델 목록 훅.
import { useEffect, useRef, useState } from 'react';
import { api } from '../api.ts';
import { useT } from '../i18n.ts';
import { Icon, Modal } from './ui.tsx';

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  small = false,
}: {
  value: T;
  options: { value: T; label: string; hint?: string }[];
  onChange: (v: T) => void;
  small?: boolean;
}) {
  return (
    <div className={`segmented ${small ? 'small' : ''}`} role="radiogroup">
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
  efforts?: string[];
  defaultEffort?: string;
  effortRequired?: boolean;
}
type ModelList = { models: ModelOption[]; defaultModel?: string; error?: string };
const modelCache = new Map<string, Promise<ModelList>>();
export function useModels(cli: string): ModelList & { loading: boolean; forCli: string } {
  const [st, setSt] = useState<ModelList & { loading: boolean; forCli: string }>({ models: [], loading: true, forCli: cli });
  useEffect(() => {
    let live = true;
    setSt({ models: [], loading: true, forCli: cli });
    if (!modelCache.has(cli))
      modelCache.set(
        cli,
        api<ModelList>(`models?cli=${cli}`).catch((e) => {
          modelCache.delete(cli);
          return { models: [], error: String((e as Error).message) };
        }),
      );
    modelCache.get(cli)!.then((r) => live && setSt({ ...r, loading: false, forCli: cli }));
    return () => {
      live = false;
    };
  }, [cli]);
  return st;
}

/** 정확한 모델명 + effort 선택. 모델이 지원하는 effort만 보여 준다. */
export function ModelPicker({
  cli,
  model,
  effort,
  onChange,
  autoSelect = false,
}: {
  cli: string;
  model: string;
  effort: string;
  onChange: (model: string, effort: string) => void;
  /** 새로 고를 때: 목록이 오면 첫 모델과 그 모델의 기본 effort를 명시적으로 고른다. */
  autoSelect?: boolean;
}) {
  const { lang, effort: effortLabel } = useT();
  const ko = lang === 'ko';
  const { models, loading, error, defaultModel, forCli } = useModels(cli);
  const [custom, setCustom] = useState(false);
  const picked = useRef<string | null>(null);
  useEffect(() => {
    // 목록이 이 CLI의 것일 때만(바꾼 직후에는 이전 CLI 목록이 잠깐 남아 있다).
    if (!autoSelect || loading || forCli !== cli || !models.length || picked.current === cli) return;
    picked.current = cli;
    if (model === '') onChange(models[0]!.id, models[0]!.defaultEffort ?? '');
  }, [autoSelect, loading, models, cli, forCli, model]); // eslint-disable-line react-hooks/exhaustive-deps
  const known = models.find((m) => m.id === model);
  const isCustom = custom || (model !== '' && !known && !loading);
  // 기본값을 고르면 목록의 첫 모델(대개 CLI 기본 계열)의 effort를 보여 준다.
  const ref = model === '' ? models[0] : known;
  const efforts = ref?.efforts ?? [];
  const pickModel = (id: string) => {
    const next = models.find((m) => m.id === id);
    onChange(id, next?.efforts?.includes(effort) ? effort : next?.effortRequired ? (next.defaultEffort ?? next.efforts?.[0] ?? '') : '');
  };
  return (
    <div className="model-picker">
      {!isCustom ? (
        <select
          value={model}
          onChange={(e) => (e.target.value === '__custom' ? (setCustom(true), onChange('', '')) : pickModel(e.target.value))}
        >
          <option value="">
            {ko ? 'CLI 기본값' : 'CLI default'}
            {defaultModel ? ` — ${defaultModel}` : ''}
          </option>
          {loading && <option disabled>{ko ? '모델 목록 불러오는 중…' : 'Loading models…'}</option>}
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label === m.id ? m.id : `${m.label} — ${m.id}`}
            </option>
          ))}
          <option value="__custom">{ko ? '직접 입력…' : 'Type an exact model id…'}</option>
        </select>
      ) : (
        <div className="row">
          <input
            className="mono"
            value={model}
            onChange={(e) => onChange(e.target.value, effort)}
            placeholder="model-id"
            autoFocus
            style={{ flex: 1 }}
          />
          <button
            type="button"
            className="btn small"
            onClick={() => {
              setCustom(false);
              onChange('', '');
            }}
          >
            {ko ? '목록' : 'List'}
          </button>
        </div>
      )}
      {loading && <span className="hint">{ko ? 'CLI에서 모델 목록을 가져오는 중…' : 'Fetching the model list from the CLI…'}</span>}
      <div className="model-id mono">
        {ko ? '실행 모델: ' : 'Runs as: '}
        <b>{model ? (cli === 'agy' && effort ? `${model}-${effort}` : model) : (defaultModel ?? (ko ? 'CLI 설정값' : 'CLI setting'))}</b>
        {known?.note && <span className="sub"> · {known.note}</span>}
      </div>
      {efforts.length > 0 && (
        <div className="effort-row">
          <span className="field-label" style={{ margin: 0 }}>
            {ko ? '추론 강도 (effort)' : 'Reasoning effort'}
          </span>
          <Segmented
            value={effort}
            onChange={(v) => onChange(model, v)}
            options={[
              // agy 계열은 effort가 모델 ID의 일부라 "기본"이 없다.
              ...(ref?.effortRequired
                ? []
                : [
                    {
                      value: '',
                      label: ko
                        ? `기본${ref?.defaultEffort ? ` (${effortLabel(ref.defaultEffort)})` : ''}`
                        : `Default${ref?.defaultEffort ? ` (${ref.defaultEffort})` : ''}`,
                    },
                  ]),
              ...efforts.map((e) => ({ value: e, label: effortLabel(e) })),
            ]}
          />
        </div>
      )}
      {error && (
        <span className="hint bad-text">
          {ko ? '모델 목록을 가져오지 못했습니다. 기본값이나 직접 입력을 쓰세요.' : 'Could not load models; use the default or type one.'}
        </span>
      )}
      {cli === 'claude' && (
        <span className="hint">
          {ko
            ? 'Claude Code 2.1.202에서 별칭이 가리키는 정확한 모델명을 실측한 목록입니다.'
            : 'Exact names measured from Claude Code 2.1.202 aliases.'}
        </span>
      )}
    </div>
  );
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

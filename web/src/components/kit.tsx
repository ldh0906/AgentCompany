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
const cliListeners = new Set<(c: CliCheck[]) => void>();
function loadDoctor(refresh = false): Promise<{ clis: CliCheck[] }> {
  const p = api<{ clis: CliCheck[] }>(`doctor${refresh ? '?refresh=1' : ''}`).catch((e) => {
    doctorCache = null;
    throw e;
  });
  doctorCache = p;
  p.then((d) => cliListeners.forEach((f) => f(d.clis))).catch(() => {});
  return p;
}
export function useCliStatus(): CliCheck[] | null {
  const [clis, setClis] = useState<CliCheck[] | null>(null);
  useEffect(() => {
    cliListeners.add(setClis);
    (doctorCache ?? loadDoctor()).then((d) => setClis(d.clis)).catch(() => setClis([]));
    return () => void cliListeners.delete(setClis);
  }, []);
  return clis;
}

/**
 * AI 연결: CLI마다 상태와 "로그인 창 열기". 첫 사용 안내·기본 팀·시스템 화면이 같이 쓴다.
 * 실측(첫 사용): 새 회사에선 Claude·Codex가 로그인 필요였는데, 안내는 명령을 복사해 PowerShell에 붙이라는 것뿐이었다.
 */
export function CliConnect() {
  const clis = useCliStatus();
  const { lang } = useT();
  const ko = lang === 'ko';
  const [waiting, setWaiting] = useState<string | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!waiting) return;
    let n = 0;
    // 로그인이 끝나면 저절로 "준비됨"으로 바뀌게: 5초마다 다시 점검(최대 5분).
    const t = setInterval(() => {
      n++;
      void loadDoctor(true).then((d) => {
        if (d.clis.find((c) => c.kind === waiting)?.login === 'ok' || n >= 60) setWaiting(null);
      });
    }, 5000);
    return () => clearInterval(t);
  }, [waiting]);
  if (!clis) return <div className="sub">{ko ? 'AI 확인 중…' : 'Checking AIs…'}</div>;
  const open = (kind: string, poll: boolean) => {
    setError('');
    api('cli-login', { body: { cli: kind } })
      .then(() => poll && setWaiting(kind))
      .catch((e) => setError(String((e as Error).message)));
  };
  return (
    <div className="list">
      {clis.map((c) => (
        <div className="item spread" key={c.kind}>
          <span className="row">
            <b>{c.displayName}</b>
            {!c.found ? (
              <span className="chip">{ko ? '설치 안 됨' : 'Not installed'}</span>
            ) : c.login === 'ok' ? (
              <span className="chip ok">{ko ? '연결됨' : 'Connected'}</span>
            ) : c.login === 'missing' ? (
              <span className="chip warn">{ko ? '로그인 필요' : 'Login needed'}</span>
            ) : (
              <span className="chip">{ko ? '첫 업무 때 확인' : 'Checked on first run'}</span>
            )}
          </span>
          {c.found && c.login !== 'ok' && (
            <button className="btn small" disabled={waiting === c.kind} onClick={() => open(c.kind, c.login === 'missing')}>
              {waiting === c.kind ? (ko ? '로그인 기다리는 중…' : 'Waiting for login…') : ko ? '로그인 창 열기' : 'Open login window'}
            </button>
          )}
        </div>
      ))}
      {error && <div className="banner bad">{error}</div>}
      <div className="hint">
        {ko
          ? '로그인 창이 열리면 안내대로 브라우저에서 로그인한 뒤 창을 닫으세요. 이 회사 전용 로그인이라 평소 쓰는 로그인과 섞이지 않고, 앱은 로그인 정보를 읽지 않습니다.'
          : 'A login window opens; sign in in the browser, then close it. This login is separate from your usual one, and the app never reads it.'}
      </div>
    </div>
  );
}

// ---- 모델 목록 ----
export interface ModelOption {
  id: string;
  label: string;
  note?: string;
  efforts?: string[];
  defaultEffort?: string;
  effortRequired?: boolean;
  /** 설치된 CLI로는 쓸 수 없는 이유(예: 더 새 Claude Code 필요). 있으면 잠근다. */
  unavailable?: string;
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
    const first = models.find((m) => !m.unavailable);
    if (model === '' && first) onChange(first.id, first.defaultEffort ?? '');
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
            <option key={m.id} value={m.id} disabled={Boolean(m.unavailable)}>
              {m.label === m.id ? m.id : `${m.label} — ${m.id}`}
              {m.unavailable ? ` · ${ko ? '업데이트 필요' : 'update needed'}: ${m.unavailable}` : ''}
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
            ? `이 PC의 Claude Code로 모델마다 실제 호출해 확인한 목록입니다.${models.some((m) => m.unavailable) ? ' 잠긴 모델은 Claude Code를 업데이트(claude update)하면 쓸 수 있습니다.' : ''}`
            : `Verified by calling each model with this PC's Claude Code.${models.some((m) => m.unavailable) ? ' Locked models unlock after updating Claude Code (claude update).' : ''}`}
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
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
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
      title={ko ? '폴더 고르기' : 'Choose a repository folder'}
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
        <div className="picker-new">
          <div className="field-label">{ko ? '처음부터 시작하기' : 'Start from scratch'}</div>
          <div className="row">
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder={ko ? '새 프로젝트 폴더 이름 (예: my-game)' : 'New project folder name (e.g. my-game)'}
            />
            <button
              className="btn small"
              disabled={!cur || !newName.trim() || creating}
              onClick={() => {
                setCreating(true);
                api<{ path: string }>('repos', { body: { parent: cur!.path, name: newName.trim() } })
                  .then((r) => (onPick(r.path), onClose()))
                  .catch((e) => setError(String((e as Error).message)))
                  .finally(() => setCreating(false));
              }}
            >
              <Icon name="plus" size={13} /> {ko ? '여기에 새로 만들기' : 'Create here'}
            </button>
          </div>
          <div className="hint">
            {ko
              ? '지금 보고 있는 폴더 아래에 새 빈 폴더를 만들어 시작합니다(변경 기록은 앱이 알아서 남깁니다).'
              : 'Creates a new folder under the current one as an empty git repository.'}
          </div>
        </div>
      </div>
    </Modal>
  );
}

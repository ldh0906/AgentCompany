// 결과물 보기: 문서(.md)·표(.csv)·글·그림을 앱 안에서 읽기 좋게 보여 준다.
// 대표 요청(2026-10-01): 코드가 아닌 결과물도 "앱 안에서 바로 보기". 그전에는 업무 페이지의 diff 탭에서 원문 그대로만 보였다.
// 외부 라이브러리 없이 React 요소로 그린다(HTML을 그대로 넣지 않아 문서 속 스크립트가 실행될 일이 없다).
import { Fragment, useEffect, useState, type ReactNode } from 'react';
import { api, type DeliverableFile } from '../api.ts';
import { useT } from '../i18n.ts';
import { Modal } from './ui.tsx';

// ---------- 마크다운(자주 쓰는 문법만) ----------

// 순서: 코드 · 굵게 · 웹 링크 · 맨 주소 · 기울임 · 각주 표시 [^n] · 프로젝트 안 파일 링크 [이름](경로)
// 실측(2026-10-02, 카페 사업계획서): 각주 [^d1]과 [조사](research/x.md)가 글자 그대로 보였다.
const INLINE =
  /(`[^`]+`)|(\*\*[^*]+\*\*|__[^_]+__)|(\[[^\]]+\]\(https?:\/\/[^)\s]+\))|(https?:\/\/[^\s<>()\]]+[^\s<>()\].,;:!?'"])|(\*[^*\s][^*]*\*)|(\[\^[^\]\s]+\])|(\[[^\]]+\]\([^)\s]+\))/g;
const FOOTNOTE = /^\[\^([^\]\s]+)\]:\s*(.*)$/;

export function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index! > last) out.push(text.slice(last, m.index));
    const [tok] = m;
    const key = `${m.index}`;
    if (m[1]) out.push(<code key={key}>{tok.slice(1, -1)}</code>);
    else if (m[2]) out.push(<strong key={key}>{inline(tok.slice(2, -2))}</strong>);
    else if (m[3]) {
      const sep = tok.lastIndexOf('](');
      out.push(
        <a key={key} href={tok.slice(sep + 2, -1)} target="_blank" rel="noreferrer noopener">
          {inline(tok.slice(1, sep))}
        </a>,
      );
    } else if (m[4])
      out.push(
        <a key={key} href={tok} target="_blank" rel="noreferrer noopener">
          {tok}
        </a>,
      );
    else if (m[6])
      out.push(
        <sup key={key} className="fn">
          {tok.slice(2, -1)}
        </sup>,
      );
    else if (m[7]) {
      // 프로젝트 안 다른 파일: 이름만 보이고 경로는 마우스를 올리면(문서 보기에서 그 파일을 고르면 된다)
      const sep = tok.lastIndexOf('](');
      out.push(
        <span key={key} className="doc-ref" title={tok.slice(sep + 2, -1)}>
          {inline(tok.slice(1, sep))}
        </span>,
      );
    } else out.push(<em key={key}>{inline(tok.slice(1, -1))}</em>);
    last = m.index! + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const cells = (line: string) =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());
const isTableRule = (line: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);
const LIST = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

export function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const key = blocks.length;
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = line.match(/^\s*(```|~~~)/);
    if (fence) {
      const body: string[] = [];
      for (i++; i < lines.length && !lines[i]!.trim().startsWith(fence[1]!); i++) body.push(lines[i]!);
      i++;
      blocks.push(
        <pre key={key} className="code">
          {body.join('\n')}
        </pre>,
      );
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (h) {
      const level = Math.min(h[1]!.length + 1, 6);
      const Tag = `h${level}` as 'h2';
      blocks.push(<Tag key={key}>{inline(h[2]!)}</Tag>);
      i++;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      blocks.push(<hr key={key} />);
      i++;
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && isTableRule(lines[i + 1]!)) {
      const head = cells(line);
      const rows: string[][] = [];
      for (i += 2; i < lines.length && lines[i]!.includes('|') && lines[i]!.trim(); i++) rows.push(cells(lines[i]!));
      blocks.push(
        <div key={key} className="doc-table">
          <table>
            <thead>
              <tr>
                {head.map((c, j) => (
                  <th key={j}>{inline(c)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>
                  {head.map((_, j) => (
                    <td key={j}>{inline(r[j] ?? '')}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      for (; i < lines.length && /^\s*>/.test(lines[i]!); i++) body.push(lines[i]!.replace(/^\s*>\s?/, ''));
      blocks.push(
        <blockquote key={key}>
          <Markdown text={body.join('\n')} />
        </blockquote>,
      );
      continue;
    }
    if (LIST.test(line)) {
      const ordered = /\d/.test(line.match(LIST)![2]!);
      const items: { depth: number; text: string }[] = [];
      for (; i < lines.length; i++) {
        const m = lines[i]!.match(LIST);
        if (m) items.push({ depth: Math.floor(m[1]!.replace(/\t/g, '  ').length / 2), text: m[3]! });
        else if (lines[i]!.trim() && /^\s+/.test(lines[i]!) && items.length) items.at(-1)!.text += ` ${lines[i]!.trim()}`;
        else break;
      }
      const List = ordered ? 'ol' : 'ul';
      blocks.push(
        <List key={key}>
          {items.map((it, j) => (
            <li key={j} style={it.depth ? { marginLeft: it.depth * 18 } : undefined}>
              {inline(it.text)}
            </li>
          ))}
        </List>,
      );
      continue;
    }
    const fn = line.match(FOOTNOTE);
    if (fn) {
      blocks.push(
        <p key={key} className="footnote">
          <sup className="fn">{fn[1]}</sup> {inline(fn[2]!)}
        </p>,
      );
      i++;
      continue;
    }
    const para: string[] = [];
    const hard: boolean[] = []; // 이 줄 뒤에서 줄을 바꾸는가(줄 끝 공백 두 칸이나 역슬래시)
    for (
      ;
      i < lines.length &&
      lines[i]!.trim() &&
      !/^(#{1,6}\s|\s*```|\s*>)/.test(lines[i]!) &&
      !LIST.test(lines[i]!) &&
      !FOOTNOTE.test(lines[i]!);
      i++
    ) {
      if (para.length && lines[i]!.includes('|') && i + 1 < lines.length && isTableRule(lines[i + 1]!)) break;
      // 줄 끝 공백 두 칸이나 \ 는 줄바꿈 표시(표준 마크다운). 나머지 줄바꿈은 띄어쓰기로 잇는다.
      hard.push(/( {2,}|\\)$/.test(lines[i]!));
      para.push(lines[i]!.trim().replace(/\\$/, ''));
    }
    blocks.push(
      <p key={key}>
        {/* 실측(2026-10-02 QA): 폭에 맞춰 줄을 끊어 쓴 README가 "Python 표준 / 라이브러리"처럼 문장 중간에서 끊겨 보였다 */}
        {para.map((l, j) => (
          <Fragment key={j}>
            {j > 0 && (hard[j - 1] ? <br /> : ' ')}
            {inline(l)}
          </Fragment>
        ))}
      </p>,
    );
  }
  return <div className="doc">{blocks}</div>;
}

// ---------- 표(CSV/TSV) ----------

export function parseCsv(text: string, sep = ','): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') ((cell += '"'), i++);
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"' && !cell) quoted = true;
    else if (c === sep) (row.push(cell), (cell = ''));
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell || row.length) (row.push(cell), rows.push(row));
  return rows;
}

function CsvTable({ text, tsv }: { text: string; tsv: boolean }) {
  const { lang } = useT();
  const rows = parseCsv(text, tsv ? '\t' : ',').filter((r) => r.some((c) => c.trim()));
  if (!rows.length) return null;
  // 엑셀용 요약은 한 파일에 표 여러 개(제목 한 줄 + 머리글 + 줄들)를 담기도 한다: 가장 긴 줄 기준으로 칸을 그리고,
  // 한 칸짜리 줄은 소제목으로. 실측(2026-10-02, 가계부 summary.csv): 첫 줄이 제목 한 칸이라 숫자 칸이 전부 빠졌다.
  const cols = Math.max(...rows.map((r) => r.length));
  const MAX = 500;
  const isTitle = (r: string[]) => cols > 1 && r.filter((c) => c.trim()).length === 1 && r[0]!.trim() !== '';
  return (
    <div className="doc-table">
      <table>
        <tbody>
          {rows.slice(0, MAX).map((r, ri) =>
            isTitle(r) ? (
              <tr key={ri} className="csv-title">
                <th colSpan={cols}>{r[0]}</th>
              </tr>
            ) : (
              <tr key={ri} className={ri === 0 || isTitle(rows[ri - 1]!) ? 'csv-head' : ''}>
                {Array.from({ length: cols }, (_, j) => (
                  <td key={j}>{r[j] ?? ''}</td>
                ))}
              </tr>
            ),
          )}
        </tbody>
      </table>
      <div className="hint">
        {lang === 'ko'
          ? `${rows.length}줄${rows.length > MAX ? ` (앞 ${MAX}줄만 표시)` : ''}`
          : `${rows.length} rows${rows.length > MAX ? ` (first ${MAX} shown)` : ''}`}
      </div>
    </div>
  );
}

// ---------- 바뀐 부분(줄 단위) ----------

/** 줄 단위 차이(LCS). 너무 크면 null. */
export function lineDiff(before: string, after: string): { op: ' ' | '+' | '-'; text: string }[] | null {
  const a = before.replace(/\r\n?/g, '\n').split('\n');
  const b = after.replace(/\r\n?/g, '\n').split('\n');
  if (a.length * b.length > 4_000_000) return null;
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const out: { op: ' ' | '+' | '-'; text: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) (out.push({ op: ' ', text: a[i++]! }), j++);
    else if (j < m && (i >= n || dp[i]![j + 1]! >= dp[i + 1]![j]!)) out.push({ op: '+', text: b[j++]! });
    else out.push({ op: '-', text: a[i++]! });
  }
  return out;
}

function Changes({ before, after }: { before: string; after: string }) {
  const { lang } = useT();
  const d = lineDiff(before, after);
  if (!d)
    return <div className="hint">{lang === 'ko' ? '파일이 너무 커서 바뀐 부분을 계산하지 못했습니다.' : 'Too large to compare.'}</div>;
  // 바뀐 줄 앞뒤 두 줄만 보이고 나머지는 접는다.
  const keep = d.map((x, k) => d.slice(Math.max(0, k - 2), k + 3).some((y) => y.op !== ' '));
  const out: ReactNode[] = [];
  d.forEach((x, k) => {
    if (keep[k]) out.push(<div key={k} className={x.op === '+' ? 'add' : x.op === '-' ? 'del' : ''}>{`${x.op} ${x.text}`}</div>);
    else if (k === 0 || keep[k - 1])
      out.push(
        <div key={k} className="hunk">
          ⋯
        </div>,
      );
  });
  if (!d.some((x) => x.op !== ' ')) return <div className="hint">{lang === 'ko' ? '바뀐 내용이 없습니다.' : 'No changes.'}</div>;
  return <pre className="code diff doc-changes">{out}</pre>;
}

// ---------- 결과물 보기 ----------

const STATUS_KO = { added: '새 파일', modified: '수정됨', deleted: '삭제됨' };
const STATUS_EN = { added: 'New', modified: 'Changed', deleted: 'Deleted' };

export function FileBody({ f, changesOnly }: { f: DeliverableFile; changesOnly: boolean }) {
  const { lang } = useT();
  if (f.status === 'deleted') return <div className="hint">{lang === 'ko' ? '이 파일은 삭제됩니다.' : 'This file is deleted.'}</div>;
  if (f.kind === 'image')
    return f.dataUrl ? (
      <img className="doc-image" src={f.dataUrl} alt={f.path} />
    ) : (
      <div className="hint">{lang === 'ko' ? '그림이 너무 커서 보여 줄 수 없습니다.' : 'Image too large to show.'}</div>
    );
  const text = f.text ?? '';
  if (changesOnly && f.before !== undefined) return <Changes before={f.before} after={text} />;
  if (f.kind === 'markdown') return <Markdown text={text} />;
  if (f.kind === 'table') return <CsvTable text={text} tsv={f.path.toLowerCase().endsWith('.tsv')} />;
  return <pre className="code doc-text">{text}</pre>;
}

/**
 * 업무 제출물의 문서·표·그림. 읽을 파일이 없으면 아무것도 그리지 않는다.
 * open: 처음부터 펼침(문서 프로젝트). version이 바뀌면(새 제출) 다시 읽는다.
 */
export function DeliverableView({
  ticketId,
  open: initiallyOpen = false,
  version,
}: {
  ticketId: string;
  open?: boolean;
  version?: string;
}) {
  const { lang } = useT();
  const ko = lang === 'ko';
  const [files, setFiles] = useState<DeliverableFile[] | null>(null);
  const [open, setOpen] = useState(initiallyOpen);
  const [sel, setSel] = useState(0);
  const [changesOnly, setChangesOnly] = useState(false);
  useEffect(() => {
    api<{ files: DeliverableFile[] }>(`tickets/${ticketId}/files`)
      .then((r) => setFiles(r.files))
      .catch(() => setFiles([]));
  }, [ticketId, version]);
  if (!files?.length) return null;
  const f = files[Math.min(sel, files.length - 1)]!;
  const docs = files.filter((x) => x.kind !== 'image').length;
  const label = ko
    ? `📄 결과물 보기 (${[docs && `문서·표 ${docs}개`, files.length - docs && `그림 ${files.length - docs}개`].filter(Boolean).join(', ')})`
    : `📄 View results (${files.length} files)`;
  if (!open)
    return (
      <button className="btn small" onClick={() => setOpen(true)}>
        {label}
      </button>
    );
  return (
    <div className="deliverables">
      <div className="spread">
        <b>{ko ? '결과물' : 'Results'}</b>
        <button className="btn small" onClick={() => setOpen(false)}>
          {ko ? '접기' : 'Collapse'}
        </button>
      </div>
      {files.length > 1 && (
        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          {files.map((x, k) => (
            <button key={x.path} className={`btn small ${k === sel ? 'on' : ''}`} onClick={() => (setSel(k), setChangesOnly(false))}>
              {x.path.split('/').pop()}
            </button>
          ))}
        </div>
      )}
      <div className="spread">
        <span className="sub mono">
          {f.path} · {(ko ? STATUS_KO : STATUS_EN)[f.status]}
          {f.truncated ? (ko ? ' · 앞부분만 표시' : ' · truncated') : ''}
        </span>
        {f.before !== undefined && (
          <button className={`btn small ${changesOnly ? 'on' : ''}`} onClick={() => setChangesOnly(!changesOnly)}>
            {ko ? '바뀐 부분만' : 'Changes only'}
          </button>
        )}
      </div>
      <div className="doc-scroll">
        <FileBody f={f} changesOnly={changesOnly} />
      </div>
    </div>
  );
}

/** 프로젝트 문서 보기(문서·프로그램 프로젝트의 "실행해 보기" 대신): 내 폴더의 최신 문서를 앱 안에서 읽는다. */
export function ProjectDocsButton({ projectId }: { projectId: string }) {
  const { lang } = useT();
  const ko = lang === 'ko';
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<{ path: string; kind: DeliverableFile['kind'] }[] | null>(null);
  const [file, setFile] = useState<DeliverableFile | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const pick = (p: string, sha: string) => {
    setLoading(true);
    return api<{ file: DeliverableFile }>(`projects/${projectId}/docs?path=${encodeURIComponent(p)}&sha=${sha}`)
      .then((r) => (setFile(r.file), setError('')))
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  };
  const [sha, setSha] = useState('');
  useEffect(() => {
    if (!open) return;
    setLoading(true);
    api<{ sha: string; files: { path: string; kind: DeliverableFile['kind'] }[] }>(`projects/${projectId}/docs`)
      .then((r) => {
        setList(r.files);
        setSha(r.sha);
        if (r.files[0]) void pick(r.files[0].path, r.sha);
        else setLoading(false);
      })
      .catch((e: Error) => (setError(e.message), setLoading(false)));
  }, [open, projectId]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      <button
        className="btn small"
        onClick={() => setOpen(true)}
        title={ko ? '내 폴더의 최신 문서·표·그림' : 'Latest documents in your folder'}
      >
        📄 {ko ? '문서 보기' : 'View documents'}
      </button>
      {open && (
        <Modal title={ko ? '문서 보기' : 'Documents'} onClose={() => setOpen(false)} wide>
          {error && <div className="banner warn">{error}</div>}
          {loading && !file && <div className="hint">{ko ? '내 폴더의 최신 문서를 불러오는 중…' : 'Loading the latest documents…'}</div>}
          {list && !list.length && (
            <div className="hint">{ko ? '아직 문서가 없습니다. 업무가 승인되어 반영되면 여기에 보입니다.' : 'No documents yet.'}</div>
          )}
          {list && list.length > 1 && (
            <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
              {list.map((x) => (
                <button key={x.path} className={`btn small ${file?.path === x.path ? 'on' : ''}`} onClick={() => void pick(x.path, sha)}>
                  {x.path}
                </button>
              ))}
            </div>
          )}
          {file && (
            <div className="doc-scroll">
              <FileBody f={file} changesOnly={false} />
            </div>
          )}
        </Modal>
      )}
    </>
  );
}

/**
 * 확인용 실행이 만든 파일(화면 없는 프로그램): 표·문서·그림을 앱 안에서 보고, CSV는 엑셀 한글 판정을 함께 보여 준다.
 * 실측(2026-10-02, 가계부): 요약 CSV가 앱 내부 임시 폴더에만 있어 대표가 열어 볼 수 없었다.
 */
export function DemoFilesView({ files }: { files: (DeliverableFile & { verdict?: string })[] }) {
  const { lang } = useT();
  const ko = lang === 'ko';
  const [sel, setSel] = useState(0);
  if (!files.length) return null;
  const f = files[Math.min(sel, files.length - 1)]!;
  return (
    <div className="deliverables">
      <b>{ko ? '확인용 실행이 만든 파일' : 'Files the demo created'}</b>
      {files.length > 1 && (
        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          {files.map((x, k) => (
            <button key={x.path} className={`btn small ${k === sel ? 'on' : ''}`} onClick={() => setSel(k)}>
              {x.path.split('/').pop()}
            </button>
          ))}
        </div>
      )}
      <span className="sub mono">{f.path}</span>
      {f.verdict && <div className={`hint ${f.verdict.startsWith('⚠') ? 'bad-text' : 'ok-text'}`}>{f.verdict}</div>}
      <div className="doc-scroll">
        <FileBody f={f} changesOnly={false} />
      </div>
    </div>
  );
}

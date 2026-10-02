// 결과물 보기: 제출물에서 바뀐 문서·표·그림을 대표가 앱 안에서 읽을 수 있게 꺼낸다.
// 대표 요청(2026-10-01): 문서·조사 결과를 "앱 안에서 바로 보기". 그전에는 업무 페이지의 코드 diff 탭에서만 보였다.
import path from 'node:path';
import { git, gitShowBytes } from '../workspace/git.ts';

export type DeliverableFileKind = 'markdown' | 'text' | 'table' | 'image';

export interface DeliverableFile {
  path: string;
  kind: DeliverableFileKind;
  /** 기준 커밋에 없던 파일이면 added */
  status: 'added' | 'modified' | 'deleted';
  /** 제출본 내용(글자 파일) */
  text?: string;
  /** 바뀌기 전 내용(수정된 글자 파일만): "바뀐 부분" 보기용 */
  before?: string;
  /** 그림: data: 주소 */
  dataUrl?: string;
  truncated?: boolean;
}

const KINDS: Record<string, DeliverableFileKind> = {
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.txt': 'text',
  '.csv': 'table',
  '.tsv': 'table',
  '.png': 'image',
  '.jpg': 'image',
  '.jpeg': 'image',
  '.gif': 'image',
  '.webp': 'image',
};
const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};
const MAX_TEXT = 300_000;
const MAX_IMAGE = 4 * 1024 * 1024;
const MAX_FILES = 20;

export const deliverableKindOf = (file: string): DeliverableFileKind | null => KINDS[path.extname(file).toLowerCase()] ?? null;

/** 읽을 만한 파일 먼저(문서 → 표 → 글 → 그림), 같은 종류는 경로 순. */
const ORDER: DeliverableFileKind[] = ['markdown', 'table', 'text', 'image'];

function decode(buf: Buffer): { text: string; truncated: boolean } {
  const cut = buf.length > MAX_TEXT;
  // UTF-8 BOM(엑셀용 CSV)은 보기에서 뺀다.
  let text = buf.subarray(0, MAX_TEXT).toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return { text, truncated: cut };
}

/** 커밋 속 파일 하나를 보기용으로 읽는다(그림은 data: 주소). */
async function readAt(
  repo: string,
  sha: string,
  p: string,
  kind: DeliverableFileKind,
): Promise<Pick<DeliverableFile, 'text' | 'dataUrl' | 'truncated'> | null> {
  const buf = await gitShowBytes(repo, sha, p);
  return buf ? viewOf(p, kind, buf) : null;
}

/** 파일 내용을 보기용으로(그림은 data: 주소, 글은 앞부분). 확인용 실행이 만든 파일에도 쓴다. */
export function viewOf(p: string, kind: DeliverableFileKind, buf: Buffer): Pick<DeliverableFile, 'text' | 'dataUrl' | 'truncated'> {
  if (kind === 'image')
    return buf.length > MAX_IMAGE
      ? { truncated: true }
      : { dataUrl: `data:${IMAGE_MIME[path.extname(p).toLowerCase()]!};base64,${buf.toString('base64')}` };
  const d = decode(buf);
  return { text: d.text, ...(d.truncated ? { truncated: true } : {}) };
}

/**
 * 프로젝트 문서 보기(문서·프로그램 프로젝트의 "실행해 보기" 대신): 기준 브랜치에 있는 읽을 파일 목록.
 * 이름순이 아니라 읽을 만한 것(문서 → 표 → 글 → 그림) 먼저.
 */
export async function projectDocList(repo: string, sha: string): Promise<{ path: string; kind: DeliverableFileKind }[]> {
  const r = await git(['ls-tree', '-r', '--name-only', sha], repo, { allowFail: true });
  return (
    r.stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map((p) => ({ path: p, kind: deliverableKindOf(p) }))
      .filter((x): x is { path: string; kind: DeliverableFileKind } => x.kind !== null)
      // 얕은 곳 먼저(맨 위 README가 안쪽 폴더 README보다 먼저 열리게. 실측 2026-10-02 QA: bakery/core/README.md가 먼저 열렸다)
      .sort(
        (a, b) =>
          ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind) ||
          a.path.split('/').length - b.path.split('/').length ||
          a.path.localeCompare(b.path),
      )
      .slice(0, 200)
  );
}

export async function projectDoc(repo: string, sha: string, p: string): Promise<DeliverableFile | null> {
  const kind = deliverableKindOf(p);
  if (!kind) return null;
  const got = await readAt(repo, sha, p, kind);
  return got ? { path: p, kind, status: 'added', ...got } : null;
}

export async function deliverableFiles(repo: string, baseSha: string, headSha: string, changedPaths: string[]): Promise<DeliverableFile[]> {
  const picked = changedPaths
    .map((p) => ({ p, kind: deliverableKindOf(p) }))
    .filter((x): x is { p: string; kind: DeliverableFileKind } => x.kind !== null)
    .sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind) || a.p.localeCompare(b.p))
    .slice(0, MAX_FILES);
  const out: DeliverableFile[] = [];
  for (const { p, kind } of picked) {
    const after = await readAt(repo, headSha, p, kind);
    const before = await readAt(repo, baseSha, p, kind);
    const status = !after ? 'deleted' : before ? 'modified' : 'added';
    out.push({
      path: p,
      kind,
      status,
      ...after,
      ...(status === 'modified' && before?.text !== undefined ? { before: before.text } : {}),
    });
  }
  return out;
}

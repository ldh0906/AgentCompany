// 작업 중간 보고: 직원이 일하는 동안 업무방에 몇 분마다 진행 상황을 올린다.
// 대표 요청(2026-10-03): "애들이 작업중에 업무방에 중간중간 보고를 했으면 좋겠네".
// CLI는 실행 중에 대화방에 글을 쓸 수 없어서, 앱이 실행 기록(직원이 남긴 말·고친 파일·실행한 명령)을 읽어 대신 요약한다(AI 비용 없음).
import { tr } from '../core/i18n.ts';
import type { ActivityItem } from './activity.ts';

/** 중간 보고 간격 */
export const PROGRESS_MS = 5 * 60_000;

const FILE_TOOLS = /^(Write|Edit|MultiEdit|NotebookEdit|apply_patch|write_file|replace|edit_file)\b/i;

/**
 * 지난 보고 뒤의 기록을 한 줄 보고로. 새로 한 일이 없으면 null.
 * 직원이 남긴 마지막 말(무엇을 하는 중인지) + 고친 파일 + 실행한 명령 수.
 */
export function progressLine(items: ActivityItem[], minutes: number): string | null {
  if (!items.length) return null;
  const said = items
    .filter((i) => i.kind === 'say')
    .at(-1)
    ?.text.replace(/\s+/g, ' ')
    .trim();
  const files = new Set<string>();
  for (const i of items) {
    // Codex: "update C:\…\a.ts, add src/b.ts"(종류 + 경로, 쉼표로 여러 개)
    if (i.kind === 'file') for (const c of i.text.split(', ')) files.add(c.replace(/^\S+\s+/, '').trim());
    else if (i.kind === 'tool' && FILE_TOOLS.test(i.text)) files.add(i.text.replace(/^[^:]*:\s*/, '').trim());
  }
  const commands = items.filter((i) => i.kind === 'command' || (i.kind === 'tool' && /^(Bash|PowerShell|shell)\b/i.test(i.text))).length;
  if (!said && !files.size && !commands) return null;
  const names = [...files].filter(Boolean).map((f) => f.split(/[\\/]/).slice(-2).join('/'));
  const parts = [
    said ? (said.length > 240 ? `${said.slice(0, 240)}…` : said) : null,
    names.length
      ? tr(
          `고친 파일 ${names.length}개: ${names.slice(0, 5).join(', ')}${names.length > 5 ? ' 외' : ''}`,
          `${names.length} file(s) changed: ${names.slice(0, 5).join(', ')}${names.length > 5 ? ' …' : ''}`,
        )
      : null,
    commands ? tr(`명령 ${commands}번 실행`, `${commands} command(s) run`) : null,
  ].filter(Boolean);
  return tr(`⏳ 진행 상황 (${minutes}분째): ${parts.join(' · ')}`, `⏳ Progress (${minutes} min): ${parts.join(' · ')}`);
}

// 터미널 글자 다루기: 한글·이모지는 두 칸이라 길이 대신 화면 폭으로 자르고 채운다. 색은 NO_COLOR면 끈다.

const WIDE: [number, number][] = [
  [0x1100, 0x115f],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe4f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f],
  [0x1f900, 0x1f9ff],
  [0x20000, 0x3fffd],
];

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

export function charWidth(cp: number): number {
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (cp >= 0x300 && cp <= 0x36f) return 0; // 결합 문자
  if (cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f)) return 0;
  for (const [a, b] of WIDE) if (cp >= a && cp <= b) return 2;
  return 1;
}

/** 화면 폭(색 코드는 0칸) */
export function width(s: string): number {
  let w = 0;
  for (const ch of s.replace(ANSI, '')) w += charWidth(ch.codePointAt(0)!);
  return w;
}

/** 화면 폭 n칸에 맞게 자른다(넘치면 …). 색 코드는 보존하고 끝에 색을 되돌린다. */
export function fit(s: string, n: number): string {
  if (n <= 0) return '';
  if (width(s) <= n) return s;
  let out = '';
  let w = 0;
  let i = 0;
  while (i < s.length) {
    const m = /^\x1b\[[0-9;?]*[A-Za-z]/.exec(s.slice(i));
    if (m) {
      out += m[0];
      i += m[0].length;
      continue;
    }
    const ch = String.fromCodePoint(s.codePointAt(i)!);
    const cw = charWidth(ch.codePointAt(0)!);
    if (w + cw > n - 1) break;
    out += ch;
    w += cw;
    i += ch.length;
  }
  return `${out}…${s.includes('\x1b[') ? RESET : ''}`;
}

/** n칸이 되도록 자르고 오른쪽을 공백으로 채운다. */
export function pad(s: string, n: number): string {
  const f = fit(s, n);
  return f + ' '.repeat(Math.max(0, n - width(f)));
}

const on = () => !process.env.NO_COLOR && (Boolean(process.stdout.isTTY) || Boolean(process.env.FORCE_COLOR));
const code = (c: string) => (s: string) => (on() ? `\x1b[${c}m${s}\x1b[0m` : s);
export const RESET = '\x1b[0m';
export const c = {
  dim: code('2'),
  bold: code('1'),
  red: code('31'),
  green: code('32'),
  yellow: code('33'),
  blue: code('34'),
  magenta: code('35'),
  cyan: code('36'),
  gray: code('90'),
  inverse: code('7'),
};

/** 표: 열마다 가장 넓은 칸에 맞춘다(마지막 열은 남은 폭까지). */
export function table(rows: string[][], maxWidth = process.stdout.columns || 100): string {
  if (!rows.length) return '';
  const cols = Math.max(...rows.map((r) => r.length));
  const w = Array.from({ length: cols }, (_, i) => Math.max(...rows.map((r) => width(r[i] ?? ''))));
  const fixed = w.slice(0, -1).reduce((a, b) => a + b + 2, 0);
  w[cols - 1] = Math.max(8, Math.min(w[cols - 1]!, maxWidth - fixed));
  return rows.map((r) => r.map((x, i) => (i === cols - 1 ? fit(x, w[i]!) : pad(x, w[i]!))).join('  ')).join('\n');
}

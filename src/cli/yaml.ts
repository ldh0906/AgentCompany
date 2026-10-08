// 팀 파일용 작은 YAML: 런타임 의존성 없이 필요한 만큼만 읽고 쓴다.
// 지원: 들여쓰기 맵, "- " 목록(값 또는 맵), [a, b] 한 줄 목록, 따옴표 문자열, 숫자, true/false/null, # 주석.
// 지원하지 않는 것(앵커, 여러 줄 문자열 |, >, 문서 구분 ---)은 줄 번호와 함께 오류를 낸다.

export type Yaml = string | number | boolean | null | Yaml[] | { [k: string]: Yaml };

interface Line {
  no: number;
  indent: number;
  text: string;
}

export function parseYaml(src: string): Yaml {
  const lines: Line[] = [];
  for (const [i, raw] of src.split(/\r?\n/).entries()) {
    const text = stripComment(raw).trimEnd();
    if (!text.trim()) continue;
    if (/^\s*(---|\.\.\.)\s*$/.test(text) || /[|>][-+]?\s*$/.test(text.replace(/"[^"]*"|'[^']*'/g, '')))
      throw new Error(`YAML ${i + 1}: unsupported syntax`);
    if (/^\s*\t/.test(raw)) throw new Error(`YAML ${i + 1}: use spaces, not tabs`);
    lines.push({ no: i + 1, indent: text.length - text.trimStart().length, text: text.trim() });
  }
  if (!lines.length) return null;
  const [value, next] = block(lines, 0, lines[0]!.indent);
  if (next < lines.length) throw new Error(`YAML ${lines[next]!.no}: unexpected indentation`);
  return value;
}

function stripComment(s: string): string {
  let q: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (q) {
      if (c === q) q = null;
    } else if (c === '"' || c === "'") q = c;
    else if (c === '#' && (i === 0 || /\s/.test(s[i - 1]!))) return s.slice(0, i);
  }
  return s;
}

/** lines[i]부터 같은 들여쓰기의 블록(맵 또는 목록)을 읽는다. [값, 다음 줄 번호] */
function block(lines: Line[], i: number, indent: number): [Yaml, number] {
  if (lines[i]!.text.startsWith('- ') || lines[i]!.text === '-') {
    const out: Yaml[] = [];
    while (i < lines.length && lines[i]!.indent === indent && (lines[i]!.text.startsWith('- ') || lines[i]!.text === '-')) {
      const rest = lines[i]!.text.slice(1).trim();
      if (!rest) {
        const [v, n] = i + 1 < lines.length && lines[i + 1]!.indent > indent ? block(lines, i + 1, lines[i + 1]!.indent) : [null, i + 1];
        out.push(v);
        i = n;
      } else if (keyOf(rest)) {
        // "- key: value" 다음 줄들이 같은 맵의 나머지(대시 뒤 칸에 맞춘 들여쓰기)
        const inner = indent + (lines[i]!.text.length - rest.length);
        const virtual: Line[] = [{ no: lines[i]!.no, indent: inner, text: rest }];
        let j = i + 1;
        while (j < lines.length && lines[j]!.indent > indent) virtual.push(lines[j++]!);
        const [v, n] = block(virtual, 0, inner);
        if (n < virtual.length) throw new Error(`YAML ${virtual[n]!.no}: unexpected indentation`);
        out.push(v);
        i = j;
      } else {
        out.push(scalar(rest, lines[i]!.no));
        i++;
      }
    }
    return [out, i];
  }
  const out: { [k: string]: Yaml } = {};
  while (i < lines.length && lines[i]!.indent === indent) {
    const kv = keyOf(lines[i]!.text);
    if (!kv) throw new Error(`YAML ${lines[i]!.no}: expected "key: value"`);
    if (kv.rest) {
      out[kv.key] = scalar(kv.rest, lines[i]!.no);
      i++;
    } else if (i + 1 < lines.length && lines[i + 1]!.indent > indent) {
      const [v, n] = block(lines, i + 1, lines[i + 1]!.indent);
      out[kv.key] = v;
      i = n;
    } else if (i + 1 < lines.length && lines[i + 1]!.indent === indent && lines[i + 1]!.text.startsWith('- ')) {
      // 흔한 쓰기: 키와 같은 칸에서 시작하는 목록
      const [v, n] = block(lines, i + 1, indent);
      out[kv.key] = v;
      i = n;
    } else {
      out[kv.key] = null;
      i++;
    }
  }
  return [out, i];
}

function keyOf(text: string): { key: string; rest: string } | null {
  const m = /^("[^"]*"|'[^']*'|[^\s"'[\]{}:#][^:#]*?)\s*:(?:\s+(.*))?$/.exec(text);
  if (!m) return null;
  return { key: unquote(m[1]!), rest: (m[2] ?? '').trim() };
}

function unquote(s: string): string {
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) return JSON.parse(s) as string;
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1).replaceAll("''", "'");
  return s;
}

function scalar(s: string, no: number): Yaml {
  if (s.startsWith('[')) {
    if (!s.endsWith(']')) throw new Error(`YAML ${no}: unclosed [`);
    const body = s.slice(1, -1).trim();
    if (!body) return [];
    return splitFlow(body).map((x) => scalar(x.trim(), no));
  }
  if (s.startsWith('{')) throw new Error(`YAML ${no}: inline maps are not supported`);
  if (/^["']/.test(s)) return unquote(s);
  if (s === 'true' || s === 'false') return s === 'true';
  if (s === 'null' || s === '~') return null;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return s;
}

function splitFlow(body: string): string[] {
  const out: string[] = [];
  let q: string | null = null;
  let cur = '';
  for (const c of body) {
    if (q) {
      if (c === q) q = null;
    } else if (c === '"' || c === "'") q = c;
    else if (c === ',') {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out;
}

/** 팀 파일을 사람이 읽기 좋은 YAML로 쓴다(parseYaml로 다시 읽힌다). */
export function toYaml(v: Yaml, indent = 0): string {
  const pad = ' '.repeat(indent);
  if (Array.isArray(v)) {
    if (v.every((x) => x === null || typeof x !== 'object')) return `[${v.map(inline).join(', ')}]`;
    return v
      .map((x) => {
        if (x && typeof x === 'object' && !Array.isArray(x)) {
          const body = toYaml(x, indent + 2);
          return `${pad}- ${body.trimStart()}`;
        }
        return `${pad}- ${inline(x)}`;
      })
      .join('\n');
  }
  if (v && typeof v === 'object')
    return Object.entries(v)
      .map(([k, x]) =>
        x && typeof x === 'object' && !(Array.isArray(x) && x.every((y) => y === null || typeof y !== 'object'))
          ? `${pad}${k}:\n${toYaml(x, indent + 2)}`
          : `${pad}${k}: ${Array.isArray(x) ? toYaml(x) : inline(x)}`,
      )
      .join('\n');
  return inline(v);
}

function inline(x: Yaml): string {
  if (typeof x === 'string')
    return /^[\p{L}\p{N}_./@-][\p{L}\p{N}_ ./@()-]*$/u.test(x) && !/^(true|false|null|~|-?\d)/.test(x) && !x.endsWith(' ')
      ? x
      : JSON.stringify(x);
  return JSON.stringify(x);
}

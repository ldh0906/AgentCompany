// 비밀값 가리기: 직원 실행 로그·작업 기록을 화면으로 내보내기 전에 알려진 비밀값 모양을 [가림]으로 바꾼다.
// 직원이 환경 변수·설정 파일을 출력하면 키가 로그에 그대로 남고, 대표가 로그를 복사해 공유할 때 함께 나갔다.
// OpenRig 비교(2026-10-08, transcript-redaction): 응답을 만들기 전에 가린다. 정규식이라 모든 비밀값을 잡지는 못한다.
// git SHA(16진수 40자)·base64 사진은 가리지 않는다(로그에서 SHA를 읽어야 하고, 사진은 따로 줄인다).

export const REDACTED = '[REDACTED]';

const PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}/g, // Anthropic·OpenAI
  /\bgh[pousr]_[A-Za-z0-9_]{20,}/g, // GitHub
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS 접근 키
  /\bAIza[0-9A-Za-z_-]{35}/g, // Google API
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWT
  /\bnpm_[A-Za-z0-9]{20,}/g, // npm 접근 토큰
];
// 이름이 비밀값인 설정: 값만 가린다(api_key=…, "password": "…", .npmrc의 :_authToken=…). 숫자만인 값(토큰 수 등)은 두고, 글자가 섞인 8자 이상만.
const NAMED =
  /(?<![A-Za-z0-9])((?:_?[A-Za-z0-9]+_)*_?(?:api[_-]?key|secret(?:[_-]?key)?|access[_-]?token|auth[_-]?token|token|password|passwd|client[_-]?secret)\b["']?\s*[:=]\s*["']?)(?=[^\s"',;]*[A-Za-z])[^\s"',;]{8,}/gi;
const BEARER = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/g;
// Authorization 헤더 값(Basic·Token 등 방식 무관), URL에 넣은 비밀번호(postgres://user:비밀번호@host)
const AUTH_HEADER = /\b(Authorization["']?\s*[:=]\s*["']?(?:(?:Basic|Bearer|Token|Digest)\s+)?)[A-Za-z0-9._~+/=-]{8,}/gi;
const URL_PASSWORD = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@"']+:)[^\s@/"']+(@)/gi;

/** 문자열에서 비밀값을 가린다. known: 정확히 아는 비밀값(이 데몬의 접속 토큰 등) */
export function redact(text: string, known: string[] = []): string {
  let out = text;
  for (const k of known) if (k.length >= 8) out = out.split(k).join(REDACTED);
  for (const p of PATTERNS) out = out.replace(p, REDACTED);
  return out
    .replace(NAMED, `$1${REDACTED}`)
    .replace(AUTH_HEADER, `$1${REDACTED}`)
    .replace(BEARER, `$1${REDACTED}`)
    .replace(URL_PASSWORD, `$1${REDACTED}$2`);
}

/** JSON 값 안의 모든 문자열을 가린다(보고서·작업 기록 항목처럼 구조가 있는 응답) */
export function redactDeep<T>(value: T, known: string[] = []): T {
  if (typeof value === 'string') return redact(value, known) as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, known)) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v, known)])) as T;
  return value;
}

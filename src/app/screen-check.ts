// 자동 화면 점검: 대표 직접 확인 요구가 있는 업무가 승인 대기에 오면, 앱이 결과물을 띄워
// 보이지 않는 크롬(headless)으로 열고, 몇 가지 흔한 조작(클릭·Enter·방향키·스페이스)을 해 본 뒤 화면을 찍는다.
// 실측(2026-09-30): 대표가 매번 터미널·브라우저를 열어 "캔버스가 뜨는지"부터 확인해야 했다. 기계가 먼저 보고,
// QA 직원이 사진을 읽어 요구사항마다 의견을 달면 대표는 사진과 의견을 보고 체크만 하면 된다.
// - 창을 띄우지 않는다(headless). Edge는 쓰지 않는다: 크롬만 찾는다(AC_CHROME로 직접 지정 가능).
// - 외부 라이브러리 없이 크롬 개발자 프로토콜(CDP)을 Node 내장 WebSocket으로 쓴다.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ScreenScenario } from '../agents/report.ts';

/** 사진 상한: 전체와 확인 순서 하나당. 실측(2026-09-30): 전체 12장이 앞 순서에서 다 쓰여 뒤 요구사항(R4)이 한 장도 못 찍혔다. */
const MAX_SHOTS = 24;
export const MAX_SHOTS_PER_SCENARIO = 5;
export const SCENARIO_MIN_MS = 90_000;
/** 녹화: 초당 몇 장, 조작 뒤 최대 몇 ms 더 찍는지, 순서 하나에 최대 몇 장 */
const CLIP_FPS = 4;
const CLIP_SETTLE_MAX_MS = 3000;
const CLIP_MAX_FRAMES = 40;
const CLIP_SCALE = 480 / 1280;

export interface ScreenClip {
  /** 요구사항 ID(어느 확인 순서의 움직임인지) */
  label: string;
  fps: number;
  frames: string[];
}

export interface ScreenShot {
  label: string;
  file: string;
}

export interface ScreenCapture {
  shots: ScreenShot[];
  /** 콘솔 오류·잡히지 않은 예외(앞 20개) */
  errors: string[];
  /** 첫 화면의 글자(앞 1500자): 사진을 못 읽는 직원도 참고하게 */
  text: string;
  /** 조작 중 내려받은 파일(예: CSV 내보내기)과 글자 인코딩 점검 */
  downloads: DownloadedFile[];
  /** 확인 순서의 조작 직후 몇 초 녹화(움직임·반응 속도를 보려고) */
  clips: ScreenClip[];
  /** 조작 중 뜬 확인 창(alert/confirm/prompt): 자동으로 "확인"을 눌렀다 */
  dialogs: string[];
}

export interface DownloadedFile {
  name: string;
  size: number;
  /** 글자 파일이면: UTF-8 BOM, 올바른 UTF-8인지, 한글이 있는지, 앞 몇 줄 */
  text?: { bom: boolean; utf8: boolean; hangul: boolean; preview: string };
  /** 사람이 읽는 판정(예: 엑셀에서 한글이 깨질 수 있음) */
  verdict: string;
}

const TEXT_EXT = /\.(csv|tsv|txt|json|md|xml|html?)$/i;

/**
 * 내려받은 파일을 점검한다. 실측(2026-09-30): "CSV가 엑셀에서 한글 깨짐 없이 열리는지"는 사진으로 볼 수 없어 대표 몫으로 남았다.
 * 한국어 윈도 엑셀은 BOM 없는 UTF-8 CSV를 CP949로 읽어 한글이 깨진다: BOM 유무로 판정한다.
 */
export function inspectDownload(name: string, buf: Buffer): DownloadedFile {
  if (!TEXT_EXT.test(name) || buf.length > 2_000_000) return { name, size: buf.length, verdict: '' };
  const bom = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  let utf8 = true;
  let body = '';
  try {
    body = new TextDecoder('utf-8', { fatal: true }).decode(bom ? buf.subarray(3) : buf);
  } catch {
    utf8 = false;
  }
  const hangul = /[\uac00-\ud7a3]/.test(body);
  // 앞뒤를 함께 보여 준다: 합계 행처럼 중요한 줄이 파일 끝에 오는 경우가 많다(실측: 합계 행이 앞 5줄 미리보기에서 잘렸다).
  const lines = body.replace(/\r?\n$/, '').split(/\r?\n/);
  const preview = (lines.length > 8 ? [...lines.slice(0, 4), '…', ...lines.slice(-4)] : lines).join('\n').slice(0, 800);
  const csv = /\.(csv|tsv)$/i.test(name);
  const verdict = !utf8
    ? 'UTF-8이 아닙니다(다른 인코딩이거나 깨진 파일)'
    : csv && hangul && !bom
      ? '⚠ BOM 없는 UTF-8: 엑셀에서 한글이 깨질 수 있습니다'
      : csv && hangul
        ? 'UTF-8 BOM 있음: 엑셀에서 한글이 정상으로 열립니다'
        : 'UTF-8 글자 파일';
  return { name, size: buf.length, text: { bom, utf8, hangul, preview }, verdict };
}

export function findChrome(): string | null {
  const env = process.env.AC_CHROME;
  if (env && existsSync(env) && !/msedge/i.test(env)) return env;
  const candidates =
    process.platform === 'win32'
      ? [
          path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
          path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
          path.join(process.env.LOCALAPPDATA ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        ]
      : process.platform === 'darwin'
        ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
        : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  return candidates.find((c) => existsSync(c)) ?? null;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Cdp {
  private seq = 0;
  private waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private listeners: ((method: string, params: Record<string, unknown>) => void)[] = [];
  private ws: WebSocket;
  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data)) as {
        id?: number;
        result?: unknown;
        error?: { message: string };
        method?: string;
        params?: Record<string, unknown>;
      };
      if (msg.id !== undefined) {
        const w = this.waiting.get(msg.id);
        this.waiting.delete(msg.id);
        if (msg.error) w?.reject(new Error(msg.error.message));
        else w?.resolve(msg.result);
      } else if (msg.method) for (const l of this.listeners) l(msg.method, msg.params ?? {});
    });
  }
  static connect(url: string): Promise<Cdp> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.addEventListener('open', () => resolve(new Cdp(ws)));
      ws.addEventListener('error', () => reject(new Error('CDP connection failed')));
    });
  }
  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = ++this.seq;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.waiting.delete(id)) reject(new Error(`CDP ${method} timed out`));
      }, 20_000);
      this.waiting.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v as T);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
    });
  }
  on(fn: (method: string, params: Record<string, unknown>) => void): void {
    this.listeners.push(fn);
  }
  /**
   * alert/confirm/prompt 창을 사람처럼 "확인"으로 닫고 문구를 모은다. Page.enable 뒤에 효과가 있다.
   * 실측(첫 사용, 2026-10-01): 삭제 전 confirm()을 쓰는 메모 앱에서 창이 페이지를 멈춰 세웠고,
   * 담당 직원이 그걸 확인하려던 시험 스크립트가 끝나지 않아 업무가 멈췄다.
   */
  acceptDialogs(): string[] {
    const seen: string[] = [];
    this.on((method, p) => {
      if (method !== 'Page.javascriptDialogOpening') return;
      if (seen.length < 20) seen.push(`${String(p.type)}: ${String(p.message ?? '').slice(0, 200)}`);
      void this.send('Page.handleJavaScriptDialog', { accept: true, promptText: String(p.defaultPrompt ?? '') }).catch(() => {});
    });
    return seen;
  }
  close(): void {
    this.ws.close();
  }
}

const NAMED_KEYS: Record<string, [string, number]> = {
  Enter: ['Enter', 13],
  Space: [' ', 32],
  Escape: ['Escape', 27],
  Tab: ['Tab', 9],
  Backspace: ['Backspace', 8],
  ArrowLeft: ['ArrowLeft', 37],
  ArrowUp: ['ArrowUp', 38],
  ArrowRight: ['ArrowRight', 39],
  ArrowDown: ['ArrowDown', 40],
  ShiftLeft: ['Shift', 16],
  ControlLeft: ['Control', 17],
};

/** KeyboardEvent.code(예: KeyZ, Digit1, ArrowLeft)로 키를 눌렀다 뗀다. */
export async function key(cdp: Cdp, code: string, holdMs = 60): Promise<void> {
  const named = NAMED_KEYS[code];
  const letter = /^Key([A-Z])$/.exec(code)?.[1];
  const digit = /^Digit([0-9])$/.exec(code)?.[1];
  const keyName = named?.[0] ?? letter?.toLowerCase() ?? digit ?? code;
  const vk = named?.[1] ?? (letter ? letter.charCodeAt(0) : digit ? 48 + Number(digit) : 0);
  const base = { code, key: keyName, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, ...(keyName.length === 1 ? { text: keyName } : {}) });
  await sleep(holdMs);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

/** 글자를 사람처럼 한 자씩 친다(한꺼번에 넣으면 "입력하는 즉시 반응"을 녹화로 볼 수 없다). */
export async function typeSlowly(cdp: Cdp, text: string): Promise<void> {
  for (const ch of [...text].slice(0, 60)) {
    await cdp.send('Input.insertText', { text: ch });
    await sleep(120);
  }
}

export async function clickAt(cdp: Cdp, x: number, y: number): Promise<void> {
  for (const type of ['mousePressed', 'mouseReleased'])
    await cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
}

/** 글자나 선택자로 요소를 찾아 가운데 좌표를 돌려준다(없으면 null). 페이지에 넣는 코드는 우리가 쓴 것뿐이다. */
export async function findPoint(cdp: Cdp, by: { text?: string; selector?: string }): Promise<{ x: number; y: number } | null> {
  const expression = `(() => {
    const by = ${JSON.stringify(by)};
    let el = null;
    if (by.selector) { try { el = document.querySelector(by.selector); } catch { el = null; } }
    if (!el && by.text) {
      const want = by.text.trim().toLowerCase();
      const all = [...document.querySelectorAll('button, a, [role=button], input[type=button], input[type=submit], label, li, div, span')];
      el = all.filter((e) => (e.innerText || e.value || '').trim().toLowerCase().includes(want))
        .sort((a, b) => (a.innerText || '').length - (b.innerText || '').length)[0] || null;
    }
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`;
  const res = await cdp.send<{ result: { value?: { x: number; y: number } | null } }>('Runtime.evaluate', {
    expression,
    returnByValue: true,
  });
  return res.result.value ?? null;
}

/**
 * url을 보이지 않는 크롬으로 열어 화면을 찍는다. 첫 화면은 늘 찍는다.
 * - 담당 직원이 요구사항별 점검 순서(scenarios)를 남겼으면 그대로 따라 한다(각 순서는 저장소를 비우고 새로 연 페이지에서 시작).
 * - 없으면 흔한 조작(가운데 클릭·Enter → 방향키·스페이스·Z)을 해 보고 두 장 더 찍는다.
 * 실측(2026-09-30): 흔한 조작만으로는 "새로고침해도 최고 점수 유지" 같은 요구를 보여 줄 수 없었다.
 */
export async function captureScreens(
  url: string,
  outDir: string,
  chrome = findChrome(),
  scenarios: ScreenScenario[] = [],
  opts: { mobile?: boolean } = {},
): Promise<ScreenCapture> {
  if (!chrome) throw new Error('Chrome not found');
  await mkdir(outDir, { recursive: true });
  const profile = await mkdtemp(path.join(os.tmpdir(), 'ac-screen-'));
  const proc = spawn(
    chrome,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--mute-audio',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      '--window-size=1280,800',
      'about:blank',
    ],
    { windowsHide: true, stdio: 'ignore' },
  );
  let cdp: Cdp | null = null;
  try {
    let port = 0;
    for (let i = 0; i < 100 && !port; i++) {
      await sleep(150);
      const f = await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8').catch(() => '');
      port = Number(f.split('\n')[0]) || 0;
    }
    if (!port) throw new Error('Chrome did not open a debugging port');
    const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as { type: string; webSocketDebuggerUrl: string }[];
    const page = targets.find((t) => t.type === 'page');
    if (!page) throw new Error('No page target');
    cdp = await Cdp.connect(page.webSocketDebuggerUrl);
    const errors: string[] = [];
    let loaded = false;
    cdp.on((method, p) => {
      if (method === 'Page.loadEventFired') loaded = true;
      if (errors.length >= 20) return;
      if (method === 'Runtime.exceptionThrown') {
        const d = p.exceptionDetails as { text?: string; exception?: { description?: string } };
        errors.push((d.exception?.description ?? d.text ?? 'exception').slice(0, 300));
      }
      if (method === 'Runtime.consoleAPICalled' && p.type === 'error')
        errors.push(
          ((p.args as { value?: unknown; description?: string }[]) ?? [])
            .map((a) => String(a.value ?? a.description ?? ''))
            .join(' ')
            .slice(0, 300),
        );
      if (method === 'Log.entryAdded') {
        const e = p.entry as { level: string; text: string; url?: string };
        // 탭 아이콘(favicon) 404는 거의 모든 간단한 페이지에서 나는 잡음이다(실측: 첫 사용 메모 앱 점검의 유일한 "오류").
        if (e.level === 'error' && !/\/favicon\.ico$/.test(e.url ?? ''))
          errors.push(`${e.text}${e.url ? ` (${e.url})` : ''}`.slice(0, 300));
      }
    });
    const dialogs = cdp.acceptDialogs();
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    const load = async (how: 'navigate' | 'reload', target = url) => {
      loaded = false;
      if (how === 'navigate') await cdp!.send('Page.navigate', { url: target });
      else await cdp!.send('Page.reload', {});
      for (let i = 0; i < 100 && !loaded; i++) await sleep(200);
      await sleep(2000); // 첫 그림이 그려질 시간
    };
    // 조작 중 내려받는 파일(CSV 내보내기 등)을 모아 점검한다.
    const dlDir = path.join(outDir, 'downloads');
    await rm(dlDir, { recursive: true, force: true }).catch(() => undefined);
    await mkdir(dlDir, { recursive: true });
    await cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: dlDir }).catch(() => undefined);
    await load('navigate');

    const shots: ScreenShot[] = [];
    const shoot = async (label: string, width = 1280, minHeight = 800) => {
      // 화면보다 긴 페이지는 아래까지(최대 2000px). 실측: 스네이크 보드 아래쪽이 잘렸다.
      const { cssContentSize: size } = await cdp!.send<{ cssContentSize: { width: number; height: number } }>('Page.getLayoutMetrics');
      const height = Math.min(Math.max(minHeight, Math.ceil(size.height)), 2000);
      const { data } = await cdp!.send<{ data: string }>('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: height > minHeight,
        clip: { x: 0, y: 0, width, height, scale: 1 },
      });
      const file = path.join(outDir, `${shots.length + 1}.png`);
      await writeFile(file, Buffer.from(data, 'base64'));
      shots.push({ label, file });
    };
    const text = await cdp
      .send<{ result: { value?: string } }>('Runtime.evaluate', {
        expression: 'document.body ? document.body.innerText.slice(0, 1500) : ""',
        returnByValue: true,
      })
      .then((r) => r.result.value ?? '')
      .catch(() => '');
    await shoot('첫 화면');

    if (!scenarios.length) {
      await clickAt(cdp, 640, 400);
      await sleep(300);
      await key(cdp, 'Enter');
      await sleep(1500);
      await shoot('가운데 클릭·Enter 뒤');
      await key(cdp, 'ArrowRight', 900);
      await key(cdp, 'Space');
      await sleep(300);
      await key(cdp, 'KeyZ');
      await key(cdp, 'ArrowLeft', 400);
      await sleep(1200);
      await shoot('방향키·스페이스·Z 뒤');
    }
    // 녹화(대표 선택, 2026-09-30): 조작하는 동안과 그 직후 화면이 멈출 때까지만(최대 3초) 초당 4장.
    // 멈춘 사진으로는 "입력하면 바로 걸러지는지" 같은 반응을 볼 수 없었다. 같은 장면이 이어져도 버리지 않는다(느린 반응도 보이게).
    const clipDir = path.join(outDir, 'clips');
    await rm(clipDir, { recursive: true, force: true }).catch(() => undefined);
    const clips: ScreenClip[] = [];
    const recorded = async (clip: ScreenClip, act: () => Promise<void>) => {
      const frames: string[] = [];
      let running = true;
      const grab = async () => {
        const r = await cdp!
          .send<{ data: string }>('Page.captureScreenshot', {
            // 녹화는 움직임만 보면 되므로 가로 480px로 줄여 찍는다(대표 선택: 한 장 약 55KB → 약 15KB).
            format: 'jpeg',
            quality: 55,
            clip: { x: 0, y: 0, width: 1280, height: 800, scale: CLIP_SCALE },
          })
          .catch(() => null);
        return r?.data ?? '';
      };
      const loop = (async () => {
        while (running && clip.frames.length + frames.length < CLIP_MAX_FRAMES) {
          const d = await grab();
          if (d) frames.push(d);
          await sleep(1000 / CLIP_FPS);
        }
      })();
      await act();
      // 조작이 끝난 뒤: 두 장 연속 같으면(화면이 멈춤) 끝, 아니면 최대 3초까지
      const until = Date.now() + CLIP_SETTLE_MAX_MS;
      while (Date.now() < until && clip.frames.length + frames.length < CLIP_MAX_FRAMES) {
        await sleep(1000 / CLIP_FPS);
        if (frames.length >= 2 && frames.at(-1) === frames.at(-2)) break;
      }
      running = false;
      await loop;
      const dir = path.join(clipDir, String(clips.indexOf(clip)));
      await mkdir(dir, { recursive: true });
      for (const d of frames) {
        const file = path.join(dir, `${String(clip.frames.length + 1).padStart(3, '0')}.jpg`);
        await writeFile(file, Buffer.from(d, 'base64'));
        clip.frames.push(file);
      }
    };
    // 순서마다 시간과 사진을 나눠 준다: 앞 순서가 다 써 버려 뒤 순서가 빠지지 않게.
    // 실측(2026-09-30): 순서당 60초로는 보스전(여러 번 공격 + 녹화)이 처치 장면까지 가지 못했다. 최소 90초.
    const perScenarioMs = Math.max(SCENARIO_MIN_MS, Math.floor(360_000 / Math.max(1, scenarios.length)));
    for (const sc of scenarios) {
      if (shots.length >= MAX_SHOTS) break;
      const deadline = Date.now() + perScenarioMs;
      const shotsBefore = shots.length;
      // 각 순서는 깨끗한 상태에서: 저장소를 비우고 새로 연다.
      await cdp.send('Storage.clearDataForOrigin', {
        origin: new URL(url).origin,
        storageTypes: 'local_storage,session_storage,indexeddb,cookies',
      });
      await load('navigate');
      const clip: ScreenClip = { label: sc.requirementId, fps: CLIP_FPS, frames: [] };
      clips.push(clip);
      for (const st of sc.steps) {
        if (shots.length >= MAX_SHOTS || shots.length - shotsBefore >= MAX_SHOTS_PER_SCENARIO || Date.now() > deadline) {
          errors.push(`[${sc.requirementId}] 사진·시간 상한에 닿아 뒤 단계를 건너뜀`);
          break;
        }
        const fail = (why: string) => errors.push(`[${sc.requirementId}] ${why}`);
        if (st.do === 'key')
          await recorded(clip, async () => {
            for (let n = 0; n < (st.times ?? 1); n++) await key(cdp!, st.key, st.holdMs ?? 60);
          });
        else if (st.do === 'click') {
          const pt =
            st.text || st.selector
              ? await findPoint(cdp, { text: st.text, selector: st.selector })
              : { x: (st.x ?? 0.5) * 1280, y: (st.y ?? 0.5) * 800 };
          if (pt) await recorded(clip, () => clickAt(cdp!, pt.x, pt.y));
          else fail(`클릭할 곳을 찾지 못함: ${st.text ?? st.selector}`);
        } else if (st.do === 'type') await recorded(clip, () => typeSlowly(cdp!, st.text));
        else if (st.do === 'wait') await sleep(st.ms);
        else if (st.do === 'reload') await load('reload');
        else if (st.do === 'open') {
          // 같은 앱의 다른 주소만(빠른 확인 모드 등). 실측(2026-10-01, 메이플 5차): 담당자가 만든 ?check=boss를 기계가 열 수 없어
          // 화면 점검 사진이 전부 첫 화면이었다.
          const target = new URL(st.path, url);
          if (target.origin === new URL(url).origin) await load('navigate', target.href);
          else fail(`다른 사이트 주소는 열지 않음: ${st.path}`);
        } else if (st.do === 'setStorage')
          await cdp.send('Runtime.evaluate', {
            expression: `localStorage.setItem(${JSON.stringify(st.key)}, ${JSON.stringify(st.value)})`,
          });
        else if (st.do === 'shot') await shoot(`${sc.requirementId}: ${st.label || '화면'}`);
      }
    }
    await sleep(800); // 마지막 내려받기가 끝날 시간
    const downloads: DownloadedFile[] = [];
    for (const f of await readdir(dlDir).catch(() => [] as string[])) {
      if (f.endsWith('.crdownload')) continue;
      downloads.push(inspectDownload(f, await readFile(path.join(dlDir, f))));
    }
    // 휴대폰 폭(375px)으로도 한 장: 마지막 상태(저장된 데이터 포함)를 다시 불러 찍고, 가로로 넘치는지 잰다.
    // 실측: "모바일 폭에서도 깨지지 않게"는 QA가 1280px 사진만으로 "확인 불가"라고 했다.
    // 프로젝트 프로필이 "휴대폰 대응 안 함"이면 건너뛴다(실측: PC 게임인데 점검마다 휴대폰 경고가 붙었다).
    if (opts.mobile !== false) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 1, mobile: true });
      await load('reload');
      const wide = await cdp
        .send<{ result: { value?: number } }>('Runtime.evaluate', {
          expression: 'document.documentElement.scrollWidth',
          returnByValue: true,
        })
        .then((r) => r.result.value ?? 0)
        .catch(() => 0);
      if (wide > 376) errors.push(`휴대폰 폭(375px)에서 가로로 넘침: 페이지 폭 ${wide}px`);
      await shoot('휴대폰 폭(375px)', 375, 812);
    }
    // 조작 중 뜬 확인 창은 QA가 알 수 있게 화면 글자 뒤에 붙인다(사진에는 창이 찍히지 않는다).
    const withDialogs = dialogs.length
      ? `${text}\n\n[Dialogs shown during the steps; the checker clicked OK]\n${dialogs.join('\n')}`
      : text;
    return { shots, errors, text: withDialogs, downloads, clips: clips.filter((c) => c.frames.length > 0), dialogs };
  } finally {
    cdp?.close();
    // 크롬은 자식 프로세스를 여럿 띄우므로 트리째 끈다.
    if (process.platform === 'win32' && proc.pid)
      spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    else proc.kill();
    await sleep(300);
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
  }
}

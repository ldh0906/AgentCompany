// 자동 화면 점검: 대표 직접 확인 요구가 있는 업무가 승인 대기에 오면, 앱이 결과물을 띄워
// 보이지 않는 크롬(headless)으로 열고, 몇 가지 흔한 조작(클릭·Enter·방향키·스페이스)을 해 본 뒤 화면을 찍는다.
// 실측(2026-09-30): 대표가 매번 터미널·브라우저를 열어 "캔버스가 뜨는지"부터 확인해야 했다. 기계가 먼저 보고,
// QA 직원이 사진을 읽어 요구사항마다 의견을 달면 대표는 사진과 의견을 보고 체크만 하면 된다.
// - 창을 띄우지 않는다(headless). Edge는 쓰지 않는다: 크롬만 찾는다(AC_CHROME로 직접 지정 가능).
// - 외부 라이브러리 없이 크롬 개발자 프로토콜(CDP)을 Node 내장 WebSocket으로 쓴다.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ScreenScenario } from '../agents/report.ts';

const MAX_SHOTS = 12;

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class Cdp {
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
async function key(cdp: Cdp, code: string, holdMs = 60): Promise<void> {
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

async function clickAt(cdp: Cdp, x: number, y: number): Promise<void> {
  for (const type of ['mousePressed', 'mouseReleased'])
    await cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
}

/** 글자나 선택자로 요소를 찾아 가운데 좌표를 돌려준다(없으면 null). 페이지에 넣는 코드는 우리가 쓴 것뿐이다. */
async function findPoint(cdp: Cdp, by: { text?: string; selector?: string }): Promise<{ x: number; y: number } | null> {
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
        if (e.level === 'error') errors.push(`${e.text}${e.url ? ` (${e.url})` : ''}`.slice(0, 300));
      }
    });
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    const load = async (how: 'navigate' | 'reload') => {
      loaded = false;
      if (how === 'navigate') await cdp!.send('Page.navigate', { url });
      else await cdp!.send('Page.reload', {});
      for (let i = 0; i < 100 && !loaded; i++) await sleep(200);
      await sleep(2000); // 첫 그림이 그려질 시간
    };
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
    const deadline = Date.now() + 120_000;
    for (const sc of scenarios) {
      if (shots.length >= MAX_SHOTS || Date.now() > deadline) break;
      // 각 순서는 깨끗한 상태에서: 저장소를 비우고 새로 연다.
      await cdp.send('Storage.clearDataForOrigin', {
        origin: new URL(url).origin,
        storageTypes: 'local_storage,session_storage,indexeddb,cookies',
      });
      await load('navigate');
      for (const st of sc.steps) {
        if (shots.length >= MAX_SHOTS || Date.now() > deadline) break;
        const fail = (why: string) => errors.push(`[${sc.requirementId}] ${why}`);
        if (st.do === 'key') for (let n = 0; n < (st.times ?? 1); n++) await key(cdp, st.key, st.holdMs ?? 60);
        else if (st.do === 'click') {
          const pt =
            st.text || st.selector
              ? await findPoint(cdp, { text: st.text, selector: st.selector })
              : { x: (st.x ?? 0.5) * 1280, y: (st.y ?? 0.5) * 800 };
          if (pt) await clickAt(cdp, pt.x, pt.y);
          else fail(`클릭할 곳을 찾지 못함: ${st.text ?? st.selector}`);
          await sleep(300);
        } else if (st.do === 'type') await cdp.send('Input.insertText', { text: st.text });
        else if (st.do === 'wait') await sleep(st.ms);
        else if (st.do === 'reload') await load('reload');
        else if (st.do === 'setStorage')
          await cdp.send('Runtime.evaluate', {
            expression: `localStorage.setItem(${JSON.stringify(st.key)}, ${JSON.stringify(st.value)})`,
          });
        else if (st.do === 'shot') await shoot(`${sc.requirementId}: ${st.label || '화면'}`);
      }
    }
    // 휴대폰 폭(375px)으로도 한 장: 마지막 상태(저장된 데이터 포함)를 다시 불러 찍고, 가로로 넘치는지 잰다.
    // 실측: "모바일 폭에서도 깨지지 않게"는 QA가 1280px 사진만으로 "확인 불가"라고 했다.
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 1, mobile: true });
    await load('reload');
    const wide = await cdp
      .send<{ result: { value?: number } }>('Runtime.evaluate', { expression: 'document.documentElement.scrollWidth', returnByValue: true })
      .then((r) => r.result.value ?? 0)
      .catch(() => 0);
    if (wide > 376) errors.push(`휴대폰 폭(375px)에서 가로로 넘침: 페이지 폭 ${wide}px`);
    await shoot('휴대폰 폭(375px)', 375, 812);
    return { shots, errors, text };
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

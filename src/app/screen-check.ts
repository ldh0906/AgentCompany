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

async function key(cdp: Cdp, code: string, keyName: string, holdMs = 60): Promise<void> {
  const vk: Record<string, number> = {
    Enter: 13,
    Space: 32,
    ArrowLeft: 37,
    ArrowUp: 38,
    ArrowRight: 39,
    ArrowDown: 40,
    KeyZ: 90,
    KeyX: 88,
  };
  const base = { code, key: keyName, windowsVirtualKeyCode: vk[code] ?? 0, nativeVirtualKeyCode: vk[code] ?? 0 };
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, ...(keyName.length === 1 ? { text: keyName } : {}) });
  await sleep(holdMs);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

/**
 * url을 보이지 않는 크롬으로 열어 세 장을 찍는다: 첫 화면 → 가운데 클릭·Enter 뒤 → 방향키·스페이스·Z 뒤.
 * 흔한 게임·웹앱이 "시작 화면 → 진입 → 조작" 순서라 이 정도면 "뜨는지, 반응하는지"는 보인다.
 */
export async function captureScreens(url: string, outDir: string, chrome = findChrome()): Promise<ScreenCapture> {
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
    await cdp.send('Page.navigate', { url });
    for (let i = 0; i < 100 && !loaded; i++) await sleep(200);
    await sleep(2500); // 첫 그림이 그려질 시간

    const shots: ScreenShot[] = [];
    const shoot = async (label: string) => {
      // 화면보다 긴 페이지는 아래까지(최대 2000px). 실측: 스네이크 보드 아래쪽이 잘렸다.
      const { cssContentSize: size } = await cdp!.send<{ cssContentSize: { width: number; height: number } }>('Page.getLayoutMetrics');
      const height = Math.min(Math.max(800, Math.ceil(size.height)), 2000);
      const { data } = await cdp!.send<{ data: string }>('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: height > 800,
        clip: { x: 0, y: 0, width: 1280, height, scale: 1 },
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

    for (const type of ['mousePressed', 'mouseReleased'])
      await cdp.send('Input.dispatchMouseEvent', { type, x: 640, y: 400, button: 'left', clickCount: 1 });
    await sleep(300);
    await key(cdp, 'Enter', 'Enter');
    await sleep(1500);
    await shoot('가운데 클릭·Enter 뒤');

    await key(cdp, 'ArrowRight', 'ArrowRight', 900);
    await key(cdp, 'Space', ' ');
    await sleep(300);
    await key(cdp, 'KeyZ', 'z');
    await key(cdp, 'ArrowLeft', 'ArrowLeft', 400);
    await sleep(1200);
    await shoot('방향키·스페이스·Z 뒤');
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

// 고급 QA용 "플레이 세션": QA 직원이 명령 한 줄씩으로 보이지 않는 크롬을 조종하고, 매번 새 화면 사진 경로를 받는다.
// 대표 요청(2026-09-30): 게임을 직접 해 보는 고급 QA. 정해진 순서대로 찍는 화면 점검과 달리, 사람처럼 보고 → 누르고 → 다시 본다.
// - 크롬은 세션 동안 떠 있다(명령마다 다시 연결). 세션 정보는 폴더의 session.json.
// - 사진은 800x500 JPEG로 줄여 찍는다(QA가 사진을 볼 때마다 토큰이 들기 때문).
// - 한 세션에 행동은 최대 MAX_STEPS번(비용 상한).

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Cdp, clickAt, findChrome, findPoint, key, sleep, typeSlowly } from './screen-check.ts';

export const MAX_STEPS = 80;

interface Session {
  pid: number;
  port: number;
  url: string;
  steps: number;
}

const ERROR_HOOK = `(() => {
  if (window.__acErrors) return;
  window.__acErrors = [];
  addEventListener('error', (e) => window.__acErrors.push(String(e.message || e)));
  addEventListener('unhandledrejection', (e) => window.__acErrors.push('unhandled: ' + String(e.reason)));
  const orig = console.error;
  console.error = (...a) => { window.__acErrors.push(a.map(String).join(' ')); orig.apply(console, a); };
})()`;

async function pageSocket(port: number): Promise<string> {
  const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as { type: string; webSocketDebuggerUrl: string }[];
  const page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error('no page');
  return page.webSocketDebuggerUrl;
}

async function snap(cdp: Cdp, dir: string, n: number): Promise<string> {
  const { data } = await cdp.send<{ data: string }>('Page.captureScreenshot', {
    format: 'jpeg',
    quality: 60,
    clip: { x: 0, y: 0, width: 1280, height: 800, scale: 800 / 1280 },
  });
  const file = path.join(dir, 'shots', `${String(n).padStart(4, '0')}.jpg`);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, Buffer.from(data, 'base64'));
  return file;
}

async function errorsSince(cdp: Cdp): Promise<string[]> {
  const r = await cdp
    .send<{ result: { value?: string[] } }>('Runtime.evaluate', {
      expression: '(() => { const e = window.__acErrors || []; window.__acErrors = []; return e.slice(0, 5); })()',
      returnByValue: true,
    })
    .catch(() => null);
  return r?.result.value ?? [];
}

function killTree(pid: number): void {
  if (process.platform === 'win32') spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  else {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // 이미 끝남
    }
  }
}

/** 세션을 끝낸다(크롬을 끄고 프로필을 지운다). 오케스트레이터도 실행이 끝나면 부른다. */
export async function stopPlay(dir: string): Promise<void> {
  const raw = await readFile(path.join(dir, 'session.json'), 'utf8').catch(() => '');
  if (raw) killTree((JSON.parse(raw) as Session).pid);
  await sleep(300);
  await rm(path.join(dir, '.profile'), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
  await rm(path.join(dir, 'session.json'), { force: true }).catch(() => {});
}

/**
 * play <명령> [값] [--hold ms] [--times n] [--text 글자] [--x 0.5 --y 0.5] [--url 주소] [--dir 폴더]
 * 명령: start | look | key <코드>[+<코드>] | click | type <글자> | wait <ms> | storage <키> <값> | stop
 */
export async function playCommand(argv: string[]): Promise<string> {
  const opt = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const positional = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1]!.startsWith('--')));
  const [cmd, value] = positional;
  const dir = path.resolve(opt('dir') ?? process.cwd());
  const sessionFile = path.join(dir, 'session.json');

  if (cmd === 'stop') {
    await stopPlay(dir);
    return 'stopped';
  }

  let session: Session | null = existsSync(sessionFile) ? (JSON.parse(await readFile(sessionFile, 'utf8')) as Session) : null;
  if (cmd === 'start') {
    const url = opt('url') ?? value ?? session?.url;
    if (!url) return 'usage: play start --url <address>';
    if (session) await stopPlay(dir);
    const chrome = findChrome();
    if (!chrome) return 'Chrome not found';
    const profile = path.join(dir, '.profile');
    await mkdir(profile, { recursive: true });
    const child = spawn(
      chrome,
      [
        '--headless=new',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        '--mute-audio',
        '--remote-debugging-port=0',
        `--user-data-dir=${profile}`,
        '--window-size=1280,800',
        'about:blank',
      ],
      { windowsHide: true, stdio: 'ignore', detached: true },
    );
    child.unref();
    let port = 0;
    for (let i = 0; i < 100 && !port; i++) {
      await sleep(150);
      port = Number((await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8').catch(() => '')).split('\n')[0]) || 0;
    }
    if (!port) return 'Chrome did not start';
    session = { pid: child.pid!, port, url, steps: 0 };
  }
  if (!session) return 'no session: run "play start --url <address>" first';
  if (session.steps >= MAX_STEPS) return `limit reached (${MAX_STEPS} actions). Write your report now and run "play stop".`;

  const cdp = await Cdp.connect(await pageSocket(session.port));
  try {
    await cdp.send('Runtime.enable');
    if (cmd === 'start') {
      await cdp.send('Page.enable');
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
      await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: ERROR_HOOK });
      await cdp.send('Page.navigate', { url: session.url });
      await sleep(3000);
    } else if (cmd === 'key') {
      if (!value) return 'usage: play key <KeyboardEvent.code>[+<code>...] [--hold ms] [--times n]';
      const times = Math.min(Number(opt('times') ?? 1) || 1, 30);
      const hold = Math.min(Number(opt('hold') ?? 80) || 80, 5000);
      // "ArrowRight+Space": 여러 키를 함께 누른다(실측: 점프하며 이동해야 넘는 턱을 못 넘어 보스까지 못 갔다).
      const codes = value.split('+').filter(Boolean);
      for (let n = 0; n < times; n++) {
        if (codes.length === 1) await key(cdp, codes[0]!, hold);
        else await Promise.all(codes.map((c, i) => sleep(i * 30).then(() => key(cdp, c, hold))));
      }
      await sleep(400);
    } else if (cmd === 'storage') {
      // 저장 데이터를 넣고 새로고침: 뒤쪽 내용(보스·강화 등)을 처음부터 키우지 않고 보려고(담당자가 남긴 확인용 값 등).
      const k = value;
      const v = positional[2];
      if (!k || v === undefined) return 'usage: play storage <localStorage key> <value>';
      await cdp.send('Runtime.evaluate', { expression: `localStorage.setItem(${JSON.stringify(k)}, ${JSON.stringify(v)})` });
      await cdp.send('Page.reload', {});
      await sleep(2500);
    } else if (cmd === 'click') {
      const text = opt('text') ?? value;
      const pt =
        text || opt('selector')
          ? await findPoint(cdp, { text, selector: opt('selector') })
          : { x: Number(opt('x') ?? 0.5) * 1280, y: Number(opt('y') ?? 0.5) * 800 };
      if (!pt) return `could not find "${text ?? opt('selector')}" on screen`;
      await clickAt(cdp, pt.x, pt.y);
      await sleep(500);
    } else if (cmd === 'type') {
      if (!value) return 'usage: play type <text>';
      await typeSlowly(cdp, value);
      await sleep(300);
    } else if (cmd === 'wait') {
      await sleep(Math.min(Number(value ?? 1000) || 1000, 10_000));
    } else if (cmd !== 'look') {
      return `unknown command "${cmd}". Commands: start, look, key, click, type, wait, storage, stop`;
    }
    session.steps++;
    await writeFile(sessionFile, JSON.stringify(session));
    const shot = await snap(cdp, dir, session.steps);
    const errors = await errorsSince(cdp);
    return [`shot: ${shot}`, errors.length ? `page errors: ${errors.join(' | ')}` : '', `actions used: ${session.steps}/${MAX_STEPS}`]
      .filter(Boolean)
      .join('\n');
  } finally {
    cdp.close();
  }
}

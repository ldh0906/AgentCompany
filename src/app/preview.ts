// 실행해 보기: 대표가 결과물을 직접 확인(대표 직접 확인 요구)할 수 있게 제출물이나 기준 브랜치를 띄운다.
// 실측(2026-09-30): "npm run dev로 캔버스 확인" 같은 요구를 앱 안에서 확인할 방법이 없어 대표가 터미널을 열어야 했다.
// - package.json에 dev/start 스크립트가 있으면 그것을, 없고 index.html이 있으면 내장 정적 서버를 쓴다.
// - 개발 서버 출력에서 localhost 주소를 찾아 돌려준다. 프로세스는 앱 종료 때 함께 끝낸다.

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import { tr } from '../core/i18n.ts';
import { locateExecutable } from '../runner/locate.ts';
import { dependencySetup } from './verify-setup.ts';

export interface PreviewInfo {
  key: string;
  projectId: string;
  ticketId: string | null;
  sha: string;
  state: 'starting' | 'running' | 'failed' | 'stopped';
  url: string | null;
  command: string;
  log: string;
  startedAt: string;
}

const URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0):\d+[^\s'"]*/;
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const MAX_LOG = 12_000;
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.wasm': 'application/wasm',
};

/** 무엇으로 띄울지 정한다(순수 판단: 테스트용으로 분리). */
export function previewCommand(dir: string): { argv: string[] } | { static: true } | null {
  const pkgPath = path.join(dir, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const scripts = (JSON.parse(readFileSync(pkgPath, 'utf8')) as { scripts?: Record<string, string> }).scripts ?? {};
      if (scripts.dev) return { argv: ['npm', 'run', 'dev'] };
      if (scripts.start) return { argv: ['npm', 'start'] };
    } catch {
      // 잘못된 package.json: 아래 정적 서버로
    }
  }
  if (existsSync(path.join(dir, 'index.html'))) return { static: true };
  return null;
}

interface Live {
  info: PreviewInfo;
  child: ChildProcess | null;
  server: Server | null;
}

export class PreviewManager {
  private live = new Map<string, Live>();

  list(): PreviewInfo[] {
    return [...this.live.values()].map((l) => l.info);
  }

  async start(p: { projectId: string; ticketId: string | null; sha: string; dir: string }): Promise<PreviewInfo> {
    const key = `${p.projectId}:${p.ticketId ?? 'base'}`;
    this.stop(key);
    const info: PreviewInfo = {
      key,
      projectId: p.projectId,
      ticketId: p.ticketId,
      sha: p.sha,
      state: 'starting',
      url: null,
      command: '',
      log: '',
      startedAt: new Date().toISOString(),
    };
    const entry: Live = { info, child: null, server: null };
    this.live.set(key, entry);
    const append = (s: string) => {
      info.log = (info.log + s.replace(ANSI, '')).slice(-MAX_LOG);
    };
    const fail = (why: string) => {
      info.state = 'failed';
      append(`\n${why}\n`);
      return info;
    };

    const how = previewCommand(p.dir);
    if (!how)
      return fail(
        tr(
          '띄울 방법을 찾지 못했습니다: package.json의 dev/start 스크립트나 index.html이 없습니다.',
          'Nothing to run: no dev/start script in package.json and no index.html.',
        ),
      );

    if ('static' in how) {
      info.command = tr('내장 정적 서버', 'built-in static server');
      entry.server = await staticServer(p.dir);
      const addr = entry.server.address();
      info.url = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}/` : null;
      info.state = 'running';
      return info;
    }

    const setup = dependencySetup(p.dir, []);
    if (setup) {
      info.command = setup.argv.join(' ');
      const code = await this.runToEnd(setup.argv, p.dir, append, entry);
      if (this.live.get(key) !== entry) return info; // 설치 중 중지됨
      if (code !== 0) return fail(tr(`의존성 설치 실패 (exit ${code})`, `Dependency install failed (exit ${code})`));
    }
    info.command = how.argv.join(' ');
    const located = await locateExecutable(how.argv[0]!);
    if (!located?.launch) return fail(tr(`${how.argv[0]}을(를) 찾지 못했습니다.`, `${how.argv[0]} not found.`));
    const child = spawn(located.launch.file, [...located.launch.argsPrefix, ...how.argv.slice(1)], {
      cwd: p.dir,
      env: { ...process.env, BROWSER: 'none', FORCE_COLOR: '0', NO_COLOR: '1' },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    entry.child = child;
    return new Promise<PreviewInfo>((resolve) => {
      const timer = setTimeout(() => resolve(info), 90_000); // 주소가 늦게 나오면 일단 돌려주고 계속 기다린다
      const onData = (d: Buffer) => {
        append(d.toString('utf8'));
        const m = info.url ? null : info.log.match(URL_RE);
        if (m) {
          info.url = m[0].replace('0.0.0.0', '127.0.0.1');
          info.state = 'running';
          clearTimeout(timer);
          resolve(info);
        }
      };
      child.stdout!.on('data', onData);
      child.stderr!.on('data', onData);
      child.once('exit', (code) => {
        if (info.state !== 'stopped') {
          info.state = 'failed';
          append(tr(`\n(종료됨, exit ${code})\n`, `\n(exited, code ${code})\n`));
        }
        clearTimeout(timer);
        resolve(info);
      });
    });
  }

  stop(key: string): void {
    const l = this.live.get(key);
    if (!l) return;
    l.info.state = 'stopped';
    if (l.child?.pid && l.child.exitCode === null) killTree(l.child.pid);
    l.server?.close();
    this.live.delete(key);
  }

  stopAll(): void {
    for (const key of [...this.live.keys()]) this.stop(key);
  }

  private async runToEnd(argv: string[], cwd: string, append: (s: string) => void, entry: Live): Promise<number | null> {
    const located = await locateExecutable(argv[0]!);
    if (!located?.launch) return -1;
    return new Promise((resolve) => {
      const child = spawn(located.launch!.file, [...located.launch!.argsPrefix, ...argv.slice(1)], {
        cwd,
        env: { ...process.env, FORCE_COLOR: '0' },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      entry.child = child;
      child.stdout!.on('data', (d: Buffer) => append(d.toString('utf8')));
      child.stderr!.on('data', (d: Buffer) => append(d.toString('utf8')));
      child.once('exit', (code) => resolve(code));
      child.once('error', () => resolve(-1));
    });
  }
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

export function staticServer(root: string): Promise<Server> {
  const base = path.resolve(root);
  const server = createServer(async (req, res) => {
    // 보안 점검(2026-10-01): 본 서버처럼 Host를 확인해 DNS 리바인딩으로 다른 사이트가 결과물을 읽지 못하게 하고,
    // 깨진 주소(%E0%A4%A)의 디코드 오류가 처리되지 않은 예외로 앱 전체를 끄지 않게 한다.
    const port = (server.address() as { port: number } | null)?.port;
    if (req.headers.host !== `127.0.0.1:${port}` && req.headers.host !== `localhost:${port}`) {
      res.writeHead(403).end();
      return;
    }
    let rel: string;
    try {
      rel = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    } catch {
      res.writeHead(400).end();
      return;
    }
    let file = path.resolve(base, `.${rel}`);
    if (file !== base && !file.startsWith(base + path.sep)) {
      res.writeHead(403).end();
      return;
    }
    try {
      if ((await stat(file)).isDirectory()) file = path.join(file, 'index.html');
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream' }).end(body);
    } catch {
      res.writeHead(404).end('Not found');
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

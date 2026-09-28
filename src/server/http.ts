import { tr } from '../core/i18n.ts';
// 로컬 대시보드 서버. 127.0.0.1에만 열고, 세션 토큰과 Host 헤더를 검사한다(DNS 리바인딩 방어). CORS 없음.

import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { Api, ApiError } from './api.ts';

export interface ServerOptions {
  api: Api;
  port: number;
  webRoot: string | null;
  token?: string;
}

export interface RunningServer {
  url: string;
  port: number;
  token: string;
  broadcast(kind: string, id: string): void;
  close(): Promise<void>;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

async function readBody(req: http.IncomingMessage, limit = 2_000_000): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new ApiError(413, tr('요청 본문이 너무 큽니다.', 'Request body is too large.'));
    chunks.push(c as Buffer);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ApiError(400, tr('JSON 형식이 잘못되었습니다.', 'Invalid JSON.'));
  }
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(text);
}

export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const token = opts.token ?? randomBytes(24).toString('base64url');
  const clients = new Set<http.ServerResponse>();
  let port = opts.port;

  const allowedHost = (host: string | undefined) => host === `127.0.0.1:${port}` || host === `localhost:${port}`;

  const server = http.createServer(async (req, res) => {
    try {
      if (!allowedHost(req.headers.host)) {
        res.writeHead(421).end('Misdirected Request');
        return;
      }
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);

      if (url.pathname.startsWith('/api/')) {
        // 브라우저가 다른 사이트에서 보내는 요청 차단(Origin이 있으면 같은 출처여야 함)
        const origin = req.headers.origin;
        if (origin && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) {
          send(res, 403, { error: tr('다른 출처의 요청은 허용하지 않습니다.', 'Requests from other origins are not allowed.') });
          return;
        }
        const header = req.headers.authorization?.replace(/^Bearer\s+/i, '') ?? '';
        const supplied = url.pathname === '/api/stream' ? (url.searchParams.get('token') ?? '') : header;
        if (!safeEqual(supplied, token)) {
          send(res, 401, { error: tr('인증 토큰이 필요합니다. 터미널에 표시된 주소로 다시 여세요.', 'Authentication token required. Reopen the URL shown in the terminal.') });
          return;
        }
        if (url.pathname === '/api/stream') {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
          res.write(': connected\n\n');
          clients.add(res);
          req.on('close', () => clients.delete(res));
          return;
        }
        const body = req.method === 'GET' ? {} : await readBody(req);
        const result = await opts.api.handle(req.method ?? 'GET', url.pathname, url.searchParams, body);
        send(res, 200, result);
        return;
      }

      await serveStatic(res, url.pathname, opts.webRoot);
    } catch (error) {
      if (error instanceof ApiError) send(res, error.status, { error: error.message });
      else if (error instanceof Error && error.constructor.name === 'DomainError') send(res, 409, { error: error.message });
      else send(res, 500, { error: String((error as Error)?.message ?? error) });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, '127.0.0.1', () => resolve());
  });
  port = (server.address() as AddressInfo).port;

  const heartbeat = setInterval(() => {
    for (const c of clients) c.write(': ping\n\n');
  }, 20_000);

  return {
    url: `http://127.0.0.1:${port}/#token=${token}`,
    port,
    token,
    broadcast(kind, id) {
      const msg = `event: change\ndata: ${JSON.stringify({ kind, id })}\n\n`;
      for (const c of clients) c.write(msg);
    },
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(heartbeat);
        for (const c of clients) c.end();
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}

async function serveStatic(res: http.ServerResponse, pathname: string, webRoot: string | null): Promise<void> {
  if (!webRoot || !existsSync(webRoot)) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(tr('<!doctype html><meta charset="utf-8"><title>Agent Company</title><p>대시보드가 빌드되지 않았습니다. <code>npm run build</code>를 실행하세요.</p>', '<!doctype html><meta charset="utf-8"><title>Agent Company</title><p>The dashboard has not been built. Run <code>npm run build</code>.</p>'));
    return;
  }
  const rel = decodeURIComponent(pathname).replace(/^\/+/, '');
  let file = path.resolve(webRoot, rel || 'index.html');
  const inside = path.relative(path.resolve(webRoot), file);
  if (inside.startsWith('..') || path.isAbsolute(inside)) {
    res.writeHead(403).end();
    return;
  }
  const isFile = await stat(file).then((s) => s.isFile()).catch(() => false);
  if (!isFile) file = path.join(webRoot, 'index.html'); // SPA
  const data = await readFile(file);
  res.writeHead(200, {
    'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'",
    'referrer-policy': 'no-referrer',
    'cache-control': file.endsWith('index.html') ? 'no-store' : 'public, max-age=3600',
  });
  res.end(data);
}

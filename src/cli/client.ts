// CLI ↔ 회사 데몬: daemon.lock에 적힌 주소·토큰으로 대시보드와 같은 REST API를 부른다.
// 데몬이 없으면 창 없이 띄운다(`aco`만 쳐도 회사가 켜진다).
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isAlive } from '../runner/process.ts';

export interface Daemon {
  /** http://127.0.0.1:4777 */
  base: string;
  token: string;
  pid: number;
}

export function findDaemon(dataDir: string): Daemon | null {
  try {
    const lock = JSON.parse(readFileSync(path.join(dataDir, 'daemon.lock'), 'utf8')) as { pid: number; url: string };
    if (!lock.url || !isAlive(lock.pid)) return null;
    const u = new URL(lock.url);
    const token = new URLSearchParams(u.hash.slice(1)).get('token') ?? '';
    return { base: u.origin, token, pid: lock.pid };
  } catch {
    return null;
  }
}

/** 데몬이 없으면 백그라운드로 띄우고 주소가 생길 때까지 기다린다. */
export async function ensureDaemon(
  dataDir: string,
  extraArgs: string[] = [],
  waitMs = 30_000,
): Promise<{ daemon: Daemon; started: boolean }> {
  const found = findDaemon(dataDir);
  if (found) return { daemon: found, started: false };
  const here = fileURLToPath(import.meta.url);
  const main = path.join(path.dirname(here), `main${path.extname(here)}`);
  const child = spawn(
    process.execPath,
    ['--no-warnings', main, 'start', '--background', '--no-open', '--data-dir', dataDir, ...extraArgs],
    {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    },
  );
  child.unref();
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 300));
    const d = findDaemon(dataDir);
    if (d) return { daemon: d, started: true };
  }
  throw new Error(`회사를 켜지 못했습니다. ${path.join(dataDir, 'server.log')}를 확인하세요.`);
}

export class Client {
  readonly daemon: Daemon;

  constructor(daemon: Daemon) {
    this.daemon = daemon;
  }

  get dashboard(): string {
    return `${this.daemon.base}/#token=${this.daemon.token}`;
  }

  async call<T = unknown>(method: 'GET' | 'POST' | 'PATCH', route: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.daemon.base}/api/${route}`, {
      method,
      headers: { authorization: `Bearer ${this.daemon.token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    const data = text ? (JSON.parse(text) as unknown) : null;
    if (!res.ok) throw new Error((data as { error?: string } | null)?.error ?? `${res.status} ${res.statusText}`);
    return data as T;
  }

  get<T = unknown>(route: string): Promise<T> {
    return this.call<T>('GET', route);
  }

  post<T = unknown>(route: string, body: unknown = {}): Promise<T> {
    return this.call<T>('POST', route, body);
  }
}

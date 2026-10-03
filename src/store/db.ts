// SQLite 저장소. node:sqlite(내장)를 써서 네이티브 빌드 없이 Windows에서 바로 동작한다.
// 모든 상태 변경은 transact() 안에서 이벤트 로그와 함께 커밋된다.

import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { DomainEvent } from '../core/types.ts';

const MIGRATIONS: string[] = [
  `
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE projects (id TEXT PRIMARY KEY, data TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE employees (id TEXT PRIMARY KEY, data TEXT NOT NULL, active INTEGER NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE tickets (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE INDEX tickets_status ON tickets(status);
  CREATE TABLE runs (
    id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL, started_at TEXT NOT NULL
  );
  CREATE INDEX runs_ticket ON runs(ticket_id);
  CREATE INDEX runs_status ON runs(status);
  CREATE TABLE approvals (
    id TEXT PRIMARY KEY, ticket_id TEXT, state TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE INDEX approvals_state ON approvals(state);
  CREATE TABLE evidence (
    id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL, run_id TEXT, data TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE INDEX evidence_ticket ON evidence(ticket_id);
  CREATE TABLE claims (id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL, data TEXT NOT NULL);
  CREATE TABLE decisions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE messages (id TEXT PRIMARY KEY, ticket_id TEXT, data TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE path_locks (ticket_id TEXT NOT NULL, glob TEXT NOT NULL, PRIMARY KEY (ticket_id, glob));
  CREATE TABLE events (
    seq INTEGER PRIMARY KEY, ts TEXT NOT NULL, actor TEXT NOT NULL, type TEXT NOT NULL,
    entity_id TEXT NOT NULL, payload TEXT NOT NULL, prev_hash TEXT NOT NULL, hash TEXT NOT NULL
  );
  CREATE INDEX events_entity ON events(entity_id);
  `,
  `
  CREATE TABLE requests (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL);
  `,
  `
  CREATE TABLE channels (id TEXT PRIMARY KEY, data TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE chat (id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE INDEX chat_channel ON chat(channel_id);
  `,
];

export const GENESIS_HASH = '0'.repeat(64);

type Row = Record<string, unknown>;

export type EntityTable =
  | 'projects'
  | 'employees'
  | 'tickets'
  | 'runs'
  | 'approvals'
  | 'evidence'
  | 'claims'
  | 'decisions'
  | 'messages'
  | 'requests'
  | 'channels'
  | 'chat';

export class Store {
  readonly db: DatabaseSync;
  private inTransaction = false;
  /** DB 밖에 마지막 이벤트의 seq·hash를 남긴다. 로그 끝부분을 지우면 체크포인트와 어긋나 탐지된다. */
  private readonly checkpointPath: string | null;
  private pendingCheckpoint: { seq: number; hash: string } | null = null;
  /** 체크포인트가 DB와 어긋나면(끝부분 삭제 등) 갱신을 멈춰 증거를 보존한다. */
  private checkpointFrozen = false;
  checkpointError: string | null = null;

  constructor(path: string) {
    this.checkpointPath = path === ':memory:' ? null : `${path}.head`;
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.migrate();
    this.checkpointFrozen = !this.checkpointMatchesDb();
  }

  private checkpointMatchesDb(): boolean {
    const cp = this.readCheckpoint();
    if (!cp) return true;
    const row = this.db.prepare('SELECT hash FROM events WHERE seq = ?').get(cp.seq) as Row | undefined;
    return Boolean(row) && String(row!.hash) === cp.hash;
  }

  private migrate(): void {
    const current = (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    for (let v = current; v < MIGRATIONS.length; v++) {
      this.transact(() => {
        this.db.exec(MIGRATIONS[v]!);
        this.db.exec(`PRAGMA user_version = ${v + 1}`);
      });
    }
  }

  /** 중첩 호출 시 바깥 트랜잭션에 합류한다. */
  transact<T>(fn: () => T): T {
    if (this.inTransaction) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    this.inTransaction = true;
    try {
      const result = fn();
      this.db.exec('COMMIT');
      this.inTransaction = false;
      // 커밋은 이미 끝났다: 체크포인트 쓰기 실패는 롤백 대상이 아니다.
      try {
        this.flushCheckpoint();
      } catch (error) {
        this.checkpointError = String(error);
        this.pendingCheckpoint = null;
      }
      return result;
    } catch (error) {
      if (this.inTransaction) this.db.exec('ROLLBACK');
      this.pendingCheckpoint = null;
      throw error;
    } finally {
      this.inTransaction = false;
    }
  }

  private flushCheckpoint(): void {
    if (!this.checkpointPath || !this.pendingCheckpoint) return;
    const tmp = `${this.checkpointPath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.pendingCheckpoint));
    renameSync(tmp, this.checkpointPath);
    this.pendingCheckpoint = null;
  }

  private readCheckpoint(): { seq: number; hash: string } | null {
    if (!this.checkpointPath) return null;
    try {
      return JSON.parse(readFileSync(this.checkpointPath, 'utf8'));
    } catch {
      return null;
    }
  }

  close(): void {
    if (this.db.isOpen) this.db.close();
  }

  // ---- 설정 ----

  getSetting(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as Row | undefined;
    return row ? String(row.value) : null;
  }

  setSetting(key: string, value: string): void {
    this.db.prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  // ---- 엔터티 (JSON 문서 + 조회용 컬럼) ----

  get<T>(table: EntityTable, id: string): T | null {
    const row = this.db.prepare(`SELECT data FROM ${table} WHERE id = ?`).get(id) as Row | undefined;
    return row ? (JSON.parse(String(row.data)) as T) : null;
  }

  list<T>(table: EntityTable, where = '', ...params: (string | number | null)[]): T[] {
    const rows = this.db.prepare(`SELECT data FROM ${table} ${where}`).all(...params) as Row[];
    return rows.map((r) => JSON.parse(String(r.data)) as T);
  }

  /** 행 지우기(대화방 삭제 등). 열은 id·channel_id만 받는다. 이벤트 로그(감사 기록)는 지우지 않는다. */
  deleteRows(table: EntityTable, column: 'id' | 'channel_id', value: string): number {
    return Number(this.db.prepare(`DELETE FROM ${table} WHERE ${column} = ?`).run(value).changes);
  }

  put(table: EntityTable, id: string, data: unknown, columns: Record<string, string | number | null> = {}): void {
    const names = ['id', 'data', ...Object.keys(columns)];
    const values = [id, JSON.stringify(data), ...Object.values(columns)];
    const updates = names
      .slice(1)
      .map((n) => `${n} = excluded.${n}`)
      .join(', ');
    this.db
      .prepare(
        `INSERT INTO ${table}(${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')}) ON CONFLICT(id) DO UPDATE SET ${updates}`,
      )
      .run(...values);
  }

  // ---- 이벤트 로그 (추가 전용, 해시 체인) ----

  appendEvent(actor: string, type: string, entityId: string, payload: unknown, ts = new Date().toISOString()): DomainEvent {
    return this.transact(() => {
      const last = this.db.prepare('SELECT seq, hash FROM events ORDER BY seq DESC LIMIT 1').get() as Row | undefined;
      const seq = last ? Number(last.seq) + 1 : 1;
      const prevHash = last ? String(last.hash) : GENESIS_HASH;
      const payloadJson = canonicalJson(payload);
      const hash = eventHash(prevHash, seq, ts, actor, type, entityId, payloadJson);
      this.db
        .prepare('INSERT INTO events(seq, ts, actor, type, entity_id, payload, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(seq, ts, actor, type, entityId, payloadJson, prevHash, hash);
      // 실행 중에 끝부분이 지워졌을 수도 있다: 추가할 때마다 기존 체크포인트와 DB가 맞는지 확인하고, 어긋나면 영구 동결.
      if (!this.checkpointFrozen && !this.pendingCheckpoint && !this.checkpointMatchesDb()) this.checkpointFrozen = true;
      if (!this.checkpointFrozen) this.pendingCheckpoint = { seq, hash };
      const event = { seq, ts, actor, type, entityId, payload, prevHash, hash };
      // 구독자(대화 투영 등)는 같은 트랜잭션 안에서 돈다: 이벤트가 되돌려지면 투영도 함께 되돌려진다.
      for (const fn of this.eventListeners) fn(event);
      return event;
    });
  }

  private eventListeners: ((e: DomainEvent) => void)[] = [];
  /** 이벤트가 기록될 때마다 부른다. 구독자는 이벤트를 새로 쓰면 안 된다(재귀). */
  onEvent(fn: (e: DomainEvent) => void): void {
    this.eventListeners.push(fn);
  }

  events(entityId?: string, limit = 500): DomainEvent[] {
    const rows = (
      entityId
        ? this.db.prepare('SELECT * FROM events WHERE entity_id = ? ORDER BY seq DESC LIMIT ?').all(entityId, limit)
        : this.db.prepare('SELECT * FROM events ORDER BY seq DESC LIMIT ?').all(limit)
    ) as Row[];
    return rows.reverse().map(toEvent);
  }

  /** 한 종류의 최근 이벤트(최신 먼저). 전권 위임 결정 기록 등. */
  eventsOfType(type: string, limit = 50): DomainEvent[] {
    return (this.db.prepare('SELECT * FROM events WHERE type = ? ORDER BY seq DESC LIMIT ?').all(type, limit) as Row[]).map(toEvent);
  }

  /** 변조 탐지: 모든 이벤트의 해시를 다시 계산한다. */
  verifyEventChain(): { ok: true; count: number } | { ok: false; brokenAt: number; reason: string } {
    let prev = GENESIS_HASH;
    let count = 0;
    for (const row of this.db.prepare('SELECT * FROM events ORDER BY seq').iterate() as Iterable<Row>) {
      const e = toEvent(row);
      if (e.prevHash !== prev) return { ok: false, brokenAt: e.seq, reason: '이전 해시 불일치(삭제 또는 삽입)' };
      const expected = eventHash(e.prevHash, e.seq, e.ts, e.actor, e.type, e.entityId, String(row.payload));
      if (expected !== e.hash) return { ok: false, brokenAt: e.seq, reason: '내용 해시 불일치(수정)' };
      prev = e.hash;
      count++;
    }
    const cp = this.readCheckpoint();
    if (cp && cp.seq > count) return { ok: false, brokenAt: count + 1, reason: `로그 끝부분 삭제(체크포인트 #${cp.seq}, DB #${count})` };
    if (cp && !this.checkpointMatchesDb())
      return { ok: false, brokenAt: cp.seq, reason: `이벤트 #${cp.seq}가 체크포인트와 다름(삭제 후 다시 쓰였을 수 있음)` };
    if (this.checkpointError) return { ok: false, brokenAt: count, reason: `체크포인트를 쓰지 못했습니다: ${this.checkpointError}` };
    return { ok: true, count };
  }
}

function toEvent(row: Row): DomainEvent {
  return {
    seq: Number(row.seq),
    ts: String(row.ts),
    actor: String(row.actor),
    type: String(row.type),
    entityId: String(row.entity_id),
    payload: JSON.parse(String(row.payload)),
    prevHash: String(row.prev_hash),
    hash: String(row.hash),
  };
}

function eventHash(prevHash: string, seq: number, ts: string, actor: string, type: string, entityId: string, payloadJson: string): string {
  return createHash('sha256').update([prevHash, seq, ts, actor, type, entityId, payloadJson].join('\u001f')).digest('hex');
}

/** 키 순서를 고정한 JSON. 해시가 직렬화 순서에 흔들리지 않게 한다. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as object)
        .sort()
        .map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { digest } from "../shared/protocol";

export class Store {
  db: DatabaseSync;
  constructor(path: string) {
    if (path !== ":memory:")
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS objects(kind TEXT, id TEXT, data TEXT NOT NULL, PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS nonces(id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS usage(id TEXT PRIMARY KEY,count INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT NOT NULL, hash TEXT NOT NULL);`);
  }
  get<T>(kind: string, id: string): T | undefined {
    const row = this.db
      .prepare("SELECT data FROM objects WHERE kind=? AND id=?")
      .get(kind, id);
    return row ? JSON.parse(String(row.data)) : undefined;
  }
  all<T>(kind: string): T[] {
    return this.db
      .prepare("SELECT data FROM objects WHERE kind=? ORDER BY rowid")
      .all(kind)
      .map((r) => JSON.parse(String(r.data)));
  }
  put(kind: string, id: string, value: unknown) {
    this.db
      .prepare(
        "INSERT INTO objects VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data",
      )
      .run(kind, id, JSON.stringify(value));
  }
  once(nonce: string) {
    if (this.db.prepare("SELECT id FROM nonces WHERE id=?").get(nonce))
      throw new Error("REPLAY");
    this.db.prepare("INSERT INTO nonces VALUES(?)").run(nonce);
  }
  used(id: string) {
    return Number(
      this.db.prepare("SELECT count FROM usage WHERE id=?").get(id)?.count ?? 0,
    );
  }
  increment(id: string) {
    this.db
      .prepare(
        "INSERT INTO usage VALUES(?,1) ON CONFLICT(id) DO UPDATE SET count=count+1",
      )
      .run(id);
  }
  atomic<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const r = fn();
      this.db.exec("COMMIT");
      return r;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  event(type: string, detail: Record<string, unknown>) {
    const previous = String(
      this.db.prepare("SELECT hash FROM events ORDER BY seq DESC LIMIT 1").get()
        ?.hash ?? "genesis",
    );
    const data = { at: new Date().toISOString(), type, ...detail, previous };
    const hash = digest(data);
    this.db
      .prepare("INSERT INTO events(data,hash) VALUES(?,?)")
      .run(JSON.stringify(data), hash);
  }
  events() {
    return this.db
      .prepare("SELECT seq,data,hash FROM events ORDER BY seq DESC LIMIT 100")
      .all()
      .map((r) => ({
        ...JSON.parse(String(r.data)),
        seq: r.seq,
        hash: r.hash,
      }));
  }
}

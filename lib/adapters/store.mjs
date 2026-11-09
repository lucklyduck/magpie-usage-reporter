import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { AppError } from "../domain/errors.mjs";
export class SQLiteRepository {
  constructor(path) {
    if (path !== ":memory:")
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path, { create: true });
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;",
    );
    const version = this.db.query("PRAGMA user_version").get().user_version;
    if (version > 1) throw new Error("数据库由较新版本创建，请升级插件");
    if (version < 1)
      this.db.transaction(() => {
        this.db
          .exec(`CREATE TABLE entities(kind TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL,json TEXT NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(kind,id));
      CREATE TABLE jobs(id TEXT PRIMARY KEY,execution_key TEXT UNIQUE NOT NULL,subscription_id TEXT NOT NULL,status TEXT NOT NULL,next_at INTEGER NOT NULL,json TEXT NOT NULL,updated_at INTEGER NOT NULL);
      CREATE INDEX jobs_due ON jobs(status,next_at);CREATE INDEX jobs_subscription ON jobs(subscription_id,status);
      CREATE TABLE leases(name TEXT PRIMARY KEY,owner TEXT NOT NULL,until_at INTEGER NOT NULL);
      CREATE TABLE runtime(id TEXT PRIMARY KEY,json TEXT NOT NULL);PRAGMA user_version=1;`);
      })();
  }
  get(kind, id) {
    const row = this.db
      .query("SELECT json FROM entities WHERE kind=? AND id=?")
      .get(kind, id);
    return row ? JSON.parse(row.json) : null;
  }
  list(kind) {
    return this.db
      .query("SELECT json FROM entities WHERE kind=? ORDER BY updated_at DESC")
      .all(kind)
      .map((r) => JSON.parse(r.json));
  }
  put(kind, value, expectedRevision) {
    return this.db.transaction(() => {
      const id = value.id || randomUUID(),
        old = this.get(kind, id);
      if (old && expectedRevision !== old.revision)
        throw new AppError(
          "配置已被其他页面修改，请刷新后重试",
          409,
          "revision_conflict",
        );
      if (!old && expectedRevision != null)
        throw new AppError("配置已删除", 409, "revision_conflict");
      const v = {
        ...value,
        id,
        revision: (old?.revision || 0) + 1,
        updatedAt: new Date().toISOString(),
      };
      this.db
        .query(
          "INSERT INTO entities VALUES(?,?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET revision=excluded.revision,json=excluded.json,updated_at=excluded.updated_at",
        )
        .run(kind, id, v.revision, JSON.stringify(v), Date.now());
      return v;
    })();
  }
  remove(kind, id) {
    this.db.query("DELETE FROM entities WHERE kind=? AND id=?").run(kind, id);
  }
  runtime(id, value) {
    if (arguments.length === 1) {
      const r = this.db.query("SELECT json FROM runtime WHERE id=?").get(id);
      return r ? JSON.parse(r.json) : null;
    }
    this.db
      .query(
        "INSERT INTO runtime VALUES(?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json",
      )
      .run(id, JSON.stringify(value));
  }
  createJob(job) {
    const value = {
      id: randomUUID(),
      status: "pending",
      nextAt: Date.now(),
      ...job,
    };
    this.db
      .query("INSERT OR IGNORE INTO jobs VALUES(?,?,?,?,?,?,?)")
      .run(
        value.id,
        value.executionKey,
        value.subscriptionId || "",
        value.status,
        value.nextAt,
        JSON.stringify(value),
        Date.now(),
      );
    return this.db
      .query("SELECT json FROM jobs WHERE execution_key=?")
      .get(value.executionKey)
      ? JSON.parse(
          this.db
            .query("SELECT json FROM jobs WHERE execution_key=?")
            .get(value.executionKey).json,
        )
      : null;
  }
  getJob(id) {
    const r = this.db.query("SELECT json FROM jobs WHERE id=?").get(id);
    return r ? JSON.parse(r.json) : null;
  }
  saveJob(job) {
    this.db
      .query(
        "UPDATE jobs SET status=?,next_at=?,json=?,updated_at=? WHERE id=?",
      )
      .run(job.status, job.nextAt, JSON.stringify(job), Date.now(), job.id);
    return job;
  }
  jobs({ limit = 100, subscriptionId, status, due } = {}) {
    const clauses = [],
      args = [];
    if (subscriptionId) {
      clauses.push("subscription_id=?");
      args.push(subscriptionId);
    }
    if (status) {
      clauses.push("status=?");
      args.push(status);
    }
    if (due != null) {
      clauses.push("status IN ('pending','waiting','building') AND next_at<=?");
      args.push(due);
    }
    args.push(Math.min(Math.max(Number(limit) || 100, 1), 1000));
    return this.db
      .query(
        "SELECT json FROM jobs" +
          (clauses.length ? " WHERE " + clauses.join(" AND ") : "") +
          " ORDER BY updated_at DESC LIMIT ?",
      )
      .all(...args)
      .map((r) => JSON.parse(r.json));
  }
  active(subscriptionId) {
    return Boolean(
      this.db
        .query(
          "SELECT 1 FROM jobs WHERE subscription_id=? AND status IN ('pending','waiting','building','sending','unknown','partial') LIMIT 1",
        )
        .get(subscriptionId),
    );
  }
  cancelJobs(subscriptionId) {
    for (const job of this.jobs({ subscriptionId, limit: 1000 })) {
      if (["pending", "waiting", "building"].includes(job.status)) {
        job.status = "canceled";
        job.lastError = "订阅已暂停或删除";
        this.saveJob(job);
      } else if (job.status === "sending") {
        job.cancelRequested = true;
        this.saveJob(job);
      }
    }
  }
  lease(name, owner, now, ttl = 60000) {
    return this.db.transaction(() => {
      const old = this.db.query("SELECT * FROM leases WHERE name=?").get(name);
      if (old && old.owner !== owner && old.until_at > now) return false;
      this.db
        .query(
          "INSERT INTO leases VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET owner=excluded.owner,until_at=excluded.until_at",
        )
        .run(name, owner, now + ttl);
      return true;
    })();
  }
  owns(name, owner, now) {
    const r = this.db.query("SELECT * FROM leases WHERE name=?").get(name);
    return Boolean(r && r.owner === owner && r.until_at > now);
  }
  release(name, owner) {
    this.db
      .query("DELETE FROM leases WHERE name=? AND owner=?")
      .run(name, owner);
  }
  recover() {
    for (const job of this.jobs({ limit: 1000 })) {
      if (job.status === "sending") {
        job.status = "unknown";
        job.lastError = "宿主在发送确认前退出，投递结果未知";
        job.events.push({ at: Date.now(), message: job.lastError });
        this.saveJob(job);
      } else if (job.status === "building") {
        job.status = "pending";
        this.saveJob(job);
      }
    }
  }
  prune(days, now) {
    this.db
      .query(
        "DELETE FROM jobs WHERE status IN ('sent','failed','skipped','canceled') AND updated_at<?",
      )
      .run(now - days * 86400000);
  }
  close() {
    this.db.close();
  }
}

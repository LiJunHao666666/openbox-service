'use strict';
/**
 * 数据访问层 · 连接与迁移
 *
 *  - 使用 Node 内置 node:sqlite（零依赖），文件落在 config.dataDir。
 *  - 所有结构变更都走「有序迁移」：每次启动检查 schema_migrations，
 *    只跑没跑过的版本号，并且整个迁移包在一个事务里 —— 失败即整体回滚。
 *  - 开启 WAL 与外键约束；写操作统一通过 withTransaction 保证原子性。
 */

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { config } = require('./config');
const { logger } = require('./logger');

let db = null;

/* ------------------------------------------------------------------
 * 迁移定义：只增不改。已发布的迁移永远不要回头去改它。
 * ------------------------------------------------------------------ */
const MIGRATIONS = [
  {
    version: 1,
    name: 'init_orders_and_admin',
    up: (d) => {
      d.exec(`
        CREATE TABLE orders (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          order_no    TEXT    NOT NULL UNIQUE,
          os          TEXT    NOT NULL,
          level       TEXT    NOT NULL DEFAULT '',
          contact     TEXT    NOT NULL,
          note        TEXT    NOT NULL DEFAULT '',
          tools       TEXT    NOT NULL DEFAULT '[]',
          tool_count  INTEGER NOT NULL DEFAULT 0,
          total_mins  INTEGER NOT NULL DEFAULT 0,
          has_gpu     INTEGER NOT NULL DEFAULT 0,
          plan        TEXT    NOT NULL,
          price       INTEGER NOT NULL,
          status      TEXT    NOT NULL DEFAULT 'pending',
          created_at  TEXT    NOT NULL,
          updated_at  TEXT    NOT NULL,
          status_at   TEXT,
          client_ip   TEXT    NOT NULL DEFAULT ''
        )
      `);
      d.exec('CREATE INDEX idx_orders_status  ON orders(status)');
      d.exec('CREATE INDEX idx_orders_created ON orders(created_at DESC)');
      d.exec('CREATE INDEX idx_orders_contact ON orders(contact)');

      d.exec(`
        CREATE TABLE sessions (
          token_hash TEXT PRIMARY KEY,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          label      TEXT NOT NULL DEFAULT ''
        )
      `);
      d.exec('CREATE INDEX idx_sessions_expires ON sessions(expires_at)');

      d.exec(`
        CREATE TABLE settings (
          key        TEXT PRIMARY KEY,
          value      TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `);
    },
  },
  {
    version: 2,
    name: 'order_status_audit',
    up: (d) => {
      /* 状态流转留痕，便于复盘与对账 */
      d.exec(`
        CREATE TABLE order_events (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          order_id   INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
          from_status TEXT,
          to_status  TEXT NOT NULL,
          note       TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL
        )
      `);
      d.exec('CREATE INDEX idx_events_order ON order_events(order_id)');
    },
  },
];

/* ------------------------------------------------------------------
 * 打开连接
 * ------------------------------------------------------------------ */
function open() {
  if (db) return db;
  fs.mkdirSync(config.dataDir, { recursive: true });
  const file = path.join(config.dataDir, 'openbox.db');

  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');

  runMigrations(db);
  logger.info('数据库已就绪', { file: path.relative(config.root, file) });
  return db;
}

function get() {
  if (!db) throw new Error('数据库尚未初始化，请先调用 db.open()');
  return db;
}

/* ------------------------------------------------------------------
 * 迁移执行器
 * ------------------------------------------------------------------ */
function runMigrations(d) {
  d.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);
  const applied = new Set(d.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version));

  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    d.exec('BEGIN IMMEDIATE');
    try {
      m.up(d);
      d.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
        .run(m.version, m.name, new Date().toISOString());
      d.exec('COMMIT');
      logger.info('迁移已应用', { version: m.version, name: m.name });
    } catch (err) {
      d.exec('ROLLBACK');
      logger.error('迁移失败，已回滚', { version: m.version, name: m.name, err: logger.serializeError(err) });
      throw err;
    }
  }
}

/* ------------------------------------------------------------------
 * 事务
 * ------------------------------------------------------------------ */
function withTransaction(fn) {
  const d = get();
  d.exec('BEGIN IMMEDIATE');
  try {
    const result = fn(d);
    d.exec('COMMIT');
    return result;
  } catch (err) {
    try { d.exec('ROLLBACK'); } catch { /* 回滚失败时保留原始错误 */ }
    throw err;
  }
}

function close() {
  if (!db) return;
  try { db.exec('PRAGMA optimize'); } catch { /* 忽略 */ }
  db.close();
  db = null;
}

/** 供 /ready 健康检查使用 */
function ping() {
  try {
    get().prepare('SELECT 1 AS ok').get();
    return true;
  } catch {
    return false;
  }
}

module.exports = { open, get, close, ping, withTransaction, MIGRATIONS };

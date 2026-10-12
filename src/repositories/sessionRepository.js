'use strict';
/**
 * 仓储层 · 会话与设置
 *
 * 会话令牌只存 SHA-256 哈希，明文永远不落库 —— 数据库泄露也无法直接冒用。
 */

const crypto = require('node:crypto');
const { get } = require('../db');

function sha256(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

/* ------------------------------ 会话 ------------------------------ */

function createSession(token, ttlHours, label = '') {
  const now = new Date();
  const expires = new Date(now.getTime() + ttlHours * 3600 * 1000);
  get().prepare('INSERT INTO sessions (token_hash, created_at, expires_at, label) VALUES (?, ?, ?, ?)')
    .run(sha256(token), now.toISOString(), expires.toISOString(), label);
  return expires;
}

/** 校验令牌；过期则顺手删除并返回 null */
function findValidSession(token) {
  if (!token) return null;
  const hash = sha256(token);
  const row = get().prepare('SELECT * FROM sessions WHERE token_hash = ?').get(hash);
  if (!row) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    get().prepare('DELETE FROM sessions WHERE token_hash = ?').run(hash);
    return null;
  }
  return { expiresAt: row.expires_at, createdAt: row.created_at };
}

function destroySession(token) {
  if (!token) return 0;
  return get().prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token)).changes;
}

/** 清理过期会话，返回删除条数 */
function purgeExpiredSessions() {
  return get().prepare('DELETE FROM sessions WHERE expires_at <= ?').run(new Date().toISOString()).changes;
}

/* ------------------------------ 设置 ------------------------------ */

function getSetting(key) {
  const row = get().prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setSetting(key, value) {
  get().prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, value, new Date().toISOString());
}

module.exports = {
  createSession,
  findValidSession,
  destroySession,
  purgeExpiredSessions,
  getSetting,
  setSetting,
};

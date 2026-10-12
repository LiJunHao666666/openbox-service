'use strict';
/**
 * 服务层 · 后台鉴权
 *
 * 安全设计：
 *  - 口令用 scrypt + 随机盐做哈希，比较用 timingSafeEqual，防时序侧信道。
 *  - 会话令牌为 32 字节随机值，数据库只存 SHA-256 哈希，明文只在响应体里出现一次。
 *  - 未配置 ADMIN_PASSWORD 时自动生成一次性强口令并持久化哈希，
 *    明文只在启动日志里打印一次 —— 重启不会变，避免每次都要重新找密码。
 */

const crypto = require('node:crypto');
const { config } = require('../config');
const sessionRepo = require('../repositories/sessionRepository');
const { UnauthorizedError } = require('../errors');
const { logger } = require('../logger');

const KEY_HASH = 'admin_password_hash';

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

function hashPassword(plain) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(plain, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(plain, stored) {
  try {
    const [scheme, N, r, p, saltHex, hashHex] = String(stored).split('$');
    if (scheme !== 'scrypt') return false;
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(hashHex, 'hex');
    const actual = crypto.scryptSync(plain, salt, expected.length, { N: Number(N), r: Number(r), p: Number(p) });
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** 生成一个既强又便于口述的随机口令 */
function generatePassword() {
  const words = ['harbor', 'lantern', 'meadow', 'copper', 'velvet', 'cinder', 'willow', 'quartz'];
  const w = words[crypto.randomInt(words.length)];
  const n = String(crypto.randomInt(1000, 9999));
  return `${w}-${n}`;
}

let generatedPlain = null;

/**
 * 启动时调用：决定后台口令来源，并把哈希准备好。
 * @returns {{ generated: boolean, plain: string|null }}
 */
function initAdminPassword() {
  if (config.adminPassword) {
    sessionRepo.setSetting(KEY_HASH, hashPassword(config.adminPassword));
    logger.info('后台口令已从环境变量 ADMIN_PASSWORD 载入');
    return { generated: false, plain: null };
  }

  const existing = sessionRepo.getSetting(KEY_HASH);
  if (existing) {
    logger.info('后台口令已从数据库载入（未设置 ADMIN_PASSWORD，使用首次启动时生成的密码）');
    return { generated: false, plain: null };
  }

  const plain = generatePassword();
  sessionRepo.setSetting(KEY_HASH, hashPassword(plain));
  generatedPlain = plain;
  logger.warn('未设置 ADMIN_PASSWORD，已自动生成后台口令并持久化');
  return { generated: true, plain };
}

/** 校验口令并签发会话 */
function login(password, meta = {}) {
  const stored = sessionRepo.getSetting(KEY_HASH);
  if (!stored) throw new UnauthorizedError('后台口令尚未初始化');

  if (typeof password !== 'string' || !password) {
    throw new UnauthorizedError('请输入后台口令');
  }
  if (!verifyPassword(password, stored)) {
    logger.warn('后台登录失败：口令不正确', { ip: meta.clientIp });
    throw new UnauthorizedError('口令不正确');
  }

  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = sessionRepo.createSession(token, config.sessionTtlHours, String(meta.clientIp || '').slice(0, 64));

  sessionRepo.purgeExpiredSessions();
  logger.info('后台登录成功', { expiresAt: expiresAt.toISOString(), ip: meta.clientIp });

  return { token, expiresAt: expiresAt.toISOString() };
}

/** 从 Authorization: Bearer <token> 中解析并校验会话 */
function authenticate(headerValue) {
  if (typeof headerValue !== 'string') throw new UnauthorizedError();
  const m = /^Bearer\s+(.+)$/i.exec(headerValue.trim());
  if (!m) throw new UnauthorizedError();
  const session = sessionRepo.findValidSession(m[1]);
  if (!session) throw new UnauthorizedError();
  return { token: m[1], expiresAt: session.expiresAt };
}

function logout(headerValue) {
  if (typeof headerValue !== 'string') return 0;
  const m = /^Bearer\s+(.+)$/i.exec(headerValue.trim());
  if (!m) return 0;
  const n = sessionRepo.destroySession(m[1]);
  logger.info('后台已登出', { removed: n });
  return n;
}

module.exports = { initAdminPassword, login, authenticate, logout, generatePassword, hashPassword, verifyPassword };

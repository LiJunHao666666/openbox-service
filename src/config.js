'use strict';
/**
 * 配置层 —— 所有配置集中在此，启动时一次性校验，任何缺失立刻失败退出。
 * 严禁在业务代码里直接读 process.env。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');

/* ------------------------------------------------------------------
 * 极简 .env 解析（不引第三方依赖）
 * ------------------------------------------------------------------ */
function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  const raw = fs.readFileSync(file, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const eq = s.indexOf('=');
    if (eq === -1) continue;
    const key = s.slice(0, eq).trim();
    let val = s.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}
loadDotEnv(path.join(ROOT, '.env'));

/* ------------------------------------------------------------------
 * 读取与校验
 * ------------------------------------------------------------------ */
const problems = [];

function str(key, fallback) {
  const v = process.env[key];
  return v === undefined || v === '' ? fallback : String(v).trim();
}
function num(key, fallback, { min, max } = {}) {
  const raw = str(key, undefined);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    problems.push(`${key} 必须是数字，当前为 "${raw}"`);
    return fallback;
  }
  if (min !== undefined && n < min) problems.push(`${key} 不能小于 ${min}，当前为 ${n}`);
  if (max !== undefined && n > max) problems.push(`${key} 不能大于 ${max}，当前为 ${n}`);
  return n;
}
function oneOf(key, fallback, allowed) {
  const v = str(key, fallback);
  if (!allowed.includes(v)) {
    problems.push(`${key} 只能是 ${allowed.join(' / ')} 之一，当前为 "${v}"`);
    return fallback;
  }
  return v;
}

const env = oneOf('NODE_ENV', 'development', ['development', 'production', 'test']);
const isProd = env === 'production';

const config = {
  root: ROOT,
  env,
  isProd,
  port: num('PORT', 8788, { min: 1, max: 65535 }),
  host: str('HOST', '127.0.0.1'),

  dataDir: path.resolve(ROOT, str('DATA_DIR', './data')),
  publicDir: ROOT,

  logLevel: oneOf('LOG_LEVEL', 'info', ['debug', 'info', 'warn', 'error']),

  adminPassword: str('ADMIN_PASSWORD', ''),
  sessionSecret: str('SESSION_SECRET', ''),
  sessionTtlHours: num('SESSION_TTL_HOURS', 12, { min: 1, max: 24 * 30 }),

  allowedOrigins: str('ALLOWED_ORIGINS', '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  rate: {
    orderMax: num('ORDER_RATE_MAX', 20, { min: 1, max: 1000 }),
    orderWindowSec: num('ORDER_RATE_WINDOW_SEC', 600, { min: 10, max: 86400 }),
    loginMax: num('LOGIN_RATE_MAX', 10, { min: 1, max: 1000 }),
    loginWindowSec: num('LOGIN_RATE_WINDOW_SEC', 600, { min: 10, max: 86400 }),
  },

  trustProxyHops: num('TRUST_PROXY_HOPS', 0, { min: 0, max: 5 }),

  /* 内测横幅：off 时落地页完全不显示，正式对外前改成 off 即可 */
  beta: {
    on: oneOf('BETA_MODE', 'off', ['on', 'off']) === 'on',
    note: str('BETA_NOTE', '内测版 · 服务还在打磨，有问题请联系我们'),
  },
};

/* ------------------------------------------------------------------
 * 生产环境的强约束 —— 快速失败，绝不带着默认密钥上线
 * ------------------------------------------------------------------ */
if (isProd) {
  if (!config.adminPassword) {
    problems.push('production 环境必须显式设置 ADMIN_PASSWORD');
  } else if (config.adminPassword.length < 10) {
    problems.push('production 环境的 ADMIN_PASSWORD 至少 10 位');
  }
  if (!config.sessionSecret) {
    problems.push('production 环境必须显式设置 SESSION_SECRET');
  } else if (config.sessionSecret.length < 32) {
    problems.push('production 环境的 SESSION_SECRET 至少 32 字符');
  }
  if (config.host === '0.0.0.0' && config.allowedOrigins.length === 0) {
    problems.push('监听 0.0.0.0 时必须显式设置 ALLOWED_ORIGINS，否则可能被任意站点跨域调用');
  }
}

if (problems.length) {
  const msg = ['配置校验未通过，进程已终止：', ...problems.map((p, i) => `  ${i + 1}. ${p}`)].join('\n');
  process.stderr.write(`\n\x1b[31m${msg}\x1b[0m\n\n`);
  process.exit(1);
}

/* 非生产环境：会话密钥允许自动生成（仅本次进程有效） */
const runtimeSecret = config.sessionSecret || crypto.randomBytes(32).toString('hex');

module.exports = { config, runtimeSecret };

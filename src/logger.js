'use strict';
/**
 * 结构化日志。
 *
 *  - 每行一条 JSON，便于日志采集系统直接解析。
 *  - 每条日志自动携带请求上下文（requestId / method / path），由 AsyncLocalStorage 传递，
 *    业务代码不需要把 requestId 一层层往下传。
 *  - 敏感字段（密码、密钥、联系方式原文）在写入前统一脱敏，绝不落盘。
 */

const { AsyncLocalStorage } = require('node:async_hooks');
const { config } = require('./config');

const als = new AsyncLocalStorage();

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[config.logLevel] ?? LEVELS.info;

/** 需要脱敏的字段名（大小写不敏感，含子串匹配） */
const SENSITIVE_KEYS = [
  'password', 'passwd', 'secret', 'token', 'authorization', 'cookie',
  'apikey', 'api_key', 'credential', 'contact', 'phone', 'mobile', 'email', 'wechat', 'qq',
];

function maskValue(v) {
  const s = String(v);
  if (s.length <= 4) return '***';
  return `${s.slice(0, 2)}***${s.slice(-2)}`;
}

/** 递归脱敏：命中的 key 直接替换，长字符串截断 */
function sanitize(input, depth = 0) {
  if (depth > 4) return '[deep]';
  if (input === null || input === undefined) return input;
  if (Array.isArray(input)) return input.slice(0, 20).map((v) => sanitize(v, depth + 1));
  if (typeof input === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(input)) {
      out[k] = SENSITIVE_KEYS.some((s) => k.toLowerCase().includes(s)) ? maskValue(v) : sanitize(v, depth + 1);
    }
    return out;
  }
  if (typeof input === 'string' && input.length > 500) return `${input.slice(0, 500)}…`;
  return input;
}

function write(level, msg, extra) {
  if (LEVELS[level] < threshold) return;
  const ctx = als.getStore() || {};
  const line = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...(ctx.requestId ? { requestId: ctx.requestId } : {}),
    ...(ctx.method ? { method: ctx.method, path: ctx.path } : {}),
    ...(extra ? sanitize(extra) : {}),
  };
  const text = JSON.stringify(line);
  if (LEVELS[level] >= LEVELS.error) process.stderr.write(`${text}\n`);
  else process.stdout.write(`${text}\n`);
}

const logger = {
  debug: (msg, extra) => write('debug', msg, extra),
  info: (msg, extra) => write('info', msg, extra),
  warn: (msg, extra) => write('warn', msg, extra),
  error: (msg, extra) => write('error', msg, extra),

  /** 在某个请求上下文中执行 fn，期间的日志都会带上该请求的 requestId */
  runWithContext(ctx, fn) {
    return als.run(ctx, fn);
  },

  sanitize,

  /** 把任意异常整理成可安全写入日志的结构（保留堆栈，但只在服务端） */
  serializeError(err) {
    if (!err) return null;
    return {
      name: err.name,
      code: err.code,
      message: err.message,
      status: err.status,
      stack: err.stack ? String(err.stack).split('\n').slice(0, 6).join('\n') : undefined,
    };
  },
};

module.exports = { logger };

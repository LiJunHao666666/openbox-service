'use strict';
/**
 * HTTP 层 · 应用装配
 *
 * 管线顺序（不可随意调换）：
 *   requestId → 安全头 → CORS → 路由 → 静态文件 → 404 → 全局错误处理
 *
 * 控制器只做「解析请求 → 调服务 → 格式化响应」，不含任何业务规则；
 * 所有业务异常由 errors.js 的类型化错误统一表达，由最外层 handler 归一化输出。
 */

const http = require('node:http');
const crypto = require('node:crypto');
const { URL } = require('node:url');

const { config, runtimeSecret } = require('../config');
const { logger } = require('../logger');
const { AppError, isAppError, NotFoundError, PayloadTooLargeError, UnauthorizedError } = require('../errors');
const orderService = require('../services/orderService');
const authService = require('../services/authService');
const rateLimit = require('./rateLimit');
const staticFiles = require('./static');
const { TOOLS, CATEGORIES } = require('../domain/toolCatalog');
const { PLANS } = require('../domain/pricing');
const db = require('../db');

const MAX_BODY_BYTES = 64 * 1024;
const startedAt = Date.now();

/* ==================================================================
 * 基础工具
 * ================================================================== */

function json(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

function getClientIp(req) {
  // 只有显式声明代理层数时才信任转发头，否则任何人都能伪造
  if (config.trustProxyHops > 0) {
    const chain = String(req.headers['x-forwarded-for'] || '')
      .split(',').map((s) => s.trim()).filter(Boolean);
    const idx = chain.length - config.trustProxyHops;
    if (idx >= 0 && idx < chain.length) return chain[idx];
  }
  return req.socket.remoteAddress || '';
}

function isLocalOrigin(origin) {
  try {
    const u = new URL(origin);
    return ['127.0.0.1', 'localhost', '::1', '[::1]', '0.0.0.0'].includes(u.hostname);
  } catch {
    return false;
  }
}

/** @returns {object|null} null 表示该来源不允许 */
function corsHeaders(req) {
  const origin = req.headers.origin;
  if (!origin) return {};

  let sameHost = false;
  try {
    sameHost = new URL(origin).host === req.headers.host;
  } catch { sameHost = false; }

  const allowed =
    sameHost ||
    config.allowedOrigins.includes(origin) ||
    (!config.isProd && isLocalOrigin(origin));

  if (!allowed) return null;

  return {
    'Access-Control-Allow-Origin': origin,
    Vary: 'Origin',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Max-Age': '600',
  };
}

async function readJsonBody(req) {
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > MAX_BODY_BYTES) throw new PayloadTooLargeError();

  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new PayloadTooLargeError();
    chunks.push(chunk);
  }
  if (size === 0) return {};

  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};

  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object') {
      throw new Error('not an object');
    }
    return parsed;
  } catch {
    throw new AppError('BAD_JSON', '提交的数据格式不正确', { status: 400 });
  }
}

function requireAuth(req) {
  return authService.authenticate(req.headers.authorization);
}

/* ==================================================================
 * 路由表
 * ================================================================== */

const routes = [
  /* ---------------- 健康检查 ---------------- */
  {
    method: 'GET', path: '/health', auth: false,
    handler: () => ({ status: 200, body: { ok: true, uptimeSec: Math.round((Date.now() - startedAt) / 1000) } }),
  },
  {
    method: 'GET', path: '/ready', auth: false,
    handler: async () => {
      const ready = db.ping();
      return {
        status: ready ? 200 : 503,
        body: { ok: ready, db: ready ? 'up' : 'down' },
      };
    },
  },

  /* ---------------- 公开：工具目录与定价（前端可用来对齐） ---------------- */
  {
    method: 'GET', path: '/api/catalog', auth: false,
    handler: () => ({
      status: 200,
      body: {
        categories: CATEGORIES,
        tools: TOOLS.map((t) => ({ id: t.id, name: t.name, cat: t.cat, mins: t.mins, need: t.need })),
        plans: PLANS.map((p) => ({ name: p.name, price: p.price })),
      },
    }),
  },

  /* ---------------- 公开：站点运行时配置（前端可用来对齐） ---------------- */
  {
    method: 'GET', path: '/api/site-config', auth: false,
    handler: () => ({
      status: 200,
      body: {
        ok: true,
        /* 只暴露可以公开的东西：是否内测、内测提示语。不含任何密钥或内部状态 */
        beta: config.beta.on ? { on: true, note: config.beta.note } : { on: false },
      },
    }),
  },

  /* ---------------- 公开：提交预约单 ---------------- */
  {
    method: 'POST', path: '/api/orders', auth: false,
    handler: async (req, res, ctx) => {
      rateLimit.check(
        `order:${ctx.clientIp}`,
        config.rate.orderMax,
        config.rate.orderWindowSec,
      );
      const body = await readJsonBody(req);
      const order = orderService.createOrder(body, { clientIp: ctx.clientIp });

      // 只回可以公开的字段：不回 clientIp、不回内部事件
      return {
        status: 201,
        body: {
          ok: true,
          order: {
            orderNo: order.orderNo,
            os: order.os,
            level: order.level,
            toolCount: order.toolCount,
            totalMins: order.totalMins,
            hasGpu: order.hasGpu,
            plan: order.plan,
            price: order.price,
            status: order.status,
            createdAt: order.createdAt,
            tools: order.tools.map((t) => ({ id: t.id, name: t.name })),
          },
        },
      };
    },
  },

  /* ---------------- 鉴权 ---------------- */
  {
    method: 'POST', path: '/api/auth/login', auth: false,
    handler: async (req, res, ctx) => {
      rateLimit.check(
        `login:${ctx.clientIp}`,
        config.rate.loginMax,
        config.rate.loginWindowSec,
      );
      const body = await readJsonBody(req);
      const result = authService.login(body.password, { clientIp: ctx.clientIp });
      return { status: 200, body: { ok: true, token: result.token, expiresAt: result.expiresAt } };
    },
  },
  {
    method: 'POST', path: '/api/auth/logout', auth: true,
    handler: (req) => {
      authService.logout(req.headers.authorization);
      return { status: 200, body: { ok: true } };
    },
  },
  {
    method: 'GET', path: '/api/auth/me', auth: true,
    handler: (req, res, ctx) => ({
      status: 200,
      body: { ok: true, expiresAt: ctx.session.expiresAt },
    }),
  },

  /* ---------------- 鉴权：后台订单管理 ---------------- */
  {
    method: 'GET', path: '/api/orders', auth: true,
    handler: (req) => {
      const url = new URL(req.url, 'http://localhost');
      const result = orderService.listOrders({
        status: url.searchParams.get('status') || undefined,
        keyword: url.searchParams.get('keyword') || undefined,
        page: url.searchParams.get('page') || 1,
        pageSize: url.searchParams.get('pageSize') || 30,
      });
      return { status: 200, body: { ok: true, ...result } };
    },
  },
  {
    method: 'GET', path: '/api/orders/:id', auth: true,
    handler: (req, res, ctx) => ({
      status: 200,
      body: { ok: true, order: orderService.getOrder(ctx.params.id) },
    }),
  },
  {
    method: 'PATCH', path: '/api/orders/:id', auth: true,
    handler: async (req, res, ctx) => {
      const body = await readJsonBody(req);
      const order = orderService.changeStatus(ctx.params.id, body.status, body.note);
      return { status: 200, body: { ok: true, order } };
    },
  },
  {
    method: 'GET', path: '/api/stats', auth: true,
    handler: () => ({ status: 200, body: { ok: true, stats: orderService.getStats() } }),
  },
];

/** 把 '/api/orders/:id' 编译成正则；返回 null 表示不匹配 */
function matchPath(pattern, pathname) {
  const pp = pattern.split('/').filter(Boolean);
  const ap = pathname.split('/').filter(Boolean);
  if (pp.length !== ap.length) return null;

  const params = {};
  for (let i = 0; i < pp.length; i++) {
    if (pp[i].startsWith(':')) {
      params[pp[i].slice(1)] = decodeURIComponent(ap[i]);
    } else if (pp[i] !== ap[i]) {
      return null;
    }
  }
  return params;
}

/* ==================================================================
 * 主处理流程
 * ================================================================== */

async function dispatch(req, res, ctx) {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;

  /* ---- 预检 ---- */
  if (req.method === 'OPTIONS') {
    const cors = corsHeaders(req);
    if (cors === null) return json(res, 403, { error: { code: 'ORIGIN_NOT_ALLOWED', message: '来源不被允许' } });
    res.writeHead(204, cors);
    return res.end();
  }

  /* ---- 显式路由（含 /health、/ready 与 /api/**） ---- */
  for (const route of routes) {
    if (route.method !== req.method) continue;
    const params = matchPath(route.path, pathname);
    if (!params) continue;

    ctx.params = params;
    if (route.auth) {
      ctx.session = requireAuth(req);
    }

    const out = await route.handler(req, res, ctx);
    return json(res, out.status || 200, out.body);
  }

  /* ---- 落在 /api 下但没匹配到任何路由 → 明确报接口不存在 ---- */
  if (pathname === '/api' || pathname.startsWith('/api/')) {
    throw new NotFoundError('接口不存在');
  }

  /* ---- 静态文件 ---- */
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    throw new NotFoundError('资源不存在');
  }
  if (staticFiles.send(req, res, pathname)) return;

  throw new NotFoundError('页面不存在');
}

/**
 * 创建 HTTP 服务（未开始监听）
 */
function createServer() {
  return http.createServer((req, res) => {
    const requestId = crypto.randomUUID();
    const started = Date.now();
    const ctx = {
      requestId,
      method: req.method,
      path: (req.url || '/').split('?')[0],
      clientIp: getClientIp(req),
    };

    logger.runWithContext(ctx, () => {
      /* 安全响应头 */
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Frame-Options', 'SAMEORIGIN');
      res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

      /* CORS：不允许的来源直接拒绝 API 调用 */
      const cors = corsHeaders(req);
      if (cors === null) {
        logger.warn('拒绝了非白名单来源的请求');
        return json(res, 403, { error: { code: 'ORIGIN_NOT_ALLOWED', message: '来源不被允许' } });
      }
      for (const [k, v] of Object.entries(cors)) res.setHeader(k, v);

      res.on('finish', () => {
        logger.info('请求完成', {
          status: res.statusCode,
          ms: Date.now() - started,
        });
      });

      dispatch(req, res, ctx).catch((err) => handleError(err, req, res, ctx));
    });
  });
}

/* ==================================================================
 * 全局错误处理
 * ================================================================== */

function handleError(err, req, res, ctx) {
  if (res.headersSent) {
    logger.error('响应已开始发送，无法再写入错误体', { err: logger.serializeError(err) });
    return res.destroy();
  }

  if (isAppError(err)) {
    // 预期内的失败：记录但降级为 warn（4xx 不是服务故障）
    const level = err.status >= 500 ? 'error' : 'warn';
    logger[level]('业务异常', { code: err.code, status: err.status, err: err.message, details: err.details });

    const headers = {};
    if (err instanceof AppError && err.retryAfterSec) headers['Retry-After'] = String(err.retryAfterSec);

    return json(res, err.status, {
      error: {
        code: err.code,
        message: err.expose ? err.message : '请求处理失败',
        ...(err.fields ? { fields: err.fields } : {}),
      },
    }, headers);
  }

  // 非预期异常：日志里留全堆栈，客户端只看到一句通用文案
  logger.error('未处理的服务端异常', { err: logger.serializeError(err) });
  const message = config.isProd
    ? '服务器开小差了，请稍后再试'
    : `服务器错误：${err && err.message ? err.message : 'unknown'}`;
  return json(res, 500, { error: { code: 'INTERNAL_ERROR', message } });
}

module.exports = { createServer, routes, MAX_BODY_BYTES };

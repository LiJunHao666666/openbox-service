'use strict';
/**
 * 服务层 · 订单
 *
 * 承载业务规则与编排，不依赖任何 HTTP 对象（不碰 req / res）。
 * 关键职责：
 *   1. 用服务端权威目录重算套餐与价格（绝不采信客户端金额）
 *   2. 生成不易碰撞的人类可读单号
 *   3. 状态机流转校验
 */

const crypto = require('node:crypto');
const repo = require('../repositories/orderRepository');
const { quote } = require('../domain/pricing');
const { MAX_TOOLS } = require('../domain/toolCatalog');
const { ValidationError, NotFoundError, ConflictError } = require('../errors');
const { logger } = require('../logger');

const STATUS = {
  pending: '待接单',
  taken: '已接单',
  done: '已完成',
  canceled: '已取消',
};

/** 允许的状态流转：从 → 可去的状态 */
const TRANSITIONS = {
  pending: ['taken', 'canceled'],
  taken: ['done', 'canceled'],
  done: [],
  canceled: [],
};

const MAX_CONTACT_LEN = 60;
const MAX_NOTE_LEN = 500;
const MAX_OS_LEN = 20;
const MAX_LEVEL_LEN = 30;

/**
 * 生成单号：OB-YYYYMMDD-XXXX（4 位 base32 随机），碰撞则重试。
 */
function generateOrderNo(now) {
  const day = now.toISOString().slice(0, 10).replace(/-/g, '');
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // 去掉易混的 I L O 0 1
  for (let attempt = 0; attempt < 12; attempt++) {
    const bytes = crypto.randomBytes(4);
    let suffix = '';
    for (let i = 0; i < 4; i++) suffix += alphabet[bytes[i] % alphabet.length];
    const no = `OB-${day}-${suffix}`;
    if (!repo.orderNoExists(no)) return no;
  }
  // 极端兜底：用时间戳保证唯一
  return `OB-${day}-${Date.now().toString(36).toUpperCase().slice(-5)}`;
}

function cleanText(v, max, field, label, { required = false } = {}) {
  if (v === undefined || v === null) v = '';
  if (typeof v !== 'string') {
    throw new ValidationError(`${label}格式不正确`, [{ field, message: '必须是文本' }]);
  }
  // 去掉控制字符与多余空白，避免注入奇怪的不可见字符
  const s = v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (required && !s) {
    throw new ValidationError(`请填写${label}`, [{ field, message: '不能为空' }]);
  }
  if (s.length > max) {
    throw new ValidationError(`${label}太长了，最多 ${max} 个字`, [{ field, message: `超过 ${max} 字` }]);
  }
  return s;
}

/**
 * 创建订单。
 * @param {object} input 客户端原始输入
 * @param {object} meta  { clientIp }
 */
function createOrder(input, meta = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError('提交内容格式不正确');
  }

  const os = cleanText(input.os, MAX_OS_LEN, 'os', '电脑系统', { required: true });
  if (!['Windows', 'macOS'].includes(os)) {
    throw new ValidationError('电脑系统只能是 Windows 或 macOS', [{ field: 'os', message: '取值不合法' }]);
  }

  const level = cleanText(input.level, MAX_LEVEL_LEN, 'level', '电脑基础');
  const contact = cleanText(input.contact, MAX_CONTACT_LEN, 'contact', '联系方式', { required: true });
  if (contact.length < 2) {
    throw new ValidationError('联系方式太短了', [{ field: 'contact', message: '至少 2 个字符' }]);
  }
  const note = cleanText(input.note, MAX_NOTE_LEN, 'note', '备注');

  const rawTools = Array.isArray(input.tools) ? input.tools : [];
  if (rawTools.length === 0) {
    throw new ValidationError('请至少选择一个要安装的工具', [{ field: 'tools', message: '至少 1 个' }]);
  }
  if (rawTools.length > MAX_TOOLS) {
    throw new ValidationError(`一次最多提交 ${MAX_TOOLS} 个工具`, [{ field: 'tools', message: `超过 ${MAX_TOOLS} 个` }]);
  }

  /* 只取 id，其余字段全部由服务端权威目录重算 */
  const toolIds = rawTools.map((t) => (typeof t === 'string' ? t : t && t.id)).filter(Boolean);
  const q = quote(toolIds);

  if (q.tools.length === 0) {
    throw new ValidationError('提交的工具都不在服务范围内，请重新选择', [{ field: 'tools', message: '无可识别的工具' }]);
  }
  if (q.unknownIds.length) {
    // 不阻断，但要记录：可能是前端版本与服务端目录不一致
    logger.warn('订单里包含未知工具 id，已忽略', { unknownIds: q.unknownIds.slice(0, 10) });
  }

  const now = new Date();
  const clientPlan = typeof input.plan === 'string' ? input.plan : '';
  const clientPrice = Number(input.price);
  if (clientPlan && clientPlan !== q.plan) {
    logger.warn('客户端套餐与服务端重算不一致，以服务端为准', { clientPlan, serverPlan: q.plan });
  }
  if (Number.isFinite(clientPrice) && clientPrice !== q.price) {
    logger.warn('客户端金额与服务端重算不一致，以服务端为准', { clientPrice, serverPrice: q.price });
  }

  const order = {
    orderNo: generateOrderNo(now),
    os,
    level,
    contact,
    note,
    tools: q.tools,
    toolCount: q.toolCount,
    totalMins: q.totalMins,
    hasGpu: q.hasGpu,
    plan: q.plan,
    price: q.price,
    status: 'pending',
    createdAt: now.toISOString(),
    clientIp: String(meta.clientIp || '').slice(0, 64),
  };

  const id = repo.insert(order);
  logger.info('订单已创建', {
    id,
    orderNo: order.orderNo,
    plan: order.plan,
    price: order.price,
    toolCount: order.toolCount,
    totalMins: order.totalMins,
  });

  return { ...order, id };
}

/** 后台列表 */
function listOrders({ status, keyword, page = 1, pageSize = 30 } = {}) {
  const size = Math.min(Math.max(Number(pageSize) || 30, 1), 100);
  const p = Math.max(Number(page) || 1, 1);
  const { items, total } = repo.list({
    status: typeof status === 'string' ? status : undefined,
    keyword: typeof keyword === 'string' ? keyword.trim().slice(0, 60) : undefined,
    limit: size,
    offset: (p - 1) * size,
  });
  return { items, total, page: p, pageSize: size, totalPages: Math.max(Math.ceil(total / size), 1) };
}

function getOrder(id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) throw new ValidationError('订单编号不合法');
  const order = repo.findById(n);
  if (!order) throw new NotFoundError('没找到这个订单');
  return { ...order, events: repo.events(n) };
}

/**
 * 状态流转。
 * @param {'taken'|'done'|'canceled'} to
 */
function changeStatus(id, to, note = '') {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) throw new ValidationError('订单编号不合法');
  if (!Object.prototype.hasOwnProperty.call(STATUS, to)) {
    throw new ValidationError('不支持的状态值', [{ field: 'status', message: `只能是 ${Object.keys(STATUS).join(' / ')}` }]);
  }

  const current = repo.findById(n);
  if (!current) throw new NotFoundError('没找到这个订单');

  const allowed = TRANSITIONS[current.status] || [];
  if (!allowed.includes(to)) {
    throw new ConflictError(
      `「${STATUS[current.status]}」的订单不能改成「${STATUS[to]}」`,
      { from: current.status, to, allowed },
    );
  }

  const now = new Date().toISOString();
  const res = repo.updateStatus(n, [current.status], to, String(note).slice(0, 200), now);
  if (!res.ok) {
    // 并发下状态被别人改过
    throw new ConflictError('订单状态刚刚被改动过，请刷新后重试', res);
  }

  logger.info('订单状态已变更', { id: n, from: current.status, to });
  return getOrder(n);
}

function getStats() {
  return { ...repo.stats(), trend: repo.dailyTrend(7) };
}

module.exports = { STATUS, TRANSITIONS, createOrder, listOrders, getOrder, changeStatus, getStats };

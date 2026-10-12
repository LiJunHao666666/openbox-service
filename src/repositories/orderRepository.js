'use strict';
/**
 * 仓储层 · 订单
 *
 * 只负责「怎么读写数据」，不含任何业务规则。
 * 所有 SQL 都走预编译参数，杜绝拼接注入；列表查询一律带 LIMIT。
 */

const { get, withTransaction } = require('../db');

/** 数据库行 ↔ 领域对象 的转换集中在这里，避免 JSON 解析散落各处 */
function toDomain(row) {
  if (!row) return null;
  let tools = [];
  try {
    const parsed = JSON.parse(row.tools);
    if (Array.isArray(parsed)) tools = parsed;
  } catch { tools = []; }

  return {
    id: row.id,
    orderNo: row.order_no,
    os: row.os,
    level: row.level,
    contact: row.contact,
    note: row.note,
    tools,
    toolCount: row.tool_count,
    totalMins: row.total_mins,
    hasGpu: !!row.has_gpu,
    plan: row.plan,
    price: row.price,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    statusAt: row.status_at,
  };
}

/** 是否已存在同一个单号（极小概率的碰撞需要重试） */
function orderNoExists(orderNo) {
  const row = get().prepare('SELECT 1 AS hit FROM orders WHERE order_no = ? LIMIT 1').get(orderNo);
  return !!row;
}

function insert(order) {
  return withTransaction((d) => {
    const info = d.prepare(`
      INSERT INTO orders
        (order_no, os, level, contact, note, tools, tool_count, total_mins,
         has_gpu, plan, price, status, created_at, updated_at, status_at, client_ip)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
    `).run(
      order.orderNo,
      order.os,
      order.level,
      order.contact,
      order.note,
      JSON.stringify(order.tools),
      order.toolCount,
      order.totalMins,
      order.hasGpu ? 1 : 0,
      order.plan,
      order.price,
      order.status,
      order.createdAt,
      order.createdAt,
      order.clientIp,
    );

    d.prepare(`
      INSERT INTO order_events (order_id, from_status, to_status, note, created_at)
      VALUES (?, NULL, ?, '客户提交预约单', ?)
    `).run(info.lastInsertRowid, order.status, order.createdAt);

    return Number(info.lastInsertRowid);
  });
}

function findById(id) {
  return toDomain(get().prepare('SELECT * FROM orders WHERE id = ?').get(id));
}

function findByOrderNo(orderNo) {
  return toDomain(get().prepare('SELECT * FROM orders WHERE order_no = ?').get(orderNo));
}

/**
 * 列表查询。
 * @param {object} opts
 * @param {string} [opts.status]  按状态过滤
 * @param {string} [opts.keyword] 按单号 / 联系方式模糊搜索
 * @param {number} [opts.limit]
 * @param {number} [opts.offset]
 */
function list({ status, keyword, limit = 50, offset = 0 } = {}) {
  const where = [];
  const params = [];

  if (status && status !== 'all') {
    where.push('status = ?');
    params.push(status);
  }
  if (keyword) {
    where.push('(order_no LIKE ? OR contact LIKE ? OR note LIKE ?)');
    const like = `%${keyword}%`;
    params.push(like, like, like);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const rows = get()
    .prepare(`SELECT * FROM orders ${whereSql} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset);

  const total = get()
    .prepare(`SELECT COUNT(*) AS n FROM orders ${whereSql}`)
    .get(...params).n;

  return { items: rows.map(toDomain), total: Number(total) };
}

/** 各状态计数 + 今日新增，供后台看板使用 */
function stats() {
  const d = get();
  const byStatus = {};
  for (const r of d.prepare('SELECT status, COUNT(*) AS n FROM orders GROUP BY status').all()) {
    byStatus[r.status] = Number(r.n);
  }
  const today = d.prepare(
    "SELECT COUNT(*) AS n FROM orders WHERE substr(created_at, 1, 10) = ?"
  ).get(new Date().toISOString().slice(0, 10)).n;

  const revenue = d.prepare(
    "SELECT COALESCE(SUM(price), 0) AS s FROM orders WHERE status IN ('taken', 'done')"
  ).get().s;

  return {
    pending: byStatus.pending || 0,
    taken: byStatus.taken || 0,
    done: byStatus.done || 0,
    canceled: byStatus.canceled || 0,
    total: Object.values(byStatus).reduce((a, b) => a + b, 0),
    today: Number(today),
    revenue: Number(revenue),
  };
}

/**
 * 更新状态。
 * @returns {boolean} 是否真的改了行（false 表示单号不存在或状态非法）
 */
function updateStatus(id, fromStatuses, toStatus, note, now) {
  return withTransaction((d) => {
    const current = d.prepare('SELECT status FROM orders WHERE id = ?').get(id);
    if (!current) return { ok: false, reason: 'NOT_FOUND' };
    if (!fromStatuses.includes(current.status)) {
      return { ok: false, reason: 'INVALID_TRANSITION', from: current.status };
    }

    d.prepare('UPDATE orders SET status = ?, updated_at = ?, status_at = ? WHERE id = ?')
      .run(toStatus, now, now, id);

    d.prepare(`
      INSERT INTO order_events (order_id, from_status, to_status, note, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, current.status, toStatus, note || '', now);

    return { ok: true, from: current.status };
  });
}

/** 某个订单的完整流转记录 */
function events(orderId) {
  return get()
    .prepare('SELECT from_status AS fromStatus, to_status AS toStatus, note, created_at AS createdAt FROM order_events WHERE order_id = ? ORDER BY id')
    .all(orderId);
}

/** 取最近 N 天的每日下单量，用于后台趋势小图 */
function dailyTrend(days = 7) {
  const since = new Date(Date.now() - (days - 1) * 86400000).toISOString().slice(0, 10);
  const rows = get()
    .prepare('SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS n FROM orders WHERE substr(created_at,1,10) >= ? GROUP BY day')
    .all(since);
  const map = Object.fromEntries(rows.map((r) => [r.day, Number(r.n)]));

  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    out.push({ day, count: map[day] || 0 });
  }
  return out;
}

module.exports = {
  toDomain,
  orderNoExists,
  insert,
  findById,
  findByOrderNo,
  list,
  stats,
  updateStatus,
  events,
  dailyTrend,
};

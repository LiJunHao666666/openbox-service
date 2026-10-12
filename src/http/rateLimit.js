'use strict';
/**
 * HTTP 中间件 · 限流
 *
 * 进程内滑动窗口计数。单机够用；将来上多实例时再换 Redis，
 * 接口形态保持不变（check 抛 RateLimitError）。
 */

const { RateLimitError } = require('../errors');

/** @type {Map<string, number[]>} */
const buckets = new Map();

let lastSweep = 0;
const SWEEP_INTERVAL_MS = 60_000;

/** 定期清理空桶，避免 Map 无限增长 */
function sweep(now) {
  if (now - lastSweep < SWEEP_INTERVAL_MS) return;
  lastSweep = now;
  for (const [key, hits] of buckets) {
    if (hits.length === 0 || now - hits[hits.length - 1] > 3600_000) buckets.delete(key);
  }
}

/**
 * @param {string} key       桶标识，例如 `order:1.2.3.4`
 * @param {number} max       窗口内允许的次数
 * @param {number} windowSec 窗口秒数
 */
function check(key, max, windowSec) {
  const now = Date.now();
  sweep(now);

  const windowMs = windowSec * 1000;
  const hits = (buckets.get(key) || []).filter((t) => now - t < windowMs);

  if (hits.length >= max) {
    const retryAfterSec = Math.max(1, Math.ceil((windowMs - (now - hits[0])) / 1000));
    buckets.set(key, hits);
    throw new RateLimitError(`操作太频繁了，请 ${retryAfterSec} 秒后再试`, retryAfterSec);
  }

  hits.push(now);
  buckets.set(key, hits);
  return { remaining: max - hits.length };
}

/** 测试用：清空所有计数 */
function reset() {
  buckets.clear();
  lastSweep = 0;
}

module.exports = { check, reset };

'use strict';
/**
 * 领域 · 计价规则
 *
 * 纯函数，无副作用，不依赖数据库 —— 因此可以被单测直接覆盖。
 */

const { BY_ID, MAX_TOTAL_MINS } = require('./toolCatalog');

const PLANS = [
  { name: '轻装', price: 39, maxTools: 2 },
  { name: '标准', price: 99, maxTools: 6 },
  { name: '全家桶', price: 199, maxTools: Infinity },
];

const PLAN_BY_NAME = new Map(PLANS.map((p) => [p.name, p]));

/**
 * 根据工具 id 列表推导出权威的耗时、套餐与价格。
 * @param {string[]} toolIds
 * @returns {{ tools: object[], toolCount: number, totalMins: number, hasGpu: boolean, plan: string, price: number, unknownIds: string[] }}
 */
function quote(toolIds) {
  const seen = new Set();
  const tools = [];
  const unknownIds = [];

  for (const id of toolIds) {
    if (typeof id !== 'string') continue;
    if (seen.has(id)) continue;      // 去重：同一工具只算一次
    seen.add(id);

    const t = BY_ID.get(id);
    if (!t) { unknownIds.push(id); continue; }
    tools.push({ id: t.id, name: t.name, cat: t.cat, mins: t.mins, need: t.need });
  }

  const totalMins = Math.min(
    tools.reduce((sum, t) => sum + t.mins, 0),
    MAX_TOTAL_MINS,
  );
  const hasGpu = tools.some((t) => t.need === '需显卡');
  const toolCount = tools.length;

  let plan;
  if (toolCount === 0) plan = '标准';
  else if (toolCount <= 2 && totalMins <= 45 && !hasGpu) plan = '轻装';
  else if (toolCount <= 6 && totalMins <= 150 && !hasGpu) plan = '标准';
  else plan = '全家桶';

  return {
    tools,
    toolCount,
    totalMins,
    hasGpu,
    plan,
    price: PLAN_BY_NAME.get(plan).price,
    unknownIds,
  };
}

module.exports = { PLANS, PLAN_BY_NAME, quote };

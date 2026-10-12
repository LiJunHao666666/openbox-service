'use strict';
/**
 * 导出全部订单为 CSV（内测期间用来对账、留存、发给自己看）。
 *
 * 直接读数据库，不需要服务在跑。
 * 输出带 UTF-8 BOM —— 否则 Excel 打开中文会乱码。
 *
 * 用法：
 *   npm run export                    → exports/orders-YYYYMMDD-HHmm.csv
 *   node scripts/export-orders.js 我的文件.csv
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const { config } = require(path.join(ROOT, 'src/config'));
const db = require(path.join(ROOT, 'src/db'));

const STATUS = { pending: '待接单', taken: '已接单', done: '已完成', canceled: '已取消' };

/** CSV 转义：含逗号/引号/换行时整体加引号，内部引号翻倍 */
function csv(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** 防 CSV 公式注入：Excel 会把 = + - @ 开头的单元格当公式执行 */
function safe(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
}

function pad(n) { return n < 10 ? '0' + n : String(n); }

function stamp(d) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

function main() {
  db.open();

  const rows = db.get()
    .prepare('SELECT * FROM orders ORDER BY created_at DESC, id DESC')
    .all();

  const header = [
    '单号', '状态', '套餐', '金额', '工具数', '预计耗时(分钟)', '含显卡',
    '系统', '电脑基础', '联系方式', '备注', '工具明细', '创建时间', '最后变更时间',
  ];

  const lines = [header.join(',')];

  for (const r of rows) {
    let tools = [];
    try {
      const parsed = JSON.parse(r.tools);
      if (Array.isArray(parsed)) tools = parsed;
    } catch { tools = []; }

    lines.push([
      r.order_no,
      STATUS[r.status] || r.status,
      r.plan,
      r.price,
      r.tool_count,
      r.total_mins,
      r.has_gpu ? '是' : '',
      r.os,
      r.level,
      safe(r.contact),
      safe(r.note),
      tools.map((t) => (t && t.name) || t).join(' / '),
      r.created_at,
      r.updated_at || r.created_at,
    ].map((v) => (typeof v === 'number' ? v : csv(v))).join(','));
  }

  const outDir = path.join(ROOT, 'exports');
  fs.mkdirSync(outDir, { recursive: true });

  const target = process.argv[2]
    ? path.resolve(process.cwd(), process.argv[2])
    : path.join(outDir, `orders-${stamp(new Date())}.csv`);

  // \uFEFF = BOM，让 Excel 正确识别 UTF-8
  fs.writeFileSync(target, '\uFEFF' + lines.join('\r\n') + '\r\n', 'utf8');

  const revenue = rows
    .filter((r) => r.status === 'taken' || r.status === 'done')
    .reduce((a, r) => a + Number(r.price || 0), 0);

  process.stdout.write(
    `\n已导出 ${rows.length} 条订单 → ${path.relative(ROOT, target)}\n` +
    `已接单+已完成营收合计：¥${revenue}\n\n`
  );

  db.close();
}

try {
  main();
} catch (err) {
  process.stderr.write(`\n导出失败：${err.message}\n\n`);
  process.exit(1);
}

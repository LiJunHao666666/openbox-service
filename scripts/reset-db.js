'use strict';
/**
 * 危险操作：删除本地数据库文件并重新初始化。
 * 仅在显式执行 `npm run reset-db` 时才会运行，且需要手动确认。
 *
 * ⚠️ 这会永久丢失全部订单数据，不可恢复。
 */

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { config } = require('../src/config');

const base = path.join(config.dataDir, 'openbox.db');
const targets = [base, `${base}-wal`, `${base}-shm`, `${base}-journal`].filter((f) => fs.existsSync(f));

if (targets.length === 0) {
  console.log('没有找到数据库文件，无需重置。');
  process.exit(0);
}

console.log('\n\x1b[31m即将永久删除以下文件（含全部订单数据，不可恢复）：\x1b[0m');
for (const t of targets) {
  const size = fs.statSync(t).size;
  console.log(`  · ${t}  (${(size / 1024).toFixed(1)} KB)`);
}
console.log('');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.question('确认删除请输入 yes：', (ans) => {
  rl.close();
  if (ans.trim().toLowerCase() !== 'yes') {
    console.log('已取消，什么都没动。');
    process.exit(0);
  }
  for (const t of targets) fs.rmSync(t, { force: true });
  console.log('\n已删除。下次启动会自动重建一个空数据库。\n');
});

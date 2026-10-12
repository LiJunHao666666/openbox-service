'use strict';
/**
 * 测试入口：起一个隔离的服务实例 → 跑全部套件 → 关服务 → 清理临时库。
 *
 * 隔离点：
 *   - 独立端口（默认 8799，避免撞上正在跑的开发服务）
 *   - 独立 DATA_DIR（默认 ./_tmp/testdata），绝不碰正式 data/openbox.db
 *   - 固定的测试口令，只存在于本次进程环境里
 *
 * 用法：npm test
 */

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.TEST_PORT || 8799);
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = 'test-admin-pass-2026';
const DATA_DIR = './_tmp/testdata';

const NODE = process.execPath;
const FLAGS = ['--disable-warning=ExperimentalWarning'];

const SUITES = [
  { name: '接口契约（api.test.js）', file: 'tests/api.test.js' },
  { name: '后台端到端（admin.test.js）', file: 'tests/admin.test.js' },
];

function rmrf(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* 忽略 */ }
}

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitForHealth(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(BASE + '/health', { signal: AbortSignal.timeout(1200) });
      if (res.ok) return true;
    } catch { /* 还没起来 */ }
    await wait(200);
  }
  return false;
}

function runSuite(file) {
  return new Promise((resolve) => {
    const child = spawn(NODE, [file], {
      cwd: ROOT,
      env: { ...process.env, TEST_BASE: BASE, TEST_ADMIN_PASSWORD: PASSWORD },
      stdio: 'inherit',
    });
    child.on('exit', (code) => resolve(code === 0));
    child.on('error', () => resolve(false));
  });
}

(async () => {
  const dataDirAbs = path.resolve(ROOT, DATA_DIR);
  rmrf(dataDirAbs);

  console.log(`\n▶ 启动隔离测试实例 ${BASE}（数据目录 ${DATA_DIR}）`);
  const server = spawn(NODE, [...FLAGS, 'server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(PORT),
      HOST: '127.0.0.1',
      ADMIN_PASSWORD: PASSWORD,
      DATA_DIR,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let serverLog = '';
  server.stdout.on('data', (d) => { serverLog += d.toString(); });
  server.stderr.on('data', (d) => { serverLog += d.toString(); });

  const cleanup = () => {
    try { server.kill(); } catch { /* 已退出 */ }
  };
  process.on('exit', cleanup);
  process.on('SIGINT', () => { cleanup(); process.exit(130); });

  const up = await waitForHealth();
  if (!up) {
    console.error('✗ 服务未能在 15 秒内就绪，服务端输出如下：\n');
    console.error(serverLog || '(无输出)');
    cleanup();
    rmrf(dataDirAbs);
    process.exit(1);
  }

  let allOk = true;
  for (const s of SUITES) {
    console.log(`\n════════ ${s.name} ════════`);
    const ok = await runSuite(s.file);
    if (!ok) allOk = false;
  }

  cleanup();
  await wait(300);
  rmrf(dataDirAbs);

  console.log('\n════════════════════════════');
  console.log(allOk ? '✅ 全部套件通过' : '❌ 存在失败用例，见上方 ✗ 行');
  console.log('════════════════════════════\n');
  process.exit(allOk ? 0 : 1);
})();

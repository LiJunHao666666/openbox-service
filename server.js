'use strict';
/**
 * 开箱 OpenBox · 服务入口
 *
 * 启动顺序：配置校验（在 config.js 里，失败即退出）
 *   → 打开数据库并执行迁移
 *   → 初始化后台口令
 *   → 启动 HTTP 服务
 *   → 注册优雅停机
 */

const os = require('node:os');
const { config } = require('./src/config');
const { logger } = require('./src/logger');
const db = require('./src/db');
const authService = require('./src/services/authService');
const sessionRepo = require('./src/repositories/sessionRepository');
const { createServer } = require('./src/http/app');

/* ------------------------------------------------------------------
 * 1. 数据层
 * ------------------------------------------------------------------ */
db.open();

/* ------------------------------------------------------------------
 * 2. 后台口令
 * ------------------------------------------------------------------ */
const admin = authService.initAdminPassword();

/* ------------------------------------------------------------------
 * 3. HTTP 服务
 * ------------------------------------------------------------------ */
const server = createServer();

server.listen(config.port, config.host, () => {
  const lan = Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);

  const host = config.host === '0.0.0.0' ? '127.0.0.1' : config.host;

  logger.info('服务已启动', {
    env: config.env,
    listen: `${config.host}:${config.port}`,
  });

  const lines = [
    '',
    '  \x1b[38;5;111m╭──────────────────────────────────────────────╮\x1b[0m',
    '  \x1b[38;5;111m│\x1b[0m  \x1b[1m开箱 OpenBox\x1b[0m · 环境代装服务            \x1b[38;5;111m│\x1b[0m',
    '  \x1b[38;5;111m╰──────────────────────────────────────────────╯\x1b[0m',
    '',
    `   落地页    \x1b[36mhttp://${host}:${config.port}/\x1b[0m`,
    `   接单后台  \x1b[36mhttp://${host}:${config.port}/admin.html\x1b[0m`,
  ];
  if (config.host === '0.0.0.0' && lan.length) {
    lines.push(`   局域网    \x1b[36mhttp://${lan[0]}:${config.port}/\x1b[0m`);
  }
  lines.push('');

  if (admin.generated) {
    lines.push('  \x1b[43m\x1b[30m  后台口令（只显示这一次，请立刻存好）  \x1b[0m');
    lines.push(`     \x1b[1m\x1b[32m${admin.plain}\x1b[0m`);
    lines.push('');
    lines.push('  \x1b[90m它已经写进数据库，重启不会变。想换密码：');
    lines.push('  在 .env 里设置 ADMIN_PASSWORD=你的新密码 后重启即可。\x1b[0m');
  } else if (config.adminPassword) {
    lines.push('  \x1b[90m后台口令来自环境变量 ADMIN_PASSWORD\x1b[0m');
  } else {
    lines.push('  \x1b[90m后台口令沿用首次启动时生成的值（存在数据库里）\x1b[0m');
    lines.push('  \x1b[90m忘了的话：在 .env 里设置 ADMIN_PASSWORD 覆盖，或删掉 data/openbox.db 重新初始化\x1b[0m');
  }
  lines.push('');

  process.stdout.write(lines.join('\n') + '\n');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    logger.error('端口已被占用', { port: config.port });
    process.stderr.write(`\n端口 ${config.port} 已被占用，改一下 .env 里的 PORT，或关掉占用它的程序。\n\n`);
  } else {
    logger.error('HTTP 服务启动失败', { err: logger.serializeError(err) });
  }
  process.exit(1);
});

/* ------------------------------------------------------------------
 * 4. 后台清理：每小时清一次过期会话
 * ------------------------------------------------------------------ */
const cleaner = setInterval(() => {
  try {
    const n = sessionRepo.purgeExpiredSessions();
    if (n) logger.info('已清理过期会话', { removed: n });
  } catch (err) {
    logger.warn('清理过期会话失败', { err: err.message });
  }
}, 3600 * 1000);
cleaner.unref();

/* ------------------------------------------------------------------
 * 5. 优雅停机
 * ------------------------------------------------------------------ */
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('收到退出信号，开始优雅停机', { signal });

  clearInterval(cleaner);

  const force = setTimeout(() => {
    logger.error('停机超时，强制退出');
    process.exit(1);
  }, 10_000);
  force.unref();

  server.close(() => {
    try {
      db.close();
      logger.info('数据库连接已关闭，进程正常退出');
    } catch (err) {
      logger.error('关闭数据库失败', { err: err.message });
    }
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('unhandledRejection', (reason) => {
  logger.error('未处理的 Promise 拒绝', {
    err: reason instanceof Error ? logger.serializeError(reason) : { message: String(reason) },
  });
});

process.on('uncaughtException', (err) => {
  logger.error('未捕获异常，即将退出', { err: logger.serializeError(err) });
  shutdown('uncaughtException');
});

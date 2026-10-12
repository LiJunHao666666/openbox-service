'use strict';
/**
 * 截图工具：用无头 Edge 驱动真实浏览器，产出预览图到 docs/screenshots/。
 *
 * 用途：改完 UI 后想快速看一眼效果，或需要留档。
 * 需要本机已装 Edge（Windows 自带）。不装 Edge 就用不了，不影响应用本身。
 *
 * 用法：
 *   npm run shots
 *   EDGE_PATH="D:\\Edge\\msedge.exe" npm run shots
 *
 * 后台口令从 src/config.js 读取（也就是 .env 里那个），不需要另填。
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const { config } = require(path.join(ROOT, 'src/config'));

const APP = process.env.APP_URL || `http://127.0.0.1:${config.port}`;
const PORT = Number(process.env.CDP_PORT || 9333);
const OUT_DIR = path.join(ROOT, 'docs', 'screenshots');

const EDGE_CANDIDATES = [
  process.env.EDGE_PATH,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function findEdge() {
  for (const p of EDGE_CANDIDATES) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error('找不到 Edge。用 EDGE_PATH 环境变量指定 msedge.exe 的路径。');
}

async function waitJson(url, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (r.ok) return await r.json();
    } catch { /* 还没起来 */ }
    await wait(250);
  }
  throw new Error(`等待 ${url} 超时`);
}

/** 极简 CDP 客户端（Node 22 自带 WebSocket，无需依赖） */
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.sessionId = null; }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error('WebSocket 连接失败')), { once: true });
    });
    const c = new CDP(ws);
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && c.pending.has(m.id)) {
        const { resolve, reject } = c.pending.get(m.id);
        c.pending.delete(m.id);
        if (m.error) reject(new Error(JSON.stringify(m.error)));
        else resolve(m.result);
      }
    });
    return c;
  }
  send(method, params = {}) {
    const id = ++this.id;
    const msg = { id, method, params };
    if (this.sessionId) msg.sessionId = this.sessionId;
    this.ws.send(JSON.stringify(msg));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  close() { try { this.ws.close(); } catch { /* 已关闭 */ } }
}

async function main() {
  const edgePath = findEdge();

  /* 先确认服务在跑 */
  try {
    const h = await fetch(APP + '/health', { signal: AbortSignal.timeout(3000) });
    if (!h.ok) throw new Error('health 非 200');
  } catch {
    throw new Error(`服务没在 ${APP} 上跑。先执行 npm start 再跑截图。`);
  }

  /* 拿后台令牌，用来截「已登录」状态的后台 */
  let token = '';
  if (config.adminPassword) {
    const r = await fetch(APP + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: config.adminPassword }),
    });
    const j = await r.json().catch(() => null);
    if (j && j.ok) token = j.token;
  }
  if (!token) process.stdout.write('  ! 未能登录后台，后台截图会停在登录页\n');

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const userDataDir = path.join(ROOT, '_tmp', 'edgeprofile');
  fs.mkdirSync(path.dirname(userDataDir), { recursive: true });

  const edge = spawn(edgePath, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
    '--disable-extensions', '--no-default-browser-check',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${userDataDir}`,
    'about:blank',
  ], { stdio: 'ignore' });

  const cleanup = () => { try { edge.kill(); } catch { /* 已退出 */ } };

  try {
    const ver = await waitJson(`http://127.0.0.1:${PORT}/json/version`);
    const cdp = await CDP.connect(ver.webSocketDebuggerUrl);

    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    cdp.sessionId = sessionId;
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    const W = 1440, H = 1180;

    async function go(url, ms = 2600) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
      await cdp.send('Page.navigate', { url });
      await wait(ms);
    }
    async function evalJs(expression) {
      const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      return r.result && r.result.value;
    }
    async function shoot(name) {
      await wait(800);
      const s = await cdp.send('Page.captureScreenshot', { format: 'png' });
      const p = path.join(OUT_DIR, name);
      fs.writeFileSync(p, Buffer.from(s.data, 'base64'));
      process.stdout.write(`  → ${name}  ${fs.statSync(p).size} bytes\n`);
    }

    /* ---- 落地页（含内测横幅，若 BETA_MODE=on） ---- */
    await go(APP + '/');
    const betaOn = await evalJs("document.getElementById('betaBar') && !document.getElementById('betaBar').hidden");
    process.stdout.write(`  落地页：卡片 ${await evalJs("document.querySelectorAll('.card').length")} 张，内测横幅 ${betaOn ? '已显示' : '未显示'}\n`);
    await shoot('landing.png');

    /* ---- 待装清单抽屉 ---- */
    await evalJs("document.getElementById('cartBtn').click()");
    await wait(1200);
    await shoot('landing-drawer.png');

    /* ---- 接单后台 ---- */
    if (token) {
      await evalJs(`sessionStorage.setItem('openbox_admin_token', ${JSON.stringify(token)})`);
    }
    await go(APP + '/admin.html');
    for (let i = 0; i < 40; i++) {
      if (await evalJs("document.querySelectorAll('.orow').length") > 0) break;
      await wait(300);
    }
    const rows = await evalJs("document.querySelectorAll('.orow').length");
    process.stdout.write(`  后台：订单 ${rows} 行\n`);
    await shoot('admin-dashboard.png');

    if (rows > 0) {
      await evalJs("document.querySelector('.orow').click()");
      await wait(1700);
      await shoot('admin-detail.png');
    }

    cdp.close();
  } finally {
    cleanup();
    await wait(400);
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
}

main()
  .then(() => process.stdout.write('\n截图完成\n\n'))
  .catch((e) => { process.stderr.write(`\n截图失败：${e.message}\n\n`); process.exit(1); });

'use strict';
/**
 * 浏览器端到端自测：用无头 Edge 像真人一样把完整链路点一遍。
 *
 * 与 tests/ 里的接口测试互补：接口测试验证服务端规则，
 * 这个脚本验证「用户实际点击的界面」真的连着后端。
 *
 * 前置：服务必须在 127.0.0.1:8788 上跑着，且本机装有 Edge。
 *
 * 用法：npm run e2e
 *
 * 注意：会在正式库里真实创建一单（联系方式带 E2E 标记），
 *       跑完会自动把这单从数据库删掉，恢复原状。
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const { config } = require(path.join(ROOT, 'src/config'));

const APP = `http://127.0.0.1:${config.port}`;
const CDP_PORT = Number(process.env.CDP_PORT || 9334);
const E2E_CONTACT = 'wx: E2E-自测单-请忽略';
const E2E_NOTE = '这是浏览器自动化自测生成的订单，跑完会被自动删除';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
function t(name, cond, extra) {
  if (cond) { pass++; process.stdout.write(`  ✓ ${name}\n`); }
  else { fail++; process.stdout.write(`  ✗ ${name}${extra !== undefined ? '  →  ' + JSON.stringify(extra) : ''}\n`); }
}

/* ---------------- API 小工具（用于断言服务端状态） ---------------- */
async function api(method, p, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(APP + p, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  let j = null;
  try { j = await res.json(); } catch { /* ignore */ }
  return { status: res.status, body: j };
}

async function waitJson(url, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (r.ok) return await r.json();
    } catch { /* ignore */ }
    await wait(250);
  }
  throw new Error(`等待 ${url} 超时`);
}

/* ---------------- 极简 CDP 客户端 ---------------- */
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
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

/* ---------------- 数据库清理（恢复自测前的状态） ---------------- */
function deleteE2EOrder(orderNo) {
  const db = require(path.join(ROOT, 'src/db'));
  db.open();
  const row = db.get().prepare('SELECT id FROM orders WHERE order_no = ?').get(orderNo);
  if (!row) { db.close(); return false; }
  db.withTransaction(() => {
    db.get().prepare('DELETE FROM order_events WHERE order_id = ?').run(row.id);
    db.get().prepare('DELETE FROM orders WHERE id = ?').run(row.id);
  });
  db.close();
  return true;
}

/* ---------------- 页面操作助手 ---------------- */
let cdp;
async function evalJs(expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('页面脚本执行失败: ' + JSON.stringify(r.exceptionDetails.exception || {}));
  return r.result ? r.result.value : undefined;
}
async function goto(url, ms = 2200) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1150, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.navigate', { url });
  await wait(ms);
}
async function until(expr, timeoutMs = 9000, interval = 260) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await evalJs(expr)) return true;
    await wait(interval);
  }
  return false;
}
/** 往输入框写值（走原生 setter + input 事件，和真人打字等效） */
const SET_INPUT = (sel, val) => `(() => {
  const el = document.querySelector(${JSON.stringify(sel)});
  if (!el) return false;
  const set = Object.getOwnPropertyDescriptor(el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value').set;
  set.call(el, ${JSON.stringify(val)});
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`;
const PRESS = (sel, key) => `document.querySelector(${JSON.stringify(sel)}).dispatchEvent(
  new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true, cancelable: true }))`;

/* ================================================================ */

async function main() {
  /* 前置：服务必须在跑 */
  let token = '';
  try {
    const h = await fetch(APP + '/health', { signal: AbortSignal.timeout(3000) });
    if (!h.ok) throw new Error('health 非 200');
    const login = await api('POST', '/api/auth/login', { password: config.adminPassword });
    if (login.status === 429) {
      throw new Error('登录撞了限流（10 分钟内超过 10 次）。限流计数在服务进程内存里，'
        + '把服务 Ctrl+C 停掉再 npm start 重启即可清零，然后重跑本自测。');
    }
    if (login.status !== 200) throw new Error('后台口令登录失败（检查 .env 里的 ADMIN_PASSWORD）');
    token = login.body.token;
  } catch (e) {
    throw new Error(`服务没在 ${APP} 上跑，或口令不对：${e.message}。先 npm start 再跑自测。`);
  }

  const beforeList = await api('GET', '/api/orders?pageSize=1', undefined, token);
  const beforeTotal = beforeList.body ? beforeList.body.total : -1;

  const edgeCandidates = [
    process.env.EDGE_PATH,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ].filter(Boolean);
  const edgePath = edgeCandidates.find((p) => fs.existsSync(p));
  if (!edgePath) throw new Error('本机没找到 Edge，无法跑浏览器自测');

  const userDataDir = path.join(ROOT, '_tmp', 'e2e-profile');
  fs.mkdirSync(path.dirname(userDataDir), { recursive: true });
  const edge = spawn(edgePath, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
    '--disable-extensions', '--no-default-browser-check',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${userDataDir}`,
    'about:blank',
  ], { stdio: 'ignore' });
  const cleanupBrowser = () => { try { edge.kill(); } catch { /* ignore */ } };

  let orderNo = '';
  try {
    const ver = await waitJson(`http://127.0.0.1:${CDP_PORT}/json/version`);
    cdp = await CDP.connect(ver.webSocketDebuggerUrl);
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    cdp.sessionId = sessionId;
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    /* ============ A. 落地页 ============ */
    process.stdout.write('\n=== A. 落地页 ===\n');
    await goto(APP + '/');
    t('页面打开且内测横幅显示',
      await until("document.getElementById('betaBar') && !document.getElementById('betaBar').hidden"),
      await evalJs("document.body ? document.body.children.length : 0"));

    const betaText = await evalJs("document.getElementById('betaTx').textContent");
    t('横幅文案来自服务端配置', /内测版/.test(betaText || ''), betaText);

    const cards0 = await evalJs("document.querySelectorAll('#grid .card').length");
    t(`默认渲染 ${cards0} 张工具卡`, cards0 >= 1, cards0);

    /* 搜索英文 → Enter 加入
       注意：cursor/ollama/python 等已是默认 6 工具，联想设计是「已加入的不再出现」，
       所以必须挑一个不在默认清单里的工具来测，这里用 Codex CLI */
    await evalJs("document.getElementById('q').focus()");
    t('输入 codex 出现联想',
      await evalJs(SET_INPUT('#q', 'codex')) &&
      await until("document.querySelectorAll('.sg-item').length > 0"));
    const sg1st = await evalJs("document.querySelector('.sg-item') && document.querySelector('.sg-item').textContent");
    t('联想第一条就是 Codex CLI', /Codex/.test(sg1st || ''), sg1st);

    t('搜「cursor」不出联想（已在清单里，按设计不重复出现）',
      await evalJs(SET_INPUT('#q', 'cursor')) &&
      await until("document.querySelectorAll('.sg-item').length === 0"));
    await evalJs(SET_INPUT('#q', 'codex'));

    await evalJs(PRESS('#q', 'Enter'));
    const cards1 = await evalJs("document.querySelectorAll('#grid .card').length");
    t(`回车后清单从 ${cards0} 变 ${cards1}（+1）`, cards1 === cards0 + 1, { cards0, cards1 });
    t('浮条计数同步 +1', (await evalJs("document.getElementById('cartN').textContent")) == cards0 + 1);

    /* 搜索中文 → 只验证联想出现（不再加入，避免污染清单） */
    t('中文「语音」也能联想',
      await evalJs(SET_INPUT('#q', '语音')) &&
      await until("document.querySelectorAll('.sg-item').length > 0"));
    await evalJs("document.getElementById('q').blur()");

    /* 打开抽屉 */
    await evalJs("document.getElementById('cartBtn').click()");
    t('点浮条打开待装清单抽屉', await until("document.getElementById('drawer').classList.contains('on')"));

    /* 空联系方式 → 应被拦 */
    await evalJs(SET_INPUT('#contact', ''));
    await evalJs("document.getElementById('genBtn').click()");
    const errShown = await evalJs("!document.getElementById('contactErr').hidden");
    t('不填联系方式提交会被拦', errShown === true);

    /* 填表提交 */
    await evalJs(SET_INPUT('#contact', E2E_CONTACT));
    await evalJs(SET_INPUT('#note', E2E_NOTE));
    await evalJs("document.getElementById('genBtn').click()");
    t('提交后拿到单号',
      await until("!document.getElementById('out').hidden && /OB-\\d{8}-[A-Z0-9]{4,5}/.test(document.getElementById('out').textContent)"));

    const outText = await evalJs("document.getElementById('out').textContent");
    t('提示语正确（已提交成功）', /已提交成功/.test(outText));
    t('凭证里包含联系方式', outText.indexOf(E2E_CONTACT) > -1);
    orderNo = (outText.match(/OB-\d{8}-[A-Z0-9]{4,5}/) || [''])[0];
    t('单号格式正确：' + orderNo, /^OB-\d{8}-[A-Z0-9]{4,5}$/.test(orderNo));

    /* ============ B. 服务端核对 ============ */
    process.stdout.write('\n=== B. 服务端核对（浏览器提交的单真的落库了吗）===\n');
    const found = await api('GET', '/api/orders?keyword=' + encodeURIComponent(orderNo), undefined, token);
    const row = found.body && found.body.items && found.body.items[0];
    t('按单号能查到这一单', found.body && found.body.total === 1, found.body && found.body.total);
    t('联系方式与页面填写一致', row && row.contact === E2E_CONTACT, row && row.contact);
    t('状态为待接单', row && row.status === 'pending', row && row.status);
    t('比自测前多了 1 单', (await api('GET', '/api/orders?pageSize=1', undefined, token)).body.total === beforeTotal + 1);

    /* ============ C. 接单后台 UI ============ */
    process.stdout.write('\n=== C. 接单后台（纯 UI 操作登录）===\n');
    await goto(APP + '/admin.html');
    t('未登录先看到登录页',
      await until("!document.getElementById('loginView').hidden && document.getElementById('appView').hidden"));

    await evalJs(SET_INPUT('#pw', '这是一个错误口令'));
    await evalJs("document.getElementById('loginForm').dispatchEvent(new Event('submit', {bubbles:true, cancelable:true}))");
    t('错误口令被拒并提示',
      await until("!document.getElementById('loginErr').hidden"));

    await evalJs(SET_INPUT('#pw', config.adminPassword));
    await evalJs("document.getElementById('loginForm').dispatchEvent(new Event('submit', {bubbles:true, cancelable:true}))");
    const loginOk = await until("document.getElementById('appView') && !document.getElementById('appView').hidden");
    const loginErrTxt = loginOk ? '' : (await evalJs("document.getElementById('loginErr') && document.getElementById('loginErr').textContent") || '(无提示)');
    t('正确口令进入看板', loginOk, loginErrTxt);

    t('统计卡渲染 6 张', (await evalJs("document.querySelectorAll('.stat').length")) === 6);
    t('趋势图渲染 7 根柱', (await evalJs("document.querySelectorAll('.bar').length")) === 7);

    /* 在后台搜这单 */
    await evalJs(SET_INPUT('#kw', orderNo));
    t('按单号过滤出 1 行', await until("(function(){const r=document.querySelectorAll('.orow');return r.length===1 && r[0].textContent.indexOf('E2E')>-1;})()"));

    /* 点行 → 详情 → 接单 */
    await evalJs("document.querySelector('.orow').click()");
    t('详情抽屉打开且单号一致',
      await until("document.getElementById('drawer').classList.contains('on') && document.getElementById('dNo').textContent.indexOf('" + orderNo + "') > -1"));

    t('详情含工具明细', (await evalJs("document.querySelectorAll('.ti').length")) >= 1);

    await evalJs("document.querySelector('#dFoot [data-dact=\"taken\"]').click()");
    await wait(1200);
    const afterTake = await api('GET', '/api/orders?keyword=' + encodeURIComponent(orderNo), undefined, token);
    t('UI 点「接单」后服务端状态变为已接单',
      afterTake.body.items[0] && afterTake.body.items[0].status === 'taken',
      afterTake.body.items[0] && afterTake.body.items[0].status);

    /* ============ D. 断网降级 ============ */
    process.stdout.write('\n=== D. 断网降级（fetch 被掐掉时，用户的单不能丢）===\n');
    await goto(APP + '/');
    await evalJs("document.getElementById('cartBtn').click()");
    await until("document.getElementById('drawer').classList.contains('on')");
    await evalJs(SET_INPUT('#contact', E2E_CONTACT));
    /* 掐掉页面里的 fetch，模拟后端不可达 */
    await evalJs("window.__realFetch = window.fetch; window.fetch = function(){ return Promise.reject(new TypeError('Failed to fetch')); }");
    await evalJs("document.getElementById('genBtn').click()");
    t('断网时降级为本地文本（不再走网络）',
      await until("!document.getElementById('out').hidden && document.getElementById('out').textContent.indexOf('本地生成') > -1"));
    t('降级后不产生新订单（服务端总数不变）',
      (await api('GET', '/api/orders?pageSize=1', undefined, token)).body.total === beforeTotal + 1);
    await evalJs("window.fetch = window.__realFetch");

  } finally {
    cleanupBrowser();
    await wait(400);
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  /* ============ E. 清理：把 E2E 订单从库里删掉，恢复原状 ============ */
  process.stdout.write('\n=== E. 清理 ===\n');
  if (orderNo) {
    const removed = deleteE2EOrder(orderNo);
    t('自测订单已从数据库删除', removed === true);
    const after = await api('GET', '/api/orders?pageSize=1', undefined, token);
    t('订单数恢复到自测前（' + beforeTotal + '）', after.body.total === beforeTotal, after.body.total);
  }

  process.stdout.write(`\n===== 浏览器自测 ${pass} / ${pass + fail} =====\n`);
  return fail === 0;
}

main()
  .then((ok) => { process.exitCode = ok ? 0 : 1; })
  .catch((e) => { process.stderr.write(`\n自测中断：${e.message}\n`); process.exitCode = 1; });

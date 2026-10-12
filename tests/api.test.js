/* 后端接口冒烟 + 业务规则验证 */
const BASE = process.env.TEST_BASE || 'http://127.0.0.1:8788';
const ADMIN_PW = process.env.TEST_ADMIN_PASSWORD || 'test-admin-pass-2026';
let pass = 0, fail = 0;
const results = [];

function t(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  →  ' + JSON.stringify(extra) : '')); }
}

async function req(method, path, { body, token } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* 204 等无体响应 */ }
  return { status: res.status, body: json, headers: res.headers };
}

const validOrder = {
  os: 'Windows',
  level: '完全不懂',
  contact: 'wx: demo-12345',
  note: '之前装过一直报错',
  tools: ['claude-code', 'cursor', 'ollama', 'python'],
};

(async () => {
  console.log('\n=== A. 健康检查 ===');
  const h = await req('GET', '/health');
  t('GET /health 200', h.status === 200 && h.body.ok === true, h.body);
  const r = await req('GET', '/ready');
  t('GET /ready 200 且 DB up', r.status === 200 && r.body.db === 'up', r.body);

  console.log('\n=== B. 公开目录 ===');
  const c = await req('GET', '/api/catalog');
  t('GET /api/catalog 200', c.status === 200);
  t('目录含 24 个工具', c.body.tools.length === 24, c.body.tools.length);
  t('目录含 3 档套餐', c.body.plans.length === 3, c.body.plans.length);

  console.log('\n=== B2. 站点运行时配置（前端据此决定要不要显示内测横幅）===');
  const sc = await req('GET', '/api/site-config');
  t('GET /api/site-config 200', sc.status === 200 && sc.body.ok === true, sc.body);
  t('含 beta 开关', sc.body.beta && typeof sc.body.beta.on === 'boolean', sc.body.beta);
  const scRaw = JSON.stringify(sc.body);
  t('不泄露任何密钥类字段', !/secret|password|token|adminPassword/i.test(scRaw), scRaw);

  console.log('\n=== C. 下单（正常路径）===');
  const o1 = await req('POST', '/api/orders', { body: validOrder });
  t('POST /api/orders 201', o1.status === 201, o1.body);
  t('返回了人类可读单号 OB-YYYYMMDD-XXXX', /^OB-\d{8}-[A-Z0-9]{4,5}$/.test(o1.body.order.orderNo), o1.body.order.orderNo);
  t('服务端算出 4 个工具', o1.body.order.toolCount === 4, o1.body.order.toolCount);
  t('服务端算出总耗时 70 分钟', o1.body.order.totalMins === 70, o1.body.order.totalMins);
  t('推荐套餐为「标准」', o1.body.order.plan === '标准', o1.body.order.plan);
  t('价格为 99', o1.body.order.price === 99, o1.body.order.price);
  t('初始状态 pending', o1.body.order.status === 'pending');
  t('响应体不含客户端 IP', o1.body.order.clientIp === undefined);
  const ORDER_NO = o1.body.order.orderNo;
  const ORDER_ID = o1.body.order.orderNo; // 下面用列表拿 id

  console.log('\n=== D. 关键：客户端篡改金额必须被服务端覆盖 ===');
  const tampered = await req('POST', '/api/orders', {
    body: { ...validOrder, plan: '轻装', price: 1, totalMins: 1, toolCount: 1 },
  });
  t('篡改 price=1 仍按服务端重算为 99', tampered.body.order.price === 99, tampered.body.order.price);
  t('篡改 plan=轻装 仍按服务端重算为 标准', tampered.body.order.plan === '标准', tampered.body.order.plan);
  t('篡改 totalMins=1 仍按服务端重算为 70', tampered.body.order.totalMins === 70, tampered.body.order.totalMins);

  console.log('\n=== E. 含显卡类工具 → 应升档为全家桶 ===');
  const gpuOrder = await req('POST', '/api/orders', {
    body: { ...validOrder, tools: ['comfyui', 'cuda'] },
  });
  t('含显卡工具时 hasGpu=true', gpuOrder.body.order.hasGpu === true);
  t('含显卡工具时套餐升为「全家桶」', gpuOrder.body.order.plan === '全家桶', gpuOrder.body.order.plan);
  t('全家桶价格 199', gpuOrder.body.order.price === 199, gpuOrder.body.order.price);

  console.log('\n=== F. 入参校验 ===');
  const cases = [
    ['缺少 tools', { ...validOrder, tools: [] }, 'VALIDATION_FAILED'],
    ['缺少 contact', { ...validOrder, contact: '' }, 'VALIDATION_FAILED'],
    ['contact 过短', { ...validOrder, contact: 'x' }, 'VALIDATION_FAILED'],
    ['os 非法', { ...validOrder, os: 'Linux' }, 'VALIDATION_FAILED'],
    ['工具全是不存在的 id', { ...validOrder, tools: ['not-a-real-tool'] }, 'VALIDATION_FAILED'],
    ['note 超长', { ...validOrder, note: 'x'.repeat(600) }, 'VALIDATION_FAILED'],
  ];
  for (const [name, body, code] of cases) {
    const res = await req('POST', '/api/orders', { body });
    t(`${name} → 422 ${code}`, res.status === 422 && res.body.error.code === code, res.body);
  }
  const badJson = await fetch(BASE + '/api/orders', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{ 坏掉的 json',
  });
  t('非法 JSON → 400 BAD_JSON', badJson.status === 400 && (await badJson.json()).error.code === 'BAD_JSON');

  console.log('\n=== G. 未登录访问后台接口 ===');
  for (const [m, p] of [['GET', '/api/orders'], ['GET', '/api/stats'], ['GET', '/api/orders/1']]) {
    const res = await req(m, p);
    t(`${m} ${p} → 401`, res.status === 401 && res.body.error.code === 'UNAUTHORIZED', res.body);
  }
  const badTok = await req('GET', '/api/orders', { token: 'totally-made-up-token' });
  t('伪造 token → 401', badTok.status === 401);

  console.log('\n=== H. 登录 ===');
  const wrong = await req('POST', '/api/auth/login', { body: { password: 'wrong-password' } });
  t('错误口令 → 401', wrong.status === 401, wrong.body);
  const ok = await req('POST', '/api/auth/login', { body: { password: ADMIN_PW } });
  t('正确口令 → 200 且返回 token', ok.status === 200 && typeof ok.body.token === 'string', ok.body);
  const TOKEN = ok.body.token;
  t('token 长度 >= 40', TOKEN && TOKEN.length >= 40, TOKEN && TOKEN.length);

  const me = await req('GET', '/api/auth/me', { token: TOKEN });
  t('GET /api/auth/me → 200', me.status === 200, me.body);

  console.log('\n=== I. 后台列表与筛选 ===');
  const list = await req('GET', '/api/orders?pageSize=50', { token: TOKEN });
  t('GET /api/orders → 200', list.status === 200);
  t('至少 3 条订单', list.body.total >= 3, list.body.total);
  t('列表按时间倒序', new Date(list.body.items[0].createdAt) >= new Date(list.body.items[list.body.items.length - 1].createdAt));
  t('列表项含工具明细数组', Array.isArray(list.body.items[0].tools));
  const first = list.body.items[0];

  const byKeyword = await req('GET', '/api/orders?keyword=' + encodeURIComponent(ORDER_NO), { token: TOKEN });
  t('按单号搜索命中 1 条', byKeyword.body.total === 1, byKeyword.body.total);

  const byStatus = await req('GET', '/api/orders?status=pending', { token: TOKEN });
  t('按状态筛选全是 pending', byStatus.body.items.every((i) => i.status === 'pending'), byStatus.body.items.map((i) => i.status));

  console.log('\n=== J. 状态机 ===');
  const detail = await req('GET', `/api/orders/${first.id}`, { token: TOKEN });
  t('订单详情含流转记录', Array.isArray(detail.body.order.events) && detail.body.order.events.length >= 1);

  const skip = await req('PATCH', `/api/orders/${first.id}`, { token: TOKEN, body: { status: 'done' } });
  t('pending 直接跳 done → 409 冲突', skip.status === 409 && skip.body.error.code === 'CONFLICT', skip.body);

  const take = await req('PATCH', `/api/orders/${first.id}`, { token: TOKEN, body: { status: 'taken' } });
  t('pending → taken 成功', take.status === 200 && take.body.order.status === 'taken', take.body);

  const reTake = await req('PATCH', `/api/orders/${first.id}`, { token: TOKEN, body: { status: 'taken' } });
  t('重复接单 → 409', reTake.status === 409, reTake.body);

  const done = await req('PATCH', `/api/orders/${first.id}`, { token: TOKEN, body: { status: 'done' } });
  t('taken → done 成功', done.status === 200 && done.body.order.status === 'done');

  const afterDone = await req('PATCH', `/api/orders/${first.id}`, { token: TOKEN, body: { status: 'canceled' } });
  t('done 是终态，不能再取消 → 409', afterDone.status === 409);

  const badStatus = await req('PATCH', `/api/orders/${first.id}`, { token: TOKEN, body: { status: 'hacked' } });
  t('非法状态值 → 422', badStatus.status === 422, badStatus.body);

  const notFound = await req('PATCH', '/api/orders/999999', { token: TOKEN, body: { status: 'taken' } });
  t('不存在的订单 → 404', notFound.status === 404, notFound.body);

  console.log('\n=== K. 统计 ===');
  const stats = await req('GET', '/api/stats', { token: TOKEN });
  t('GET /api/stats → 200', stats.status === 200);
  t('统计含各状态计数', ['pending', 'taken', 'done', 'canceled', 'total', 'today', 'revenue'].every((k) => k in stats.body.stats), Object.keys(stats.body.stats));
  t('7 天趋势为 7 个点', stats.body.stats.trend.length === 7, stats.body.stats.trend.length);
  t('已完成订单计入营收', stats.body.stats.revenue >= 99, stats.body.stats.revenue);

  console.log('\n=== L. 安全：路径穿越与静态白名单 ===');
  const trav = await fetch(BASE + '/../.env');
  t('.. 穿越访问 .env 被拒', trav.status === 404 || trav.status === 400, trav.status);
  const trav2 = await fetch(BASE + '/%2e%2e%2f.env');
  t('编码穿越被拒', trav2.status === 404 || trav2.status === 400, trav2.status);
  const src = await fetch(BASE + '/src/config.js');
  t('源码目录不可访问', src.status === 404, src.status);
  const env = await fetch(BASE + '/.env');
  t('点文件不可访问', env.status === 404, env.status);
  const pkg = await fetch(BASE + '/package.json');
  t('package.json 不可访问', pkg.status === 404, pkg.status);
  const srv = await fetch(BASE + '/server.js');
  t('server.js 源码不可下载', srv.status === 404, srv.status);
  const pkg2 = await fetch(BASE + '/package-lock.json');
  t('package-lock.json 不可访问', pkg2.status === 404, pkg2.status);
  const dbFile = await fetch(BASE + '/data/openbox.db');
  t('数据库文件不可下载', dbFile.status === 404, dbFile.status);
  const logs = await fetch(BASE + '/scripts/reset-db.js');
  t('scripts 目录不可访问', logs.status === 404, logs.status);
  const idx = await fetch(BASE + '/index.html');
  t('index.html 可正常访问', idx.status === 200, idx.status);

  console.log('\n=== M. 未知接口与跨域 ===');
  const nf = await req('GET', '/api/does-not-exist');
  t('未知 API → 404', nf.status === 404 && nf.body.error.code === 'NOT_FOUND', nf.body);
  const evil = await fetch(BASE + '/api/orders', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example.com' },
    body: JSON.stringify(validOrder),
  });
  t('非白名单 Origin 被拒 403', evil.status === 403, evil.status);

  console.log('\n=== N. 登出后 token 失效 ===');
  const out = await req('POST', '/api/auth/logout', { token: TOKEN });
  t('登出 200', out.status === 200);
  const afterLogout = await req('GET', '/api/orders', { token: TOKEN });
  t('登出后原 token → 401', afterLogout.status === 401, afterLogout.status);

  console.log(`\n===== 通过 ${pass} / ${pass + fail} =====`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试脚本异常:', e); process.exit(1); });

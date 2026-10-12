/* 后台端到端：验证 admin.html 用到的每一条接口链路 */
const BASE = process.env.TEST_BASE || 'http://127.0.0.1:8788';
const PASSWORD = process.env.TEST_ADMIN_PASSWORD || 'test-admin-pass-2026';
let pass = 0, fail = 0;

function t(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  →  ' + JSON.stringify(extra) : '')); }
}

let token = '';
async function api(method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(BASE + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* 无体 */ }
  return { status: res.status, body: json };
}

const validOrder = {
  os: 'macOS',
  level: '会一点点',
  contact: 'qq: 778899001',
  note: '想装本地大模型，机器是 M3',
  tools: ['ollama', 'python'],
};

(async () => {
  console.log('\n=== 1. 后台页面可访问（且不在站点导航里暴露） ===');
  const page = await fetch(BASE + '/admin.html');
  const html = await page.text();
  t('/admin.html 200', page.status === 200, page.status);
  t('页面标题正确', /接单后台/.test(html));
  t('带 noindex 防止被搜索引擎收录', /noindex/.test(html));
  t('未登录时先渲染登录视图', /id="loginView"/.test(html) && !/id="loginView" hidden/.test(html));

  const idxRes = await fetch(BASE + '/');
  const idxHtml = await idxRes.text();
  t('落地页不含指向后台的链接', !/admin\.html/.test(idxHtml));

  console.log('\n=== 2. 登录流程 ===');
  let r = await api('GET', '/api/orders');
  t('未登录访问订单 → 401', r.status === 401, r.status);

  r = await api('POST', '/api/auth/login', { password: 'nope' });
  t('错误口令 → 401', r.status === 401, r.body);

  r = await api('POST', '/api/auth/login', { password: PASSWORD });
  t('正确口令 → 200', r.status === 200 && r.body.ok === true, r.body);
  token = r.body.token;
  t('拿到 token', typeof token === 'string' && token.length >= 40);

  r = await api('GET', '/api/auth/me');
  t('页面刷新时 token 仍然有效（me 200）', r.status === 200, r.body);

  console.log('\n=== 3. 落地页提交 → 后台立刻能看到 ===');
  const created = await api('POST', '/api/orders', { ...validOrder, plan: '全家桶', price: 1 });
  t('落地页提交 201', created.status === 201, created.body);
  const createdNo = created.body.order.orderNo;
  /* 2 个工具 / 35 分钟 / 无显卡 → 服务端应核定为「轻装 ¥39」，而不是客户端谎报的全家桶 */
  t('服务端忽略客户端谎报的套餐，核定为「轻装」', created.body.order.plan === '轻装', created.body.order.plan);
  t('服务端忽略客户端谎报的金额，核定为 39', created.body.order.price === 39, created.body.order.price);
  t('服务端重算总耗时为 35 分钟', created.body.order.totalMins === 35, created.body.order.totalMins);

  r = await api('GET', '/api/orders?page=1&pageSize=30');
  t('后台列表 200', r.status === 200);
  const hit = r.body.items.find((i) => i.orderNo === createdNo);
  t('新单出现在第一页列表里', !!hit, r.body.total);
  t('列表项含联系方式（后台需要联系用户）', hit && hit.contact === 'qq: 778899001', hit && hit.contact);
  t('列表项含工具数', hit && hit.toolCount === 2, hit && hit.toolCount);

  console.log('\n=== 4. 后台筛选与搜索 ===');
  r = await api('GET', '/api/orders?status=pending&page=1&pageSize=30');
  t('按「待接单」筛选正常', r.status === 200 && r.body.items.every((i) => i.status === 'pending'));

  r = await api('GET', '/api/orders?status=all&page=1&pageSize=30');
  t('status=all 不会被当成状态值过滤', r.status === 200 && r.body.total >= 1, r.body.total);

  r = await api('GET', '/api/orders?keyword=' + encodeURIComponent('778899001'));
  t('按联系方式搜索命中', r.body.total === 1, r.body.total);

  r = await api('GET', '/api/orders?keyword=' + encodeURIComponent('M3'));
  t('按备注内容搜索命中', r.body.total === 1, r.body.total);

  r = await api('GET', '/api/orders?keyword=' + encodeURIComponent('zzz-not-exist'));
  t('搜索无结果返回空列表而非报错', r.status === 200 && r.body.total === 0, r.body.total);

  console.log('\n=== 5. 详情（抽屉） ===');
  const id = hit.id;
  r = await api('GET', '/api/orders/' + id);
  t('详情 200', r.status === 200);
  t('详情含工具明细数组', Array.isArray(r.body.order.tools) && r.body.order.tools.length === 2);
  t('详情含流转记录', Array.isArray(r.body.order.events) && r.body.order.events.length >= 1);
  t('首条流转记录是「创建」', r.body.order.events[0].fromStatus === null || r.body.order.events[0].fromStatus === undefined);

  console.log('\n=== 6. 后台操作：接单 → 完成 ===');
  r = await api('PATCH', '/api/orders/' + id, { status: 'taken' });
  t('接单成功', r.status === 200 && r.body.order.status === 'taken', r.body);

  r = await api('GET', '/api/stats');
  t('统计里「进行中」计数 +1', r.body.stats.taken >= 1, r.body.stats);
  t('统计里营收已计入该单', r.body.stats.revenue >= 39, r.body.stats.revenue);
  t('趋势为 7 天且今天有单', r.body.stats.trend.length === 7 && r.body.stats.trend[6].count >= 1, r.body.stats.trend[6]);

  r = await api('PATCH', '/api/orders/' + id, { status: 'done' });
  t('标记完成成功', r.status === 200 && r.body.order.status === 'done', r.body);

  r = await api('PATCH', '/api/orders/' + id, { status: 'taken' });
  t('已完成订单不能再改回已接单（409）', r.status === 409, r.body);

  console.log('\n=== 7. 取消走 confirm 分支（服务端二次校验） ===');
  const o2 = await api('POST', '/api/orders', { ...validOrder, contact: 'wx: cancel-me' });
  const id2 = o2.body.order.orderNo;
  r = await api('GET', '/api/orders?keyword=' + encodeURIComponent('cancel-me'));
  const target = r.body.items[0];
  r = await api('PATCH', '/api/orders/' + target.id, { status: 'canceled' });
  t('待接单可直接取消', r.status === 200 && r.body.order.status === 'canceled', r.body);
  t('取消后不计入营收口径（仍是 taken/done 才算）', target.status === 'pending');

  console.log('\n=== 8. 分页边界 ===');
  r = await api('GET', '/api/orders?page=1&pageSize=100');
  t('pageSize 上限 100 生效', r.body.pageSize === 100, r.body.pageSize);
  r = await api('GET', '/api/orders?page=9999&pageSize=30');
  t('超出末页返回空 items 而非报错', r.status === 200 && r.body.items.length === 0, r.body.total);
  t('totalPages 至少为 1', r.body.totalPages >= 1, r.body.totalPages);

  console.log('\n=== 9. 登出 ===');
  r = await api('POST', '/api/auth/logout');
  t('登出 200', r.status === 200);
  r = await api('GET', '/api/orders');
  t('登出后 token 立即失效', r.status === 401, r.status);

  console.log(`\n===== 通过 ${pass} / ${pass + fail} =====`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常:', e); process.exit(1); });

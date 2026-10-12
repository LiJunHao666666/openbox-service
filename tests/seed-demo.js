/* 演示数据种子：灌一批有代表性的订单，让接单后台有内容可看
   用法：先 npm start 起服务，再 node tests/seed-demo.js */
const BASE = process.env.TEST_BASE || 'http://127.0.0.1:8788';
const PASSWORD = process.env.TEST_ADMIN_PASSWORD || process.env.ADMIN_PASSWORD || 'test-admin-pass-2026';

const ORDERS = [
  { os: 'Windows', level: '完全不懂', contact: 'wx: tech_lily', note: '公司电脑，装完要能连内网', tools: ['claude-code', 'cursor'], flow: ['taken'] },
  { os: 'Windows', level: '会一点点', contact: '13800138000', note: '想跑 Stable Diffusion，显卡是 4060Ti 16G', tools: ['comfyui', 'cuda', 'python'], flow: [] },
  { os: 'macOS', level: '还行，只是想省时间', contact: 'qq: 4455667', note: '本地知识库，资料大概 200 份 PDF', tools: ['ollama', 'openwebui', 'lmstudio'], flow: ['taken', 'done'] },
  { os: 'Windows', level: '完全不懂', contact: 'wx: audio_zhang', note: '想做播客字幕，素材是 mp3', tools: ['whisper', 'python'], flow: [] },
  { os: 'macOS', level: '会一点点', contact: 'wx: pm_wang', note: '先看看，价格有点超预算', tools: ['dify', 'ragflow', 'docker'], flow: ['canceled'] },
  { os: 'Windows', level: '还行，只是想省时间', contact: '13512345678', note: '团队统一配置，后面还要装 4 台一样的', tools: ['nodejs', 'git', 'vscode', 'claude-code', 'codex-cli', 'gemini-cli'], flow: ['taken', 'done'] },
  { os: 'macOS', level: '完全不懂', contact: 'wx: designer_liu', note: 'M2 芯片，之前装一半报错了', tools: ['trae', 'copilot'], flow: [] },
  { os: 'Windows', level: '会一点点', contact: 'wx: artist_chen', note: '出图用，要求能批量跑', tools: ['sd-webui', 'python'], flow: ['taken'] },
];

async function api(method, path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(BASE + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* ignore */ }
  return { status: res.status, body: json };
}

(async () => {
  const login = await api('POST', '/api/auth/login', { password: PASSWORD });
  if (login.status !== 200) { console.error('登录失败', login.body); process.exit(1); }
  const token = login.body.token;

  let n = 0;
  for (const spec of ORDERS) {
    const { flow, ...payload } = spec;
    const created = await api('POST', '/api/orders', payload);
    if (created.status !== 201) { console.error('下单失败', payload.contact, created.body); continue; }
    const no = created.body.order.orderNo;
    n++;

    if (flow.length) {
      const list = await api('GET', '/api/orders?keyword=' + encodeURIComponent(no), undefined, token);
      const id = list.body.items[0].id;
      for (const st of flow) {
        const r = await api('PATCH', '/api/orders/' + id, { status: st }, token);
        if (r.status !== 200) console.error('  流转失败', no, st, r.body);
      }
    }
    console.log('  + ' + no + '  ' + created.body.order.plan + ' ¥' + created.body.order.price
      + '  ' + created.body.order.toolCount + '个工具  ' + payload.contact + (flow.length ? '  → ' + flow.join('→') : ''));
  }

  const stats = await api('GET', '/api/stats', undefined, token);
  console.log('\n看板统计:', JSON.stringify(stats.body.stats));
  console.log('共灌入 ' + n + ' 单');
})();

// 按文件区分的识别流程验证：只跑待识别、单文件重跑、切换设置标记过期、清空列表
import fs from 'node:fs';

const PORT = process.argv[2] ?? '9260';

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => {
  ws.addEventListener('open', r, { once: true });
  ws.addEventListener('error', () => j(new Error('ws')), { once: true });
});

let seq = 0;
const pending = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data.toString());
  const p = pending.get(m.id);
  if (!p) return;
  pending.delete(m.id);
  m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
});

const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => pending.delete(id) && reject(new Error(`timeout ${method}`)), 180_000).unref?.();
  });

const js = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval');
  return r.result.value;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await send('Runtime.enable');
await send('Page.enable');
await send('Page.bringToFront');
await sleep(400);

const state = () =>
  js(`(() => {
    const btn = document.querySelector('.controls button.primary');
    const files = [...document.querySelectorAll('.file')];
    return {
      btn: btn?.textContent ?? '',
      disabled: btn?.disabled ?? null,
      n: files.length,
      statuses: files.map(f => (f.querySelector('.status')?.textContent ?? '').trim()),
    };
  })()`);

const clickPrimary = () => js(`document.querySelector('.controls button.primary').click()`);

async function waitDone(n, ms = 90_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const s = await state();
    if (s.statuses.filter((x) => x.endsWith('字')).length >= n) return s;
    await sleep(400);
  }
  throw new Error(`等待 ${n} 页完成超时`);
}

function check(label, cond, detail) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
  if (!cond) process.exitCode = 1;
}

// ① 三个文件应显示「识别 3」
let s = await state();
check('初始按钮 = 识别 3', s.btn === '识别 3' && s.n === 3, JSON.stringify(s));

// ② 跑完 → 已是最新且禁用
await clickPrimary();
s = await waitDone(3);
await sleep(600);
s = await state();
check('跑完按钮 = 已是最新且禁用', s.btn === '已是最新' && s.disabled === true, JSON.stringify(s));

// ③ 追加文件需要真实文件路径（webUtils.getPathForFile），CDP 无法伪造，跳过；
// 与 ④ 的 pending 计数等价覆盖。

// ④ 切换预设 accurate → 全部标记需重跑，按钮 = 识别 3
await js(`(() => {
  const sel = document.querySelectorAll('.controls select')[1];
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
  setter.call(sel, 'accurate');
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  return sel.value;
})()`);
await sleep(900);
s = await state();
check('切预设后按钮 = 识别 3', s.btn === '识别 3', JSON.stringify(s));
check('切预设后全部标记需重跑', s.statuses.every((x) => x.startsWith('需重跑')), JSON.stringify(s.statuses));

// ⑤ 单文件重跑：点第 1 项的 ↻，只有它跑
const before = await js(`[...document.querySelectorAll('.file')].map(f => f.querySelector('.status').textContent)`);
await js(`document.querySelectorAll('.file')[0].querySelectorAll('.acts button')[0].click()`);
await sleep(500);
let t0 = Date.now();
while (Date.now() - t0 < 60_000) {
  const cur = await js(`[...document.querySelectorAll('.file')].map(f => f.querySelector('.status').textContent)`);
  if (cur[0].endsWith('字') && !cur[0].startsWith('需重跑')) break;
  await sleep(400);
}
const after = await js(`[...document.querySelectorAll('.file')].map(f => f.querySelector('.status').textContent)`);
check('第一项已按新设置重跑', after[0].endsWith('字') && !after[0].startsWith('需重跑'), JSON.stringify(after));
check('其余两项仍是需重跑', after.slice(1).every((x) => x.startsWith('需重跑')), JSON.stringify(after));
void before;

// ⑥ 移除一项 → 剩 2
await js(`document.querySelectorAll('.file')[1].querySelector('.acts button:nth-child(2)').click()`);
await sleep(400);
s = await state();
check('移除后剩 2 项', s.n === 2, JSON.stringify(s));

// ⑦ 清空列表
await js(`(() => {
  const t = [...document.querySelectorAll('.menu-title')].find(e => e.textContent === '文件');
  t.click();
  return true;
})()`);
await sleep(250);
const cleared = await js(`(() => {
  const b = [...document.querySelectorAll('.menu-item')].find(e => e.textContent.includes('清空列表'));
  if (!b) return false;
  b.click();
  return true;
})()`);
await sleep(500);
s = await state();
check('清空列表后 0 项', cleared && s.n === 0, JSON.stringify(s));

const shot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
fs.writeFileSync('out/_flow.png', Buffer.from(shot.data, 'base64'));

ws.close();
process.exit(process.exitCode ?? 0);

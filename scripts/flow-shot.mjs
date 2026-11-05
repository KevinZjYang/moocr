// 截图：过期标记 + banner + 单文件操作按钮（hover 显示）
import fs from 'node:fs';

const PORT = process.argv[2] ?? '9261';
const OUT = process.argv[3] ?? 'docs/flow-stale.png';

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

// 先跑完全部三页
await js(`document.querySelector('.controls button.primary').click()`);
for (let i = 0; i < 120; i++) {
  const done = await js(`[...document.querySelectorAll('.file .status')].filter(e => e.textContent.endsWith('字')).length`);
  if (done >= 3) break;
  await sleep(400);
}

// 切到 accurate，制造「需重跑」
await js(`(() => {
  const sel = document.querySelectorAll('.controls select')[1];
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, 'accurate');
  sel.dispatchEvent(new Event('change', { bubbles: true }));
})()`);
await sleep(900);

// 选中第 2 项，让 banner 出现
await js(`document.querySelectorAll('.file')[1].click()`);
await sleep(500);

// 鼠标移到第 1 项上，触发 .acts 显示
const rect = await js(`(() => {
  const r = document.querySelectorAll('.file')[0].getBoundingClientRect();
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
})()`);
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y, buttons: 0 });
await sleep(400);

console.log('banner:', await js(`document.querySelector('.banner')?.textContent ?? '(none)'`));
const shot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
console.log(`screenshot ${OUT}`);

ws.close();
process.exit(0);

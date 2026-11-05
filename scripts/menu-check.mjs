// 打开「文件」菜单并截图，验证自绘菜单的展开样式
import fs from 'node:fs';

const PORT = process.argv[2] ?? '9240';
const OUT = process.argv[3] ?? 'docs/menu-open.png';

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
    setTimeout(() => pending.delete(id) && reject(new Error(`timeout ${method}`)), 60_000).unref?.();
  });

const js = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval');
  return r.result.value;
};

await send('Runtime.enable');
await send('Page.enable');
await send('Page.bringToFront');
await new Promise((r) => setTimeout(r, 300));

console.log('menus:', await js(`[...document.querySelectorAll('.menu-title')].map(e => e.textContent).join(' / ')`));

await js(`document.querySelectorAll('.menu-title')[0].click()`);
await new Promise((r) => setTimeout(r, 250));

console.log('items:', await js(`[...document.querySelectorAll('.menu-pop .menu-item')].map(e => e.textContent).join(' | ')`));
console.log('popShown:', await js(`!!document.querySelector('.menu-pop')`));

const shot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
console.log(`screenshot ${OUT}`);

ws.close();
process.exit(0);

// 抓 README 用的界面截图：等列表就绪 → 点识别 → 等结果 → 截图
import fs from 'node:fs';

const PORT = process.argv[2] ?? '9228';
const OUT = process.argv[3] ?? 'docs/screenshot-main.png';

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === 'page');
if (!page) throw new Error('no page target');

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true });
  ws.addEventListener('error', () => rej(new Error('ws error')), { once: true });
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

function send(method, params = {}) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`timeout ${method}`));
    }, 60_000).unref?.();
  });
}

async function js(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval failed');
  return r.result.value;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await send('Runtime.enable');
await send('Page.enable');

// 等列表出现条目
let files = 0;
for (let i = 0; i < 60; i++) {
  files = await js(`document.querySelectorAll('.file').length`);
  if (files > 0) break;
  await sleep(500);
}
console.log(`files=${files}`);

await js('window.moocr.cacheClear()');
console.log('cache cleared');

// 点识别
const clicked = await js(`(() => { const b = document.querySelector('.controls button.primary'); if (!b || b.disabled) return false; b.click(); return true; })()`);
console.log(`click=${clicked}`);

// 等结果
let state = '';
for (let i = 0; i < 240; i++) {
  state = await js(`JSON.stringify({ done: document.querySelectorAll('.file.done').length, err: document.querySelectorAll('.file.error').length, tables: document.querySelectorAll('.markdown table').length, meta: (document.querySelector('.meta')||{}).innerText || '' })`);
  const s = JSON.parse(state);
  if (s.done + s.err >= files && files > 0) break;
  await sleep(500);
}
console.log(`state=${state}`);

await sleep(600);
try { await send('Page.bringToFront'); } catch {}
await sleep(300);
const shot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
console.log(`screenshot ${OUT} (${fs.statSync(OUT).size} bytes)`);

ws.close();
process.exit(0);

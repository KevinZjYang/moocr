/**
 * 用 CDP 给 Electron 窗口截图（React 渲染结果），同时抓 console 错误与页面异常。
 * 用法: node scripts/m2-shot.mjs <out.png> [cdpPort]
 */
import fs from 'node:fs';
import path from 'node:path';

const out = process.argv[2] ?? 'docs/m2-shot.png';
const port = Number(process.argv[3] ?? 9222);

const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = targets.find((t) => t.type === 'page');
if (!page) {
  console.error('没有找到 page target');
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const logs = [];
const errors = [];

function send(method, params = {}) {
  const mid = ++id;
  ws.send(JSON.stringify({ id: mid, method, params }));
  return new Promise((resolve, reject) => {
    pending.set(mid, { resolve, reject });
    setTimeout(() => {
      if (pending.has(mid)) {
        pending.delete(mid);
        reject(new Error(`timeout: ${method}`));
      }
    }, 20000);
  });
}

ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    return;
  }
  if (msg.method === 'Runtime.consoleAPICalled') {
    const text = (msg.params.args ?? []).map((a) => a.value ?? a.description ?? a.type).join(' ');
    logs.push(`[${msg.params.type}] ${text}`);
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails;
    errors.push(d.exception?.description ?? d.text);
  }
});

await new Promise((r, j) => {
  ws.addEventListener('open', r, { once: true });
  ws.addEventListener('error', (e) => j(new Error('ws error: ' + e.message)), { once: true });
});

await send('Runtime.enable');
await send('Page.enable');
await new Promise((r) => setTimeout(r, 1200));

// 读取 DOM 概况，确认不是白屏
const probe = await send('Runtime.evaluate', {
  expression: `JSON.stringify({
    title: document.title,
    rootChildren: document.getElementById('root')?.children.length ?? -1,
    fileItems: document.querySelectorAll('.file').length,
    hasToolbar: !!document.querySelector('.toolbar'),
    serverText: document.querySelector('.server')?.textContent ?? '',
    bodyText: (document.body.innerText || '').slice(0, 400)
  })`,
  returnByValue: true,
});

const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
const buf = Buffer.from(shot.data, 'base64');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, buf);

console.log('probe:', probe.result.value);
if (logs.length) console.log('console:\n  ' + logs.slice(-25).join('\n  '));
if (errors.length) console.log('errors:\n  ' + errors.join('\n  '));
console.log(`screenshot: ${out} (${buf.length} bytes)`);
ws.close();

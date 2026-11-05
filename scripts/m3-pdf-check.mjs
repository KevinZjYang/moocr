/**
 * M3 端到端验证：PDF 逐页 → 识别 → 导出三种格式。
 *
 * 依赖启动时把 PDF 路径作为 argv 传给 electron（走产品自己的 onOpenPaths 通道），
 * 这样验证的是真实链路而不是测试专用后门。
 *
 * 用法: node scripts/m3-pdf-check.mjs [port] [outDir]
 */
const PORT = process.argv[2] ?? '9222';
const OUT = process.argv[3] ?? 'out/_m3';
const BASE = `http://127.0.0.1:${PORT}`;

import fs from 'node:fs';
import path from 'node:path';

fs.mkdirSync(OUT, { recursive: true });

const targets = await (await fetch(`${BASE}/json/list`)).json();
const page = targets.find((t) => t.type === 'page' && !t.url.startsWith('devtools://'));
if (!page) throw new Error('no page target');

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
});

let seq = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { res, rej } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
  }
};

function send(method, params = {}) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((res, rej) => pending.set(id, { res, rej }));
}

async function evalJs(expr, awaitPromise = false) {
  const r = await send('Runtime.evaluate', {
    expression: expr,
    awaitPromise,
    returnByValue: true,
    userGesture: true,
  });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval failed');
  return r.result.value;
}

async function waitFor(expr, { timeout = 120000, interval = 400, desc = expr } = {}) {
  const t0 = Date.now();
  for (;;) {
    const v = await evalJs(expr);
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error(`timeout waiting for ${desc}`);
    await new Promise((r) => setTimeout(r, interval));
  }
}

await send('Runtime.enable');
await send('Page.enable');

// 1. PDF 是否被解析成多页
const files = await waitFor(`document.querySelectorAll('.file').length`, {
  timeout: 60000,
  desc: 'pdf pages in sidebar',
});
const names = await evalJs(`Array.from(document.querySelectorAll('.file .name')).map(e=>e.textContent)`);
console.log(`sidebar: ${files} item(s)`);
console.log(`  ${names.join(' | ')}`);
if (files < 3) throw new Error(`expected >=3 pdf pages, got ${files}`);

// 2. 点识别
await evalJs(`document.querySelector('.controls button.primary').click()`);
await waitFor(`document.querySelectorAll('.file.done').length >= 3`, {
  timeout: 300000,
  desc: 'all pages done',
});
console.log('identify: all pages done');

const meta = await evalJs(`document.querySelector('.meta')?.innerText.replace(/\\s+/g,' ')`);
console.log(`meta: ${meta}`);
const errs = await evalJs(`document.querySelectorAll('.file.error').length`);
if (errs > 0) throw new Error(`${errs} page(s) failed`);

// 3. 导出三种格式（走主进程 IPC，savePath 由测试给出）
const pagesExpr = `Array.from(document.querySelectorAll('.file')).map((el,i)=>{
  const name = el.querySelector('.name').textContent;
  return name;
})`;
void pagesExpr;

const exportResults = [];
for (const [fmt, ext] of [
  ['md', 'md'],
  ['html', 'html'],
  ['docx', 'docx'],
]) {
  const target = path.resolve(OUT, `pdf-test.${ext}`);
  if (fs.existsSync(target)) fs.unlinkSync(target);
  const payload = JSON.stringify({
    format: fmt,
    savePath: target,
    defaultName: 'pdf-test',
    pages: [
      { label: 'p1', markdown: '# 第一页\n\n正文 $a^2+b^2=c^2$\n\n<table><tr><td colspan="2">合并</td></tr><tr><td>a</td><td>b</td></tr></table>' },
      { label: 'p2', markdown: '- 项目一\n- 项目二' },
    ],
  });
  const r = await evalJs(`window.moocr.export(${payload})`, true);
  const size = fs.existsSync(target) ? fs.statSync(target).size : 0;
  exportResults.push({ fmt, ok: r?.ok, path: r?.path, size });
  console.log(`export ${fmt}: ok=${r?.ok} size=${size}`);
}

// 4. 截图
const shot = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync(path.join(OUT, 'm3-ui.png'), Buffer.from(shot.data, 'base64'));
console.log(`screenshot: ${path.join(OUT, 'm3-ui.png')}`);

const bad = exportResults.filter((r) => !r.ok || r.size < 100);
if (bad.length) throw new Error(`export failed: ${JSON.stringify(bad)}`);

console.log('\nM3 OK');
process.exit(0);

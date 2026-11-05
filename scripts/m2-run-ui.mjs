/**
 * 点「识别」按钮走完整 UI 流程，轮询到全部完成后截图。
 * 用法: node scripts/m2-run-ui.mjs <out.png> <expectCount> [cdpPort]
 */
import fs from 'node:fs';
import path from 'node:path';

const out = process.argv[2] ?? 'docs/m2-result.png';
const expect = Number(process.argv[3] ?? 1);
const port = Number(process.argv[4] ?? 9222);

const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const logs = [];

ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    return;
  }
  if (msg.method === 'Runtime.consoleAPICalled') {
    logs.push((msg.params.args ?? []).map((a) => a.value ?? a.description).join(' '));
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    logs.push('EXC ' + (msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text));
  }
});

function send(method, params = {}, timeoutMs = 120_000) {
  const mid = ++id;
  ws.send(JSON.stringify({ id: mid, method, params }));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (pending.has(mid)) {
        pending.delete(mid);
        reject(new Error(`timeout: ${method}`));
      }
    }, timeoutMs);
    timer.unref?.();
    pending.set(mid, { resolve, reject });
  });
}

const evalJs = async (expr) =>
  (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.value;

await new Promise((r, j) => {
  ws.addEventListener('open', r, { once: true });
  ws.addEventListener('error', (e) => j(new Error(e.message)), { once: true });
});
await send('Runtime.enable');

const clicked = await evalJs(`(() => {
  const b = document.querySelector('.controls button.primary');
  if (!b) return 'no-button';
  if (b.disabled) return 'disabled';
  b.click();
  return 'clicked';
})()`);
console.log('click:', clicked);
if (clicked !== 'clicked') process.exit(1);

const t0 = Date.now();
let done = 0;
let lastText = '';
while (Date.now() - t0 < 300_000) {
  await new Promise((r) => setTimeout(r, 1500));
  const st = await evalJs(`JSON.stringify({
    done: document.querySelectorAll('.file.done').length,
    err: document.querySelectorAll('.file.error').length,
    server: document.querySelector('.server')?.textContent ?? '',
    meta: document.querySelector('.meta')?.textContent ?? '',
    warnings: document.querySelector('.warnings')?.textContent ?? '',
    tables: document.querySelectorAll('.markdown table').length,
    rows: document.querySelectorAll('.markdown table tr').length,
    spans: Array.from(document.querySelectorAll('.markdown td[colspan],.markdown td[rowspan]')).map(td => td.getAttribute('colspan')||td.getAttribute('rowspan')),
    mdLen: (document.querySelector('.md-scroll')?.innerText ?? '').length
  })`);
  const s = JSON.parse(st);
  const line = `[${((Date.now() - t0) / 1000).toFixed(0)}s] done=${s.done} err=${s.err} server="${s.server}" tables=${s.tables} rows=${s.rows}`;
  if (line !== lastText) console.log(line);
  lastText = line;
  if (s.done + s.err >= expect) {
    if (s.err > 0) console.log('有失败项');
    break;
  }
}

const probe = JSON.parse(
  await evalJs(`JSON.stringify({
    meta: document.querySelector('.meta')?.textContent ?? '',
    warnings: document.querySelector('.warnings')?.textContent ?? '',
    tables: document.querySelectorAll('.markdown table').length,
    rows: document.querySelectorAll('.markdown table tr').length,
    spans: Array.from(document.querySelectorAll('.markdown td[colspan],.markdown td[rowspan]')).map(td => td.getAttribute('colspan')||td.getAttribute('rowspan')),
    mdText: (document.querySelector('.md-scroll')?.innerText ?? '').slice(0, 700)
  })`)
);
console.log('\nmeta:', probe.meta);
if (probe.warnings) console.log('warnings:', probe.warnings);
console.log(`tables=${probe.tables} rows=${probe.rows} spans=${JSON.stringify(probe.spans)}`);
console.log('--- rendered text ---\n' + probe.mdText);

const shot = await send('Page.captureScreenshot', { format: 'png' });
const buf = Buffer.from(shot.data, 'base64');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, buf);
console.log(`\nscreenshot: ${out} (${buf.length} bytes)`);
if (logs.length) console.log('console:\n  ' + logs.slice(-10).join('\n  '));
ws.close();
process.exit(0);

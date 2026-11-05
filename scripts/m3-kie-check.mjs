/**
 * M3 KIE 验证：通过 preload API 直接跑收据图，检查 JSON 解析与字段正确性。
 * 用法: node scripts/m3-kie-check.mjs [port]
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

const PORT = process.argv[2] ?? '9222';
const BASE = `http://127.0.0.1:${PORT}`;

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
async function evalJs(expression, awaitPromise = false) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true, userGesture: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval failed');
  return r.result.value;
}
async function waitFor(expr, { timeout = 180000, interval = 500, desc = expr } = {}) {
  const t0 = Date.now();
  for (;;) {
    const v = await evalJs(expr);
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error(`timeout: ${desc}`);
    await new Promise((r) => setTimeout(r, interval));
  }
}

await send('Runtime.enable');

const receipt = path.join(ROOT, 'fixtures/receipt.jpg');
if (!fs.existsSync(receipt)) throw new Error(`missing ${receipt}`);

const payload = JSON.stringify({
  targets: [{ label: 'receipt', path: receipt }],
  task: 'kie',
  preset: 'standard',
});

console.log('running KIE on receipt…');
const r = await evalJs(`window.moocr.identify(${payload})`, true);
if (!r?.ok) throw new Error(`identify failed: ${r?.error}`);

const result = r.results[0];
console.log(`markdown ${result.markdown.length} chars, json=${result.json !== undefined}`);
console.log(JSON.stringify(result.json, null, 2));
console.log('warnings:', result.warnings);

if (result.json === undefined) throw new Error('KIE 没有产出 JSON');
const j = result.json;
const missing = ['total_amount'].filter((k) => !(k in j));
if (missing.length) throw new Error(`缺字段: ${missing.join(',')}`);

// 让 UI 也跑一遍：切到 kie 任务并识别当前文件，验证 JSON 视图
await evalJs(`
(() => {
  const sel = document.querySelectorAll('.controls select')[0];
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
  setter.call(sel, 'kie');
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
})()
`);
await new Promise((r2) => setTimeout(r2, 300));
const schemaBtn = await evalJs(`!!Array.from(document.querySelectorAll('.controls button')).find(b=>b.textContent.includes('schema'))`);
console.log('schema button visible:', schemaBtn);

await evalJs(`document.querySelector('.controls button.primary').click()`);
await waitFor(`document.querySelectorAll('.file.done').length >= 3`, { timeout: 300000, desc: 'ui kie done' });
const jsonView = await evalJs(`!!document.querySelector('pre.json')`);
const jsonText = await evalJs(`document.querySelector('pre.json')?.textContent?.slice(0,120)`);
console.log('json view rendered:', jsonView, '|', JSON.stringify(jsonText));

const shot = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync('out/_m3/m3-kie.png', Buffer.from(shot.data, 'base64'));
console.log('screenshot: out/_m3/m3-kie.png');

if (!jsonView) throw new Error('UI 未渲染 JSON 视图');
console.log('\nKIE OK');
process.exit(0);

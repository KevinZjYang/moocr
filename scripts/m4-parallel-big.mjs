import path from 'node:path';
/**
 * 大页并发对比：prefill 是真正吃算力的部分，轻页看不出并发收益。
 * 用法: node scripts/m4-parallel-big.mjs [port]
 */
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
const send = (method, params = {}) => {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((res, rej) => pending.set(id, { res, rej }));
};
const evalJs = async (expression, awaitPromise = false) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true, userGesture: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval failed');
  return r.result.value;
};

await send('Runtime.enable');

const ROOT = path.join(ROOT, 'fixtures/scale');
const BIG = ['dense-s100.jpg', 'dense-s150.jpg', 'dense-s200.jpg'];

const mk = (files) => files.map((f) => ({ label: f, path: `${ROOT}/${f}` }));
const ident = (files, parallel) =>
  evalJs(
    `window.moocr.identify(${JSON.stringify({ targets: mk(files), task: 'document', preset: 'standard', parallel })})`,
    true
  );

const rows = [];
for (const parallel of [1, 3]) {
  process.stdout.write(`parallel=${parallel} 预热… `);
  const warm = await ident(['dense-s50.jpg'], parallel);
  if (!warm?.ok) throw new Error(`预热失败: ${warm?.error}`);

  const t0 = Date.now();
  const res = await ident(BIG, parallel);
  const ms = Date.now() - t0;
  if (!res?.ok) throw new Error(`失败: ${res?.error}`);
  const tok = res.results.reduce((a, r) => a + (r.timings?.promptTokens ?? 0), 0);
  rows.push({ parallel, ms });
  console.log(`${ms} ms · ${res.results.length} 页 · 输入合计 ${tok} token`);
}

const [a, b] = rows;
console.log(`\n串行 ${a.ms} ms → 并发 ${b.ms} ms = ${(a.ms / b.ms).toFixed(2)}× 加速`);
process.exit(0);

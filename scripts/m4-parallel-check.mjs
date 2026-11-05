import path from 'node:path';
/**
 * M4 并发识别对比：同一批图，parallel = 1 / 2 / 4 各跑一遍。
 * 每个档位先用一张小图预热（触发 sidecar 按该并发重启），再正式计时。
 * 用法: node scripts/m4-parallel-check.mjs [port]
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

const ROOT = path.join(ROOT, 'fixtures/synth');
const BATCH = [
  'mix-en-zh.png',
  'ru-paragraph.png',
  'ja-paragraph.png',
  'table-simple.png',
  'table-merged.png',
  'formula-simple.png',
  'zh-two-col.png',
  'zh-vertical.png',
];

const mk = (files) => files.map((f) => ({ label: f, path: `${ROOT}/${f}` }));

const ident = (files, parallel) =>
  evalJs(
    `window.moocr.identify(${JSON.stringify({
      targets: mk(files),
      task: 'document',
      preset: 'standard',
      parallel,
    })})`,
    true
  );

console.log(`batch: ${BATCH.length} 张\n`);
const rows = [];

for (const parallel of [1, 2, 4]) {
  process.stdout.write(`parallel=${parallel} 预热… `);
  const warm = await ident(['table-simple.png'], parallel);
  if (!warm?.ok) throw new Error(`预热失败 p=${parallel}: ${warm?.error}`);

  const t0 = Date.now();
  const res = await ident(BATCH, parallel);
  const ms = Date.now() - t0;
  if (!res?.ok) throw new Error(`识别失败 p=${parallel}: ${res?.error}`);

  const ok = res.results.length;
  const perPage = ms / BATCH.length;
  rows.push({ parallel, ms, ok, perPage });
  console.log(`${ms} ms · ${ok}/${BATCH.length} 成功 · ${perPage.toFixed(0)} ms/页 · ${((BATCH.length / ms) * 60000).toFixed(1)} 页/分`);
}

console.log('\n对比：');
const base = rows[0];
for (const r of rows) {
  console.log(
    `  parallel=${r.parallel}: ${r.ms} ms（相对串行 ${(r.ms / base.ms).toFixed(2)}×，${(base.ms / r.ms).toFixed(2)}× 加速）`
  );
}

const best = rows.reduce((a, b) => (a.ms <= b.ms ? a : b));
console.log(`\n最快：parallel=${best.parallel}`);
if (rows.some((r) => r.ok !== BATCH.length)) throw new Error('有页面识别失败');
console.log('PARALLEL OK');
process.exit(0);

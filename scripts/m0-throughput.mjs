// Throughput probe: N pages at concurrency C, report pages/min and per-page latency.
import fs from 'node:fs';

const BASE = process.env.MOOCR_SERVER || 'http://127.0.0.1:8093';
const DOC =
  'Extract all information from the main body of the document image and represent it in markdown format, ignoring headers and footers. Tables should be expressed in OTSL format, formulas in the document should be represented using LATEX format, and the parsing should be organized according to the reading order.';

const imgs = [
  'fixtures/dense-equations.jpg',
  'fixtures/receipt.jpg',
  'fixtures/synth/zh-two-col.png',
  'fixtures/synth/mix-en-zh.png',
];

const cache = new Map();
function uri(f) {
  if (!cache.has(f)) cache.set(f, `data:image/${f.endsWith('.png') ? 'png' : 'jpeg'};base64,${fs.readFileSync(f).toString('base64')}`);
  return cache.get(f);
}

async function call(img, max = 3072) {
  const body = {
    model: 'x',
    messages: [{ role: 'user', content: [{ type: 'text', text: DOC }, { type: 'image_url', image_url: { url: uri(img) } }] }],
    max_tokens: max, temperature: 0, seed: 42, stream: false,
    id_slot: undefined,
  };
  const t0 = Date.now();
  const r = await fetch(`${BASE}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json();
  return { wall: (Date.now() - t0) / 1000, inTok: j.timings?.prompt_n, outTok: j.timings?.predicted_n };
}

async function batch(n, concurrency) {
  const t0 = Date.now();
  const queue = Array.from({ length: n }, (_, i) => imgs[i % imgs.length]);
  const out = [];
  let idx = 0;
  async function worker() {
    while (idx < queue.length) {
      const mine = queue[idx++];
      out.push(await call(mine));
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  const elapsed = (Date.now() - t0) / 1000;
  const avgWall = out.reduce((s, r) => s + r.wall, 0) / out.length;
  return { n, concurrency, elapsed, avgWall, pagesPerMin: (n / elapsed) * 60, out };
}

for (const [n, c] of [[1, 1], [4, 1], [8, 4], [12, 4]]) {
  const r = await batch(n, c);
  console.log(`n=${String(n).padStart(2)} c=${c}  elapsed=${r.elapsed.toFixed(2)}s  avg lat=${r.avgWall.toFixed(2)}s  ${r.pagesPerMin.toFixed(1)} pages/min`);
}

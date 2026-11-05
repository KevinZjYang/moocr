// Controlled throughput: identical page, serial vs parallel.
import fs from 'node:fs';

const BASE = process.env.MOOCR_SERVER || 'http://127.0.0.1:8093';
const DOC =
  'Extract all information from the main body of the document image and represent it in markdown format, ignoring headers and footers. Tables should be expressed in OTSL format, formulas in the document should be represented using LATEX format, and the parsing should be organized according to the reading order.';

const IMG = process.env.MOOCR_IMG || 'fixtures/synth/zh-two-col.png';
const uri = (f) => `data:image/${f.endsWith('.png') ? 'png' : 'jpeg'};base64,${fs.readFileSync(f).toString('base64')}`;
const payload = uri(IMG);

async function call() {
  const body = {
    model: 'x',
    messages: [{ role: 'user', content: [{ type: 'text', text: DOC }, { type: 'image_url', image_url: { url: payload } }] }],
    max_tokens: 1024, temperature: 0, seed: 42, stream: false,
  };
  const t0 = Date.now();
  const r = await fetch(`${BASE}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json();
  return { wall: (Date.now() - t0) / 1000, inTok: j.timings?.prompt_n, outTok: j.timings?.predicted_n, promptMs: j.timings?.prompt_ms, genMs: j.timings?.predicted_ms };
}

async function run(n, c) {
  const t0 = Date.now();
  const out = [];
  let idx = 0;
  await Promise.all(
    Array.from({ length: c }, async () => {
      while (idx < n) {
        idx++;
        out.push(await call());
      }
    })
  );
  const elapsed = (Date.now() - t0) / 1000;
  const lat = out.map((r) => r.wall).sort((a, b) => a - b);
  return {
    n, c, elapsed,
    p50: lat[Math.floor(lat.length / 2)],
    p95: lat[Math.min(lat.length - 1, Math.floor(lat.length * 0.95))],
    pagesPerMin: (n / elapsed) * 60,
    inTok: out[0].inTok, outTok: out[0].outTok,
  };
}

console.log('image:', IMG);
for (const [n, c] of [[4, 1], [8, 1], [8, 4], [16, 4]]) {
  const r = await run(n, c);
  console.log(`n=${String(n).padStart(2)} c=${c}  total=${r.elapsed.toFixed(2)}s  p50=${r.p50.toFixed(2)}s p95=${r.p95.toFixed(2)}s  ${r.pagesPerMin.toFixed(1)} pages/min  (in=${r.inTok} out=${r.outTok})`);
}

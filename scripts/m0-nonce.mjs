// Nonce probes: measure true vision accuracy (no language prior to lean on).
import fs from 'node:fs';

const BASE = process.env.MOOCR_SERVER || 'http://127.0.0.1:8092';
const P = {
  document:
    'Extract all information from the main body of the document image and represent it in markdown format, ignoring headers and footers. Tables should be expressed in OTSL format, formulas in the document should be represented using LATEX format, and the parsing should be organized according to the reading order.',
  text: 'Extract the text in the image.',
  table: 'Parse the table in the image into OTSL.',
};

function uri(file) {
  return `data:image/png;base64,${fs.readFileSync(file).toString('base64')}`;
}

function lev(a, b) {
  const A = [...a]; const B = [...b];
  if (!A.length) return B.length;
  if (!B.length) return A.length;
  let prev = Array.from({ length: B.length + 1 }, (_, i) => i);
  for (let i = 1; i <= A.length; i++) {
    const cur = [i];
    for (let j = 1; j <= B.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (A[i - 1] === B[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[B.length];
}

const squash = (s) => s.replace(/\s+/g, '');

async function call(img, prompt, max) {
  const body = {
    model: 'x',
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: uri(img) } }] }],
    max_tokens: max, temperature: 0, seed: 42, stream: false,
  };
  const t0 = Date.now();
  const r = await fetch(`${BASE}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json();
  return { text: j.choices?.[0]?.message?.content || '', wall: (Date.now() - t0) / 1000, inTok: j.timings?.prompt_n, outTok: j.timings?.predicted_n, finish: j.choices?.[0]?.finish_reason };
}

const gt = fs.readFileSync('fixtures/synth/nonce-cjk.gt.txt', 'utf8');
const gtSquash = squash(gt);

for (const [label, prompt] of [['text', P.text], ['document', P.document]]) {
  const r = await call('fixtures/synth/nonce-cjk.png', prompt, 1024);
  const out = squash(r.text.replace(/```[a-z]*|[#*_`>-]/g, ''));
  const acc = Math.max(0, 1 - lev(gtSquash, out) / gtSquash.length);
  console.log(`\n--- nonce-cjk [${label}] in=${r.inTok} out=${r.outTok} ${r.wall.toFixed(2)}s finish=${r.finish}`);
  console.log(`  GT  (${gtSquash.length}): ${gtSquash.slice(0, 80)}`);
  console.log(`  OUT (${out.length}): ${out.slice(0, 80)}`);
  console.log(`  char accuracy: ${(acc * 100).toFixed(1)}%   length ratio: ${(out.length / gtSquash.length * 100).toFixed(0)}%`);
  fs.writeFileSync(`docs/nonce-cjk-${label}.txt`, r.text);
}

const r2 = await call('fixtures/synth/nonce-table.png', P.table, 512);
console.log(`\n--- nonce-table in=${r2.inTok} out=${r2.outTok} ${r2.wall.toFixed(2)}s`);
console.log('  ' + r2.text.replace(/\n/g, ' '));
fs.writeFileSync('docs/nonce-table.txt', r2.text);

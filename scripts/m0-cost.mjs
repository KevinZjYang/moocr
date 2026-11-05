// Cost model sweep: prompt_n vs prompt_ms across image scales, plus decode rate.
import fs from 'node:fs';

const BASE = process.env.MOOCR_SERVER || 'http://127.0.0.1:8092';
const DOC =
  'Extract all information from the main body of the document image and represent it in markdown format, ignoring headers and footers. Tables should be expressed in OTSL format, formulas in the document should be represented using LATEX format, and the parsing should be organized according to the reading order.';

function dataUri(file) {
  return `data:image/jpeg;base64,${fs.readFileSync(file).toString('base64')}`;
}

async function call(img, prompt, maxTokens) {
  const body = {
    model: 'x',
    messages: [
      { role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: dataUri(img) } }] },
    ],
    max_tokens: maxTokens,
    temperature: 0,
    seed: 42,
    stream: false,
  };
  const t0 = Date.now();
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await res.json();
  const tm = j.timings || {};
  return {
    wall: (Date.now() - t0) / 1000,
    inTok: tm.prompt_n,
    promptMs: tm.prompt_ms,
    outTok: tm.predicted_n,
    predictedMs: tm.predicted_ms,
    finish: j.choices?.[0]?.finish_reason,
    text: j.choices?.[0]?.message?.content || '',
  };
}

const rows = [];
const SCALES = ['s50', 's75', 's100', 's150', 's200'];
for (const s of SCALES) {
  const img = `fixtures/scale/dense-${s}.jpg`;
  const r = await call(img, DOC, 4096);
  const pm = r.promptMs || 1;
  rows.push({
    scale: s,
    in: r.inTok,
    promptMs: r.promptMs,
    promptTps: r.inTok ? (r.inTok / pm) * 1000 : null,
    out: r.outTok,
    predictedMs: r.predictedMs,
    decodeTps: r.outTok ? (r.outTok / (r.predictedMs || 1)) * 1000 : null,
    wall: r.wall,
    finish: r.finish,
  });
  fs.writeFileSync(`docs/scale-${s}.txt`, r.text);
  console.log(`${s.padEnd(5)} in=${String(r.inTok).padStart(5)} prompt=${(pm / 1000).toFixed(2)}s (${((r.inTok / pm) * 1000).toFixed(0)} t/s)  out=${String(r.outTok).padStart(4)}  ${r.wall.toFixed(2)}s  ${r.finish}`);
}

// quadratic fit t = c2*n^2 (in seconds) and residuals
const fit = rows.map((r) => {
  const n = r.in;
  const t = r.promptMs / 1000;
  return { n, t, c2: t / (n * n) };
});
console.log('\nquadratic coefficient c2 (prompt_s / token^2):');
for (const f of fit) console.log(`  n=${f.n}  t=${f.t.toFixed(2)}s  c2=${f.c2.toExponential(2)}`);

fs.writeFileSync('docs/cost-model.json', JSON.stringify({ rows, fit }, null, 2));

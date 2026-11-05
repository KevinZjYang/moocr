// M0 capability probe — drives a running llama-server and records timings + quality signals.
// Covers the 7 measurement items in docs/CAPABILITY-PROTOCOL.md.
//
// usage:
//   MOOCR_SERVER=http://127.0.0.1:8090 node scripts/m0-bench.mjs            # full suite
//   MOOCR_SERVER=http://127.0.0.1:8090 node scripts/m0-bench.mjs --quick    # skip repeat/adherence loops
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const BASE = process.env.MOOCR_SERVER || 'http://127.0.0.1:8090';
const OUT_JSON = path.join(ROOT, 'docs', 'capability-raw.json');
const OUT_MD = path.join(ROOT, 'docs', 'CAPABILITY-RAW.md');
const QUICK = process.argv.includes('--quick');

const P = {
  document:
    'Extract all information from the main body of the document image and represent it in markdown format, ignoring headers and footers. Tables should be expressed in OTSL format, formulas in the document should be represented using LATEX format, and the parsing should be organized according to the reading order.',
  text: 'Extract the text in the image.',
  table: 'Parse the table in the image into OTSL.',
  formula: 'Identify the formula in the image and represent it using LATEX format.',
  bbox:
    'Output every text line in the image as JSON: [{"text":"...","bbox":[x1,y1,x2,y2]}]. Coordinates in pixels. Output JSON only.',
  receipts:
    'Extract key information in the image\n\nPlease output the key information in JSON format according to the following schema:\n{\n  "date": "",\n  "seller_address": "",\n  "seller_gst_id": "",\n  "seller_name": "",\n  "total_amount": "",\n  "total_tax": ""\n}',
};

const VERTICAL_GT = '白日依山尽黄河入海流欲穷千里目更上一层楼';

// ---------------------------------------------------------------- test cases
const CASES = [
  // --- A. whole-page document parsing (official 4 examples) ---
  { id: 'doc-qianziwen', group: 'A-page', img: 'fixtures/qianziwen.jpeg', prompt: 'document', max: 2048, ref: 'fixtures/qianziwen.md' },
  { id: 'doc-dense-equations', group: 'A-page', img: 'fixtures/dense-equations.jpg', prompt: 'document', max: 4096, ref: 'fixtures/dense-equations.md' },
  { id: 'doc-handwrite-formula', group: 'A-page', img: 'fixtures/handwrite-formula.jpg', prompt: 'document', max: 4096, ref: 'fixtures/handwrite-formula.md' },
  { id: 'doc-receipt', group: 'A-page', img: 'fixtures/receipt.jpg', prompt: 'document', max: 2048, ref: 'fixtures/receipt.md' },

  // --- B. task-specific prompts ---
  { id: 'task-table', group: 'B-task', img: 'fixtures/synth/table-simple.png', prompt: 'table', max: 768, expectTokens: ['<fcel>', '<nl>'] },
  { id: 'task-formula', group: 'B-task', img: 'fixtures/synth/formula-simple.png', prompt: 'formula', max: 384, expectTokens: ['\\', '^'] },
  { id: 'task-text', group: 'B-task', img: 'fixtures/qianziwen.jpeg', prompt: 'text', max: 512 },

  // --- C. language / layout coverage ---
  { id: 'lang-ja', group: 'C-lang', img: 'fixtures/synth/ja-paragraph.png', prompt: 'text', max: 512, script: 'ja' },
  { id: 'lang-ko', group: 'C-lang', img: 'fixtures/synth/ko-paragraph.png', prompt: 'text', max: 512, script: 'ko' },
  { id: 'lang-ru', group: 'C-lang', img: 'fixtures/synth/ru-paragraph.png', prompt: 'text', max: 512, script: 'ru' },
  { id: 'lang-zh-vertical', group: 'C-lang', img: 'fixtures/synth/zh-vertical.png', prompt: 'text', max: 256, refText: VERTICAL_GT },

  // --- D. structural probes ---
  { id: 'kie-receipt', group: 'D-probe', img: 'fixtures/receipt.jpg', prompt: 'receipts', max: 512, expectJson: true },
  { id: 'probe-bbox', group: 'D-probe', img: 'fixtures/qianziwen.jpeg', prompt: 'bbox', max: 1024, expectBbox: true },
];

// ------------------------------------------------------------------- helpers
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };

function dataUri(file) {
  const abs = path.join(ROOT, file);
  const b64 = fs.readFileSync(abs).toString('base64');
  return `data:${MIME[path.extname(abs).toLowerCase()] || 'image/png'};base64,${b64}`;
}

const CH = (s) => [...s];

function levenshtein(a, b) {
  const A = CH(a), B = CH(b);
  if (!A.length) return B.length;
  if (!B.length) return A.length;
  let prev = Array.from({ length: B.length + 1 }, (_, i) => i);
  for (let i = 1; i <= A.length; i++) {
    const cur = [i];
    for (let j = 1; j <= B.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (A[i - 1] === B[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[B.length];
}

const norm = (s) => s.replace(/\s+/g, ' ').trim();

function charAcc(ref, out) {
  const r = norm(ref), o = norm(out);
  if (!r.length) return null;
  return Math.max(0, 1 - levenshtein(r, o) / r.length);
}

// fraction of produced characters that belong to the expected writing system
function scriptRatio(text, script) {
  const t = CH(text).filter((c) => /\S/.test(c));
  if (!t.length) return 0;
  const re = {
    ja: /[\u3040-\u309f\u30a0-\u30ff\u4e00-\u9fff]/,
    ko: /[\uac00-\ud7a3\u1100-\u11ff]/,
    ru: /[\u0400-\u04ff]/,
    zh: /[\u4e00-\u9fff]/,
  }[script];
  if (!re) return 0;
  return t.filter((c) => re.test(c)).length / t.length;
}

// duplicated n-gram share, the raw repetition signal the official postprocess guards against
function repeatRatio(text, n = 24) {
  const c = CH(text);
  if (c.length < n * 2) return 0;
  const m = new Map();
  for (let i = 0; i + n <= c.length; i++) {
    const g = c.slice(i, i + n).join('');
    m.set(g, (m.get(g) || 0) + 1);
  }
  let dup = 0;
  for (const v of m.values()) if (v > 1) dup += v - 1;
  return dup / m.size;
}

function tryJson(text) {
  const s = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const a = s.indexOf('[');
  const o = s.indexOf('{');
  const start = a === -1 ? o : o === -1 ? a : Math.min(a, o);
  if (start < 0) return null;
  for (let end = s.length; end > start; end--) {
    try {
      return JSON.parse(s.slice(start, end));
    } catch {
      /* keep shrinking */
    }
  }
  return null;
}

function checkBbox(text) {
  const v = tryJson(text);
  if (!Array.isArray(v) || !v.length) return { valid: false, reason: 'not a JSON array' };
  const good = v.filter((x) => x && typeof x.text === 'string' && Array.isArray(x.bbox) && x.bbox.length === 4 && x.bbox.every((n) => typeof n === 'number'));
  const sane = good.filter((x) => x.bbox[2] > x.bbox[0] && x.bbox[3] > x.bbox[1]);
  return {
    valid: good.length > 0,
    items: v.length,
    with_bbox: good.length,
    monotonic: sane.length,
    sample: good[0] ?? null,
  };
}

// ------------------------------------------------------------------ inference
async function callServer(c, { maxTokens, temperature = 0, seed = 42 } = {}) {
  const body = {
    model: 'xiaomi-ocr',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: P[c.prompt] },
          { type: 'image_url', image_url: { url: dataUri(c.img) } },
        ],
      },
    ],
    max_tokens: maxTokens ?? c.max ?? 1024,
    temperature,
    seed,
    stream: false,
  };
  const t0 = Date.now();
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const wall = (Date.now() - t0) / 1000;
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    return { ok: false, wall, status: res.status, error: txt.slice(0, 400) };
  }
  const j = await res.json();
  const text = j.choices?.[0]?.message?.content ?? '';
  return { ok: true, wall, text, finish: j.choices?.[0]?.finish_reason, timings: j.timings ?? null, usage: j.usage ?? null };
}

// ---------------------------------------------------------------------- main
const results = [];
const t0all = Date.now();

async function health() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

if (!(await health())) {
  console.error(`server not reachable at ${BASE}`);
  process.exit(2);
}

for (const c of CASES) {
  process.stdout.write(`[${c.group}] ${c.id} ... `);
  const r = await callServer(c);
  const rec = {
    id: c.id,
    group: c.group,
    prompt: c.prompt,
    image: c.img,
    max_tokens: c.max,
    ok: r.ok,
    wall_seconds: r.wall,
    finish_reason: r.finish ?? null,
    prompt_tokens: r.timings?.prompt_n ?? r.usage?.prompt_tokens ?? null,
    output_tokens: r.timings?.predicted_n ?? r.usage?.completion_tokens ?? null,
    prefill_ms: r.timings?.prompt_ms ?? null,
    decode_ms: r.timings?.predicted_ms ?? null,
    prefill_tps: r.timings?.prompt_per_second ?? null,
    decode_tps: r.timings?.predicted_per_second ?? null,
    repeat_ratio: r.ok ? Number(repeatRatio(r.text).toFixed(4)) : null,
    output_chars: r.ok ? CH(r.text).length : null,
    text: r.ok ? r.text : null,
    error: r.ok ? null : r.error,
  };
  if (r.ok && c.ref && fs.existsSync(path.join(ROOT, c.ref))) {
    rec.ref_accuracy = Number(charAcc(fs.readFileSync(path.join(ROOT, c.ref), 'utf8'), r.text).toFixed(4));
  }
  if (r.ok && c.refText) rec.ref_accuracy = Number(charAcc(c.refText, r.text.replace(/\s+/g, '')).toFixed(4));
  if (r.ok && c.script) rec.script_ratio = Number(scriptRatio(r.text, c.script).toFixed(4));
  if (r.ok && c.expectTokens) rec.expect_tokens = Object.fromEntries(c.expectTokens.map((t) => [t, r.text.includes(t)]));
  if (r.ok && c.expectJson) {
    const j = tryJson(r.text);
    rec.json_valid = !!j;
    rec.json_keys = j && !Array.isArray(j) ? Object.keys(j) : null;
  }
  if (r.ok && c.expectBbox) rec.bbox = checkBbox(r.text);

  results.push(rec);
  console.log(
    r.ok
      ? `ok ${r.wall.toFixed(2)}s in=${rec.prompt_tokens} out=${rec.output_tokens} ${rec.decode_tps ? rec.decode_tps.toFixed(1) + ' tok/s' : ''}${rec.ref_accuracy != null ? ` acc=${(rec.ref_accuracy * 100).toFixed(1)}%` : ''}${rec.repeat_ratio > 0.05 ? ' REPEAT!' : ''}`
      : `FAIL ${r.status} ${r.error?.slice(0, 120)}`
  );
}

// -------------------------------------------------- prompt-adherence stability
let adherence = null;
if (!QUICK) {
  const target = CASES[3]; // doc-receipt
  const runs = [];
  process.stdout.write('[E-adherence] 5x same prompt ... ');
  for (let i = 0; i < 5; i++) {
    const r = await callServer(target, { maxTokens: target.max, temperature: 0, seed: 42 });
    if (r.ok) runs.push(r.text);
  }
  if (runs.length >= 2) {
    let accs = [];
    for (let i = 1; i < runs.length; i++) accs.push(charAcc(runs[0], runs[i]));
    adherence = {
      runs: runs.length,
      pairwise_accuracy: accs.map((x) => Number(x.toFixed(4))),
      mean: Number((accs.reduce((a, b) => a + b, 0) / accs.length).toFixed(4)),
      min: Number(Math.min(...accs).toFixed(4)),
    };
  }
  console.log(adherence ? `mean=${(adherence.mean * 100).toFixed(1)}%` : 'no data');

  // ------------------------------------------------------- repetition stress
  process.stdout.write('[E-repeat] 8x dense page ... ');
  const dens = CASES[1];
  const reps = [];
  for (let i = 0; i < 8; i++) {
    const r = await callServer(dens, { maxTokens: dens.max, temperature: 0, seed: 42 + i });
    if (r.ok) reps.push({ rr: repeatRatio(r.text), chars: CH(r.text).length, t: r.wall });
  }
  adherence = adherence ?? {};
  adherence.repeat_stress = {
    runs: reps.length,
    ratios: reps.map((x) => Number(x.rr.toFixed(4))),
    max_ratio: reps.length ? Math.max(...reps.map((x) => x.rr)) : null,
    hit_rate: reps.length ? reps.filter((x) => x.rr > 0.05).length / reps.length : null,
  };
  console.log(`max=${adherence.repeat_stress.max_ratio}`);
}

// ---------------------------------------------------------------- aggregation
const ok = results.filter((r) => r.ok);
const agg = {
  generated_at: new Date().toISOString(),
  server: BASE,
  total_wall_seconds: Number(((Date.now() - t0all) / 1000).toFixed(1)),
  cases: results.length,
  failed: results.length - ok.length,
  page_cases: ok.filter((r) => r.group === 'A-page').map((r) => ({
    id: r.id,
    seconds: Number(r.wall_seconds.toFixed(2)),
    prefill_ms: r.prefill_ms,
    decode_ms: r.decode_ms,
    decode_tps: r.decode_tps && Number(r.decode_tps.toFixed(1)),
    prompt_tokens: r.prompt_tokens,
    output_tokens: r.output_tokens,
    finish: r.finish_reason,
    accuracy: r.ref_accuracy,
    repeat: r.repeat_ratio,
  })),
  context_headroom: ok
    .filter((r) => r.prompt_tokens && r.output_tokens)
    .map((r) => ({
      id: r.id,
      used: r.prompt_tokens + r.output_tokens,
      ratio_of_16384: Number(((r.prompt_tokens + r.output_tokens) / 16384).toFixed(3)),
      truncated: r.finish_reason === 'length',
    })),
  repetition: {
    max_ratio: ok.length ? Math.max(...ok.map((r) => r.repeat_ratio ?? 0)) : null,
    hits: ok.filter((r) => (r.repeat_ratio ?? 0) > 0.05).map((r) => r.id),
  },
  languages: ok.filter((r) => r.group === 'C-lang').map((r) => ({ id: r.id, script_ratio: r.script_ratio, accuracy: r.ref_accuracy ?? null })),
  adherence,
  results,
};

fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
fs.writeFileSync(OUT_JSON, JSON.stringify(agg, null, 2));

// ------------------------------------------------------------- markdown table
const L = [];
L.push('# M0 capability raw results');
L.push('');
L.push(`server: \`${BASE}\`  ·  ${agg.cases} cases, ${agg.failed} failed  ·  ${agg.total_wall_seconds}s total`);
L.push('');
L.push('## A. whole-page document parsing');
L.push('');
L.push('| case | wall s | prefill ms | decode ms | decode tok/s | in tok | out tok | finish | char acc | repeat |');
L.push('|---|---|---|---|---|---|---|---|---|---|');
for (const r of agg.page_cases) {
  L.push(
    `| ${r.id} | ${r.seconds} | ${r.prefill_ms ?? '-'} | ${r.decode_ms ?? '-'} | ${r.decode_tps ?? '-'} | ${r.prompt_tokens ?? '-'} | ${r.output_tokens ?? '-'} | ${r.finish} | ${r.accuracy != null ? (r.accuracy * 100).toFixed(1) + '%' : '-'} | ${r.repeat ?? '-'} |`
  );
}
L.push('');
L.push('## B/C/D. task, language and structural probes');
L.push('');
L.push('| case | group | wall s | in tok | out tok | decode tok/s | signals |');
L.push('|---|---|---|---|---|---|---|');
for (const r of results) {
  const sig = [];
  if (r.ref_accuracy != null) sig.push(`acc=${(r.ref_accuracy * 100).toFixed(1)}%`);
  if (r.script_ratio != null) sig.push(`script=${(r.script_ratio * 100).toFixed(1)}%`);
  if (r.expect_tokens) sig.push(...Object.entries(r.expect_tokens).map(([k, v]) => `${k}:${v ? 'y' : 'n'}`));
  if (r.json_valid != null) sig.push(`json=${r.json_valid ? 'valid' : 'INVALID'}`);
  if (r.bbox) sig.push(`bbox=${r.bbox.with_bbox}/${r.bbox.items}`);
  if (r.repeat_ratio > 0.05) sig.push('REPEAT');
  L.push(`| ${r.id} | ${r.group} | ${r.wall_seconds?.toFixed(2) ?? '-'} | ${r.prompt_tokens ?? '-'} | ${r.output_tokens ?? '-'} | ${r.decode_tps ? r.decode_tps.toFixed(1) : '-'} | ${sig.join('; ') || '-'} |`);
}
L.push('');
L.push('## E. stability');
L.push('');
if (adherence) {
  L.push(`- prompt adherence (5 runs, same input): mean pairwise accuracy **${(adherence.mean * 100).toFixed(1)}%**, min ${(adherence.min * 100).toFixed(1)}%`);
  const rs = adherence.repeat_stress;
  if (rs) L.push(`- repetition stress (8 runs, dense page): max duplicate-24gram ratio **${rs.max_ratio}**, hit-rate(>5%) ${(rs.hit_rate * 100).toFixed(0)}%`);
} else {
  L.push('- skipped (`--quick`)');
}
L.push('');
L.push('## Context headroom (16384)');
L.push('');
L.push('| case | used tok | ratio | truncated |');
L.push('|---|---|---|---|');
for (const c of agg.context_headroom) L.push(`| ${c.id} | ${c.used} | ${(c.ratio_of_16384 * 100).toFixed(1)}% | ${c.truncated ? 'YES' : 'no'} |`);
L.push('');
fs.writeFileSync(OUT_MD, L.join('\n'));

console.log(`\nwrote ${path.relative(ROOT, OUT_JSON)} and ${path.relative(ROOT, OUT_MD)}`);
console.log(JSON.stringify({ page_cases: agg.page_cases.length, failed: agg.failed, max_repeat: agg.repetition.max_ratio }, null, 2));

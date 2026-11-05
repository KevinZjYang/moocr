// Robustness + loop-rate probe across degraded scans, both prompts.
import fs from 'node:fs';
import { repeatStats } from './degeneration.mjs';

const BASE = process.env.MOOCR_SERVER || 'http://127.0.0.1:8092';
const P = {
  document:
    'Extract all information from the main body of the document image and represent it in markdown format, ignoring headers and footers. Tables should be expressed in OTSL format, formulas in the document should be represented using LATEX format, and the parsing should be organized according to the reading order.',
  text: 'Extract the text in the image.',
};

const squash = (s) => s.replace(/```[a-z]*|[#*_`>]/g, '').replace(/\s+/g, '');

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

function uri(file) {
  return `data:image/png;base64,${fs.readFileSync(file).toString('base64')}`;
}

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

const gt = squash(fs.readFileSync('fixtures/degraded/para.gt.txt', 'utf8'));
const variants = ['clean', 'blur2', 'blur4', 'lowcontrast', 'lowres', 'noisy'];

fs.mkdirSync('docs/degraded', { recursive: true });
const results = [];
for (const v of variants) {
  for (const [pname, prompt] of Object.entries(P)) {
    const r = await call(`fixtures/degraded/para-${v}.png`, prompt, 512);
    const out = squash(r.text);
    const acc = Math.max(0, 1 - lev(gt, out) / gt.length);
    const { ratio } = repeatStats(r.text);
    results.push({ variant: v, prompt: pname, acc: acc * 100, degen: ratio * 100, outChars: out.length, gtChars: gt.length, wall: r.wall, inTok: r.inTok, outTok: r.outTok, finish: r.finish });
    fs.writeFileSync(`docs/degraded/${v}-${pname}.txt`, r.text);
    console.log(`${v.padEnd(12)} ${pname.padEnd(9)} acc=${(acc * 100).toFixed(1).padStart(5)}%  degen=${(ratio * 100).toFixed(0).padStart(3)}%  len=${String(out.length).padStart(3)}/${gt.length}  ${r.wall.toFixed(2)}s  ${r.finish}`);
  }
}
fs.writeFileSync('docs/degraded-results.json', JSON.stringify(results, null, 2));

// Accuracy vs image-token budget for the dense-equations page.
import fs from 'node:fs';

const LATEX_CMD = /\\[a-zA-Z]+\*?/g;
const BRACES = /[{}$\\]/g;
const strip = (s) => s.replace(LATEX_CMD, '').replace(BRACES, '');
const mathNorm = (s) => strip(s).replace(/\s+/g, '').toLowerCase();

function lev(a, b) {
  const A = [...a];
  const B = [...b];
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

const sim = (a, b) => {
  const A = mathNorm(a);
  const B = mathNorm(b);
  if (!A.length || !B.length) return 0;
  return Math.max(0, 1 - lev(A, B) / Math.max(A.length, B.length));
};

const ref = fs.readFileSync('fixtures/dense-equations.md', 'utf8');
const refBlocks = ref.split(/\n{2,}/).map((x) => x.trim()).filter(Boolean);
const refNorm = mathNorm(ref);

const tokens = { s50: 630, s75: 1372, s100: 2366, s150: 5194, s200: 9142 };
const out = [];
for (const [tag, tok] of Object.entries(tokens)) {
  const file = `docs/scale-${tag}.txt`;
  if (!fs.existsSync(file)) continue;
  const text = fs.readFileSync(file, 'utf8');
  const n = mathNorm(text);
  const acc = Math.max(0, 1 - lev(refNorm, n) / refNorm.length);
  // block coverage
  const outBlocks = text.split(/\n{2,}/).map((x) => x.trim()).filter(Boolean);
  const cover = refBlocks.map((p) => Math.max(...outBlocks.map((q) => sim(p, q)), 0));
  const covered = cover.filter((s) => s >= 0.6).length;
  out.push({ tag, tok, chars: [...text].length, acc: acc * 100, blocksCovered: covered, blocksTotal: refBlocks.length });
}

console.log('token  chars   mathAcc  blocks');
for (const r of out) {
  console.log(`${String(r.tok).padStart(5)}  ${String(r.chars).padStart(5)}   ${r.acc.toFixed(1).padStart(5)}%   ${r.blocksCovered}/${r.blocksTotal}`);
}
fs.writeFileSync('docs/accuracy-vs-tokens.json', JSON.stringify(out, null, 2));

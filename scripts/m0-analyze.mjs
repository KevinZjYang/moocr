// M0 指标修正分析器
// 1) 数学归一化准确率（去 LaTeX 命令/花括号/空白）
// 2) 块级覆盖率 diff（ref 段落 → out 最佳匹配段）
// 3) 连续重复 run 检测（替代 24-gram 频率法，避免公式符号假阳性）
import fs from 'node:fs';
import path from 'node:path';

const DOCS = 'docs';

const LATEX_CMD = /\\[a-zA-Z]+\*?/g;
const BRACES = /[{}$\\]/g;

function stripLatex(s) {
  return s.replace(LATEX_CMD, '').replace(BRACES, '');
}

function normPlain(s) {
  return s.replace(/\s+/g, ' ').trim();
}

function normMath(s) {
  return stripLatex(s).replace(/\s+/g, '').toLowerCase();
}

function lev(a, b) {
  const A = [...a];
  const B = [...b];
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

function accuracy(ref, out, mode) {
  const n = mode === 'math' ? normMath : normPlain;
  const a = n(ref);
  const b = n(out);
  if (!a.length) return null;
  return Math.max(0, 1 - lev(a, b) / a.length);
}

function similarity(a, b, mode) {
  const n = mode === 'math' ? normMath : normPlain;
  const A = n(a);
  const B = n(b);
  if (!A.length || !B.length) return 0;
  return Math.max(0, 1 - lev(A, B) / Math.max(A.length, B.length));
}

/**
 * 连续重复 run 检测：找出同一 n-gram 连续重复 >= minRun 次的最大连续段。
 * 这能捕获 "the the the the" / 整段循环 这类真 degeneracy，
 * 而不会把公式里合法重复出现的符号判为重复。
 */
function detectRuns(text, n = 16, minRun = 3) {
  const c = [...text];
  const runs = [];
  let i = 0;
  while (i + n * minRun <= c.length) {
    const gram = c.slice(i, i + n).join('');
    let reps = 1;
    let j = i + n;
    while (j + n <= c.length && c.slice(j, j + n).join('') === gram) {
      reps += 1;
      j += n;
    }
    if (reps >= minRun) {
      runs.push({ offset: i, gram: gram.slice(0, 60), reps, covered: reps * n });
      i = j;
    } else {
      i += 1;
    }
  }
  return runs;
}

function repeatCoverage(text, n = 16, minRun = 3) {
  const runs = detectRuns(text, n, minRun);
  const total = [...text].length || 1;
  const covered = runs.reduce((s, r) => s + r.covered, 0);
  return { ratio: covered / total, runs: runs.slice(0, 5) };
}

function blocks(text) {
  return text.split(/\n{2,}/).map((x) => x.trim()).filter(Boolean);
}

function coverage(refText, outText, mode) {
  const R = blocks(refText);
  const O = blocks(outText);
  const rows = R.map((p, i) => {
    let best = 0;
    let bi = -1;
    O.forEach((q, j) => {
      const s = similarity(p, q, mode);
      if (s > best) { best = s; bi = j; }
    });
    return { i, sim: best, outIndex: bi, refChars: [...p].length, head: normPlain(stripLatex(p)).slice(0, 60) };
  });
  const weighted = R.reduce((s, p, i) => s + rows[i].sim * [...p].length, 0) /
    (R.reduce((s, p) => s + [...p].length, 0) || 1);
  const missing = rows.filter((r) => r.sim < 0.6);
  return { refBlocks: R.length, outBlocks: O.length, weightedSim: weighted, missing, rows };
}

const CASES = [
  { name: 'qianziwen', ref: 'fixtures/qianziwen.md', outs: ['docs/hi-qianziwen.txt'], mode: 'plain' },
  { name: 'dense-equations', ref: 'fixtures/dense-equations.md', outs: ['docs/hi-dense-equations.txt'], mode: 'math' },
  { name: 'handwrite', ref: 'fixtures/handwrite-formula.md', outs: ['docs/hi-handwrite.txt'], mode: 'math' },
  { name: 'ko', ref: null, outs: ['docs/hi-ko.txt'], mode: 'plain' },
  { name: 'ja', ref: null, outs: ['docs/hi-ja.txt'], mode: 'plain' },
];

const report = [];
for (const cs of CASES) {
  const outPath = cs.outs[0];
  if (!fs.existsSync(outPath)) continue;
  const out = fs.readFileSync(outPath, 'utf8');
  const entry = { name: cs.name, outPath, chars: [...out].length };

  if (cs.ref && fs.existsSync(cs.ref)) {
    const ref = fs.readFileSync(cs.ref, 'utf8');
    entry.accPlain = accuracy(ref, out, 'plain');
    entry.accMath = accuracy(ref, out, 'math');
    entry.refChars = [...ref].length;
    const cov = coverage(ref, out, cs.mode);
    entry.coverage = { refBlocks: cov.refBlocks, outBlocks: cov.outBlocks, weightedSim: cov.weightedSim };
    entry.missingBlocks = cov.missing;
  }
  const rep = repeatCoverage(out);
  entry.repeatRunRatio = rep.ratio;
  entry.repeatRuns = rep.runs;
  report.push(entry);
}

fs.writeFileSync(path.join(DOCS, 'capability-analyzed.json'), JSON.stringify(report, null, 2));

for (const e of report) {
  console.log(`\n=== ${e.name} (${e.chars} chars)`);
  if (e.accPlain != null) {
    console.log(`  acc plain=${(e.accPlain * 100).toFixed(1)}%  math=${(e.accMath * 100).toFixed(1)}%  refChars=${e.refChars}`);
  }
  if (e.coverage) {
    console.log(`  blocks ref=${e.coverage.refBlocks} out=${e.coverage.outBlocks}  weightedSim=${(e.coverage.weightedSim * 100).toFixed(1)}%`);
    if (e.missingBlocks.length) {
      console.log(`  missing/low blocks: ${e.missingBlocks.length}`);
      for (const m of e.missingBlocks) console.log(`    ref#${m.i} sim=${(m.sim * 100).toFixed(0)}% "${m.head}"`);
    }
  }
  console.log(`  repeatRunRatio=${(e.repeatRunRatio * 100).toFixed(2)}%  runs=${e.repeatRuns.length}`);
  for (const r of e.repeatRuns) console.log(`    x${r.reps} @${r.offset} "${r.gram}"`);
}

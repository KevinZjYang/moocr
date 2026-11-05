// Degeneration detector: multi-scale consecutive repeat runs.
// Catches real loops ("㕥㕥㕥㕥", "the the the") without flagging legitimate
// math notation repetition (which is non-consecutive).
export function detectRuns(text, { maxN = 32, minReps = 4, minN = 1 } = {}) {
  const c = [...text];
  const runs = [];
  let i = 0;
  while (i < c.length) {
    let best = null;
    for (let n = minN; n <= maxN && i + n * minReps <= c.length; n++) {
      const gram = c.slice(i, i + n).join('');
      let reps = 1;
      let j = i + n;
      while (j + n <= c.length && c.slice(j, j + n).join('') === gram) {
        reps++;
        j += n;
      }
      if (reps >= minReps) {
        const covered = reps * n;
        if (!best || covered > best.covered) best = { offset: i, gram, n, reps, covered };
      }
    }
    if (best) {
      runs.push(best);
      i = best.offset + best.covered;
    } else {
      i++;
    }
  }
  return runs;
}

export function repeatStats(text, opts) {
  const runs = detectRuns(text, opts);
  const total = [...text].length || 1;
  const covered = runs.reduce((s, r) => s + r.covered, 0);
  return { ratio: covered / total, runs };
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`) {
  const fs = await import('node:fs');
  const files = process.argv.slice(2);
  for (const f of files) {
    const t = fs.readFileSync(f, 'utf8');
    const { ratio, runs } = repeatStats(t);
    console.log(`${f}: ${(ratio * 100).toFixed(1)}% degenerate, ${runs.length} runs, ${[...t].length} chars`);
    for (const r of runs.slice(0, 4)) {
      console.log(`   x${r.reps} n=${r.n} @${r.offset} "${r.gram.slice(0, 40)}"`);
    }
  }
}

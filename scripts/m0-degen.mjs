import fs from 'node:fs';
import { repeatStats } from './degeneration.mjs';

const files = process.argv.slice(2);
for (const f of files) {
  if (!fs.existsSync(f)) { console.log(`${f}: missing`); continue; }
  const t = fs.readFileSync(f, 'utf8');
  const { ratio, runs } = repeatStats(t);
  console.log(`${f}: ${(ratio * 100).toFixed(1)}% degenerate, ${runs.length} runs, ${[...t].length} chars`);
  for (const r of runs.slice(0, 4)) {
    console.log(`   x${r.reps} n=${r.n} @${r.offset} "${r.gram.slice(0, 40)}"`);
  }
}

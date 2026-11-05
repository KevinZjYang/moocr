/**
 * 退化（重复输出）检测。
 *
 * 依据 docs/CAPABILITY.md §3.2：正常文档 / 退化扫描 / 密集公式 / 手写页的退化率都是 0%；
 * 只有在「分布外输入（生僻字）+ text prompt」时才出现真实的连续重复
 * （实测尾部单字符连续重复 81 次，占输出 55.9%）。
 *
 * 关键教训：不能用「n-gram 出现频率」判定退化 —— 公式里
 * `\boldsymbol{k}_{[t]}^{i^\top}` 合法出现 7 次会被误判为 11.2%~17.7% 重复。
 * 必须只认「同一 n-gram 连续重复」。
 */

export interface RepeatRun {
  offset: number;
  gram: string;
  n: number;
  reps: number;
  covered: number;
}

export interface RepeatStats {
  /** 被判为连续重复的字符数 / 总字符数 */
  ratio: number;
  runs: RepeatRun[];
  degenerated: boolean;
}

export interface DetectOptions {
  maxN?: number;
  minReps?: number;
  minN?: number;
  /** ratio 超过该阈值判定为退化 */
  threshold?: number;
}

const DEFAULTS: Required<Omit<DetectOptions, 'threshold'>> = {
  maxN: 32,
  minReps: 4,
  minN: 1,
};

export function detectRuns(text: string, options: DetectOptions = {}): RepeatRun[] {
  const cfg = { ...DEFAULTS, ...options };
  const chars = [...text];
  const runs: RepeatRun[] = [];
  let i = 0;

  while (i < chars.length) {
    let best: RepeatRun | null = null;
    for (let n = cfg.minN; n <= cfg.maxN && i + n * cfg.minReps <= chars.length; n++) {
      const gram = chars.slice(i, i + n).join('');
      let reps = 1;
      let j = i + n;
      while (j + n <= chars.length && chars.slice(j, j + n).join('') === gram) {
        reps += 1;
        j += n;
      }
      if (reps >= cfg.minReps) {
        const covered = reps * n;
        if (!best || covered > best.covered) best = { offset: i, gram, n, reps, covered };
      }
    }
    if (best) {
      runs.push(best);
      i = best.offset + best.covered;
    } else {
      i += 1;
    }
  }
  return runs;
}

export function repeatStats(text: string, options: DetectOptions = {}): RepeatStats {
  const threshold = options.threshold ?? 0.05;
  const runs = detectRuns(text, options);
  const total = [...text].length || 1;
  const covered = runs.reduce((s, r) => s + r.covered, 0);
  const ratio = covered / total;
  return { ratio, runs, degenerated: ratio >= threshold };
}

/** 把退化段裁掉，保留退化前的内容（用于重试也失败时的兜底） */
export function truncateDegeneration(text: string, options: DetectOptions = {}): { text: string; cut: boolean } {
  const runs = detectRuns(text, options);
  if (runs.length === 0) return { text, cut: false };
  const first = runs.reduce((a, b) => (a.offset <= b.offset ? a : b));
  const chars = [...text];
  return { text: chars.slice(0, first.offset).join('').replace(/\s+$/, ''), cut: true };
}

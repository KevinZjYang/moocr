/**
 * M1 回归：把 CLI 产物（out/*.md）与 M0 基线对照，确认管线本身没引入精度损失。
 *   node scripts/m1-regress.mjs [out目录]
 *
 * 判据：M1 输出 vs M0 实测值，plain 准确率差 > 3 分即视为回归（打印 ⚠）。
 * 注意 M1 默认 standard preset（image-max-tokens=2560），手写页在 M0 的 85.0%
 * 是 8230 token 预算下测得的，这里要用 4000 token 的 74.6% 作基线。
 */
import fs from 'node:fs';
import path from 'node:path';

const OUT = process.argv[2] ?? 'out';

const squash = (s) => s.replace(/```[a-z]*/g, '').replace(/[#*_`>]/g, '').replace(/\s+/g, '');
/** 数学归一：去掉 LaTeX 命令与括号，只留符号与字母数字 */
const mathNorm = (s) =>
  s
    .replace(/\\[a-zA-Z]+/g, '')
    .replace(/[{}$\\]/g, '')
    .replace(/[#*_`>|\s]/g, '')
    .toLowerCase();

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

const ratio = (gt, out, norm) => {
  const a = norm(gt);
  const b = norm(out);
  if (!a.length) return 0;
  return Math.max(0, 1 - lev(a, b) / a.length) * 100;
};

/** 块级覆盖率：ref 每段找 out 里最相似的段，按字符数加权 */
function blockCoverage(gt, out) {
  const refBlocks = gt.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
  const outBlocks = out.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
  // out 未分块时该指标无意义（会退化成整篇对比），返回 NaN 由调用方显示 -
  if (!refBlocks.length || outBlocks.length < 2) return NaN;
  let hit = 0;
  let total = 0;
  for (const ref of refBlocks) {
    const a = squash(ref);
    let best = 0;
    for (const o of outBlocks) {
      const b = squash(o);
      if (!b.length) continue;
      const sim = 1 - lev(a, b) / Math.max(a.length, b.length);
      if (sim > best) best = sim;
    }
    hit += best * a.length;
    total += a.length;
  }
  return total ? (hit / total) * 100 : 0;
}

const synthGT = {
  'ja-paragraph': '文書画像から本文の情報をすべて抽出し、ヘッダーとフッターを無視して、マークダウン形式で表現してください。表はOTSL形式で表現し、数式はLaTeX形式で表現してください。読み順に従って解析を整理してください。これは日本語のOCR精度を確認するためのテスト文書です。',
  'ru-paragraph': 'Извлеките всю информацию из основного текста документа и представьте её в формате Markdown, игнорируя колонтитулы. Таблицы следует выражать в формате OTSL, формулы — в формате LaTeX, а разбор должен быть организован в порядке чтения. Это тестовый документ для проверки точности распознавания русского текста.',
  'ko-paragraph': '문서 이미지에서 본문의 모든 정보를 추출하고 머리글과 바닥글을 무시한 채 마크다운 형식으로 표현하십시오. 표는 OTSL 형식으로, 수식은 LaTeX 형식으로 표현하십시오. 읽기 순서에 따라 구문 분석을 구성하십시오. 이것은 한국어 OCR 정확도를 확인하기 위한 테스트 문서입니다.',
  'ko-large': '문서 이미지에서 본문의 모든 정보를 추출하고 머리글과 바닥글을 무시한 채 마크다운 형식으로 표현하십시오. 표는 OTSL 형식으로, 수식은 LaTeX 형식으로 표현하십시오. 읽기 순서에 따라 구문 분석을 구성하십시오. 이것은 한국어 OCR 정확도를 확인하기 위한 테스트 문서입니다.',
  'zh-two-col':
    '线性注意力机制将标准注意力的二次复杂度降为线性，其核心在于用状态递推替代显式的键值缓存。在每一时刻，模型维护一个固定大小的状态矩阵，通过增量更新避免了对历史序列的重复计算。然而这种替换带来了数值稳定性问题，因为状态矩阵在长时间累积后容易出现幅度爆炸或衰减。为解决这一问题，研究者引入了门控机制与归一化策略，使状态更新具备可控的遗忘能力。本文提出的分块并行算法进一步将递推过程组织为若干块，块内使用矩阵乘法以获得张量核心加速。',
  'mix-en-zh': `混合排版测试 Mixed Layout Test
1. 引言 Introduction
本文提出一种 In-Context Learning 方法，用于 few-shot 场景。
2. 方法 Method
We compute attention as softmax(QK^T/sqrt(d))V where d is the head dim.
3. 结果 Results
在 OmniDocBench 上达到 96.83 分，较 baseline 提升 4.2 个点。`,
  'zh-vertical': '白日依山尽黄河入海流欲穷千里目更上一层楼',
  'para-blur2': '本文提出一种基于分块并行的线性注意力实现，使长序列训练可以在消费级显卡上完成。实验表明该方法在保持精度的同时将显存占用降低了约百分之四十。',
  'para-blur4': '本文提出一种基于分块并行的线性注意力实现，使长序列训练可以在消费级显卡上完成。实验表明该方法在保持精度的同时将显存占用降低了约百分之四十。',
  'para-lowcontrast': '本文提出一种基于分块并行的线性注意力实现，使长序列训练可以在消费级显卡上完成。实验表明该方法在保持精度的同时将显存占用降低了约百分之四十。',
  'para-lowres': '本文提出一种基于分块并行的线性注意力实现，使长序列训练可以在消费级显卡上完成。实验表明该方法在保持精度的同时将显存占用降低了约百分之四十。',
  'para-noisy': '本文提出一种基于分块并行的线性注意力实现，使长序列训练可以在消费级显卡上完成。实验表明该方法在保持精度的同时将显存占用降低了约百分之四十。',
};

/** M0 基线（docs/CAPABILITY.md）。math/block 为空表示 M0 未测该项 */
const BASELINE = {
  'qianziwen': { plain: 85.7, note: '繁体→简体差异' },
  'dense-equations': { plain: 79.1, math: 94.8, block: 96.4 },
  'handwrite-formula': { plain: 74.6, note: '4000 token 预算；M0 的 math/block 基线来自 8230 token，不可直接比' },
  'receipt': { plain: 100 },
  'ja-paragraph': { plain: 100 },
  'ru-paragraph': { plain: 100 },
  'ko-paragraph': { plain: 86.2, note: '模型级缺陷' },
  'ko-large': { plain: 87.0, note: '模型级缺陷' },
  'zh-two-col': { plain: 100 },
  'mix-en-zh': { plain: 100 },
  'zh-vertical': { plain: 80, note: 'M0 多输出标点' },
};

const fileGT = {
  'qianziwen': 'fixtures/qianziwen.md',
  'dense-equations': 'fixtures/dense-equations.md',
  'handwrite-formula': 'fixtures/handwrite-formula.md',
  'receipt': 'fixtures/receipt.md',
};

const pad = (s, n) => String(s).padEnd(n);
const num = (v, w = 5) => (v === undefined || Number.isNaN(v) ? '-'.padStart(w) : v.toFixed(1).padStart(w));

console.log(`回归目录 ${OUT}\n`);
console.log(`${pad('case', 20)}${pad('plain', 7)}${pad('M0', 7)}${pad('Δ', 7)}${pad('math', 6)}${pad('block', 7)}状态`);
console.log('-'.repeat(74));

let regressed = 0;
let missing = 0;

for (const name of Object.keys(BASELINE)) {
  const mdPath = path.join(OUT, `${name}.md`);
  if (!fs.existsSync(mdPath)) {
    console.log(`${pad(name, 20)}${pad('-', 7)}${pad(num(BASELINE[name].plain), 7)}${pad('', 7)}missing`);
    missing++;
    continue;
  }
  const out = fs.readFileSync(mdPath, 'utf8');

  let gt = synthGT[name];
  if (!gt && fileGT[name]) {
    gt = fs.existsSync(fileGT[name]) ? fs.readFileSync(fileGT[name], 'utf8') : undefined;
  }
  if (!gt) {
    console.log(`${pad(name, 20)}无 GT`);
    continue;
  }

  const plain = ratio(gt, out, squash);
  const math = ratio(gt, out, mathNorm);
  // 内容已逐字相同，分块覆盖率没有额外信息
  const block = plain >= 99.5 ? NaN : blockCoverage(gt, out);
  const base = BASELINE[name].plain;
  const delta = plain - base;
  const flag = delta < -3 ? '⚠ 回归' : delta > 3 ? '↑ 提升' : 'ok';
  if (delta < -3) regressed++;

  console.log(
    `${pad(name, 20)}${pad(num(plain), 7)}${pad(num(base), 7)}${pad((delta >= 0 ? '+' : '') + delta.toFixed(1), 7)}` +
      `${pad(num(math), 6)}${pad(num(block), 7)}${flag}`
  );
}

console.log('-'.repeat(74));
console.log(`回归 ${regressed} 项，缺失 ${missing} 项`);
if (missing) console.log(`提示：先运行 node packages/cli/src/main.ts fixtures --parallel 4 --out ${OUT}`);
if (regressed) process.exitCode = 1;

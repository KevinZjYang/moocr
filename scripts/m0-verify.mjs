// Verify the A/B grade claims: compare batch2 + bench outputs against known GT.
import fs from 'node:fs';

const squash = (s) => s.replace(/```[a-z]*/g, '').replace(/[#*_`>]/g, '').replace(/\s+/g, '');

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

const acc = (gt, out) => {
  const a = squash(gt);
  const b = squash(out);
  return { acc: Math.max(0, 1 - lev(a, b) / a.length) * 100, gtLen: a.length, outLen: b.length };
};

const GT = {
  ja: '文書画像から本文の情報をすべて抽出し、ヘッダーとフッターを無視して、マークダウン形式で表現してください。表はOTSL形式で表現し、数式はLaTeX形式で表現してください。読み順に従って解析を整理してください。これは日本語のOCR精度を確認するためのテスト文書です。',
  ru: 'Извлеките всю информацию из основного текста документа и представьте её в формате Markdown, игнорируя колонтитулы. Таблицы следует выражать в формате OTSL, формулы — в формате LaTeX, а разбор должен быть организован в порядке чтения. Это тестовый документ для проверки точности распознавания русского текста.',
  ko: '문서 이미지에서 본문의 모든 정보를 추출하고 머리글과 바닥글을 무시한 채 마크다운 형식으로 표현하십시오. 표는 OTSL 형식으로, 수식은 LaTeX 형식으로 표현하십시오. 읽기 순서에 따라 구문 분석을 구성하십시오. 이것은 한국어 OCR 정확도를 확인하기 위한 테스트 문서입니다.',
  zhTwoCol:
    '线性注意力机制将标准注意力的二次复杂度降为线性，其核心在于用状态递推替代显式的键值缓存。在每一时刻，模型维护一个固定大小的状态矩阵，通过增量更新避免了对历史序列的重复计算。然而这种替换带来了数值稳定性问题，因为状态矩阵在长时间累积后容易出现幅度爆炸或衰减。为解决这一问题，研究者引入了门控机制与归一化策略，使状态更新具备可控的遗忘能力。本文提出的分块并行算法进一步将递推过程组织为若干块，块内使用矩阵乘法以获得张量核心加速。',
  mixEnZh: `混合排版测试 Mixed Layout Test
1. 引言 Introduction
本文提出一种 In-Context Learning 方法，用于 few-shot 场景。
2. 方法 Method
We compute attention as softmax(QK^T/sqrt(d))V where d is the head dim.
3. 结果 Results
在 OmniDocBench 上达到 96.83 分，较 baseline 提升 4.2 个点。`,
  para: '本文提出一种基于分块并行的线性注意力实现，使长序列训练可以在消费级显卡上完成。实验表明该方法在保持精度的同时将显存占用降低了约百分之四十。',
};

const CASES = [
  ['ja', 'docs/batch2/ja-paragraph.txt', GT.ja],
  ['ja(hi)', 'docs/hi-ja.txt', GT.ja],
  ['ru', 'docs/batch2/ru-paragraph.txt', GT.ru],
  ['ko', 'docs/hi-ko.txt', GT.ko],
  ['ko-large', 'docs/batch2/ko-large.txt', GT.ko],
  ['zh-two-col', 'docs/batch2/zh-two-col.txt', GT.zhTwoCol],
  ['mix-en-zh', 'docs/batch2/mix-en-zh.txt', GT.mixEnZh],
];

for (const [name, file, gt] of CASES) {
  if (!fs.existsSync(file)) { console.log(`${name.padEnd(12)} missing ${file}`); continue; }
  const out = fs.readFileSync(file, 'utf8');
  const r = acc(gt, out);
  console.log(`${name.padEnd(12)} acc=${r.acc.toFixed(1).padStart(5)}%   len=${String(r.outLen).padStart(4)}/${r.gtLen}`);
}

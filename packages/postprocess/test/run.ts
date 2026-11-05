/**
 * postprocess 纯逻辑回归测试。无框架，`node packages/postprocess/test/run.ts` 直接跑。
 * 断言用真实模型输出（docs/batch2/table-merged.txt、docs/nonce-cjk-*.txt）作为 input。
 */
import fs from 'node:fs';
import path from 'node:path';
import { buildOtslTable, otslToHtml, parseOtsl, looksLikeOtsl } from '../src/otsl.ts';
import { repeatStats, truncateDegeneration } from '../src/degeneration.ts';
import { normalizeMarkdown, summarizeMarkdown, stripCodeFence } from '../src/markdown.ts';
import { splitBlocks } from '../src/html.ts';

const ROOT = path.resolve(import.meta.dirname, '../../..');
let pass = 0;
let fail = 0;

function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}`);
    if (detail !== undefined) console.log('       ', JSON.stringify(detail));
  }
}

function eq(name: string, actual: unknown, expected: unknown) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });
}

// ---------------------------------------------------------------- OTSL 解析
console.log('\n[otsl] parse');

const mergedRaw = fs.readFileSync(path.join(ROOT, 'docs/batch2/table-merged.txt'), 'utf8').trim();
const merged = buildOtslTable(mergedRaw);

eq('merged: rows', merged.rows, 3);
eq('merged: cols', merged.cols, 4);
check('merged: 无归属失败警告', merged.warnings.length === 0, merged.warnings);

const quarter = merged.cells.find((c) => c.text === '季度');
check('merged: 季度 rowspan=2', quarter?.rowspan === 2, quarter);
eq('merged: 季度 colspan', quarter?.colspan, 1);

const prodline = merged.cells.find((c) => c.text === '产品线');
check('merged: 产品线 colspan=2', prodline?.colspan === 2, prodline);

const q1 = merged.cells.find((c) => c.text === 'Q1');
check('merged: Q1 在 row 2 col 0', q1?.row === 2 && q1?.col === 0, q1);

const hw = merged.cells.find((c) => c.text === '硬件');
check('merged: 硬件 在 row 1 col 1', hw?.row === 1 && hw?.col === 1, hw);

// table-simple 的官方 OTSL（实测输出）
const simpleOtsl =
  '<fcel>项目<fcel>数量<fcel>单价<fcel>金额<nl>' +
  '<fcel>笔记本电脑<fcel>2<fcel>5999.00<fcel>11998.00<nl>' +
  '<fcel>显示器<fcel>3<fcel>1499.00<fcel>4497.00<nl>' +
  '<fcel>机械键盘<fcel>5<fcel>399.00<fcel>1995.00<nl>' +
  '<fcel>合计<ecel><ecel><fcel>18490.00<nl>';
const simple = buildOtslTable(simpleOtsl);
eq('simple: rows', simple.rows, 5);
eq('simple: cols', simple.cols, 4);
eq('simple: 单元格数（20 格，无合并）', simple.cells.length, 20);
eq('simple: 合计行末格', simple.grid[4][3], '18490.00');
eq('simple: 合计行空列', [simple.grid[4][1], simple.grid[4][2]], ['', '']);

// 无标签文本不会被误判为表格
check('非 OTSL 不匹配', !looksLikeOtsl('# 标题\n普通段落 <b>bold</b>'));

// 行尾自由文本 → trailing
const withTrailing = buildOtslTable('<fcel>a<fcel>b<nl>这段是表格之后的说明。');
eq('trailing 被切出', withTrailing.rows, 1);
check('trailing 内容', withTrailing.trailing.includes('说明'), withTrailing.trailing);

// 孤立 lcel / ucel 必须降级而非抛错
const orphan = buildOtslTable('<lcel>x<nl><ucel>y<nl>');
check('行首孤立的 lcel 产生 warning', orphan.warnings.some((w) => w.includes('<lcel>')), orphan.warnings);
eq('孤立 lcel 降级后仍有 2 行', orphan.rows, 2);

// 第一行就出现 ucel：没有上邻，必须降级
const orphanU = buildOtslTable('<ucel>a<fcel>b<nl><fcel>c<fcel>d<nl>');
check('首行 ucel 产生 warning', orphanU.warnings.some((w) => w.includes('<ucel>')), orphanU.warnings);
eq('首行 ucel 降级为空格', orphanU.grid[0][0], '');

// 跨行合并：第二行的 ucel 合并到上一行是合法行为，不应告警
const stacked = buildOtslTable('<fcel>a<fcel>b<nl><ucel><fcel>c<nl>');
check('合法 ucel 不告警', stacked.warnings.length === 0, stacked.warnings);
eq('合法 ucel 得到 rowspan=2', stacked.cells.find((c) => c.text === 'a')?.rowspan, 2);

// HTML 输出
console.log('\n[otsl] html');
const html = otslToHtml(mergedRaw);
check('html: 有 colspan="2"', html.html.includes('colspan="2"'), html.html);
check('html: 有 rowspan="2"', html.html.includes('rowspan="2"'), html.html);
check('html: 行数正确', (html.html.match(/<tr>/g) ?? []).length === 3);
check('html: 转义 &', otslToHtml('<fcel>a & b<fcel>c<nl>').html.includes('a &amp; b'));

const headered = otslToHtml(simpleOtsl, { firstRowAsHeader: true });
check('html: thead 模式', headered.html.includes('<thead>') && headered.html.includes('</thead>'));

// ---------------------------------------------------------------- 退化检测
console.log('\n[degen]');

const degenPath = path.join(ROOT, 'docs/nonce-cjk-text.txt');
if (fs.existsSync(degenPath)) {
  const t = fs.readFileSync(degenPath, 'utf8');
  const s = repeatStats(t);
  check('生僻字+text prompt 判定为退化', s.degenerated, s.ratio);
  check('退化率 > 40%', s.ratio > 0.4, s.ratio);
  const tr = truncateDegeneration(t);
  check('截断后不含长串重复', !repeatStats(tr.text).degenerated);
  check('截断确实发生', tr.cut);
}

const densePath = path.join(ROOT, 'docs/hi-dense-equations.txt');
if (fs.existsSync(densePath)) {
  const t = fs.readFileSync(densePath, 'utf8');
  const s = repeatStats(t);
  check('公式页不得误报退化', !s.degenerated, { ratio: s.ratio, runs: s.runs.length });
}

const handPath = path.join(ROOT, 'docs/hi-handwrite.txt');
if (fs.existsSync(handPath)) {
  const s = repeatStats(fs.readFileSync(handPath, 'utf8'));
  check('手写页不得误报退化', !s.degenerated, s.ratio);
}

// 人工构造的退化
check('短串不误报', !repeatStats('the cat sat on the mat').degenerated);
check('重复短语被判退化', repeatStats('好的'.repeat(40)).degenerated);
check('单字连发被判退化', repeatStats('啊'.repeat(50)).degenerated);

// ---------------------------------------------------------------- markdown
console.log('\n[markdown]');

eq('剥围栏', stripCodeFence('```markdown\n# 标题\n```'), '# 标题');
eq('无围栏不变', stripCodeFence('# 标题'), '# 标题');

const nm = normalizeMarkdown(`# 文档标题\n\n${simpleOtsl}\n\n表格之后的说明文字。`);
check('markdown: 含 HTML 表格', nm.markdown.includes('<table'), nm.markdown.slice(0, 120));
check('markdown: 保留标题', nm.markdown.startsWith('# 文档标题'));
check('markdown: 保留 trailing', nm.markdown.includes('表格之后的说明文字'));
eq('markdown: 收集 1 张表', nm.tables.length, 1);
// 回归：<nl> 曾被提前替换成换行，导致整表塌成一行（CLI 冒烟时发现）
eq('markdown: 内嵌表保留 5 行', nm.tables[0].table.rows, 5);
eq('markdown: 内嵌表保留 4 列', nm.tables[0].table.cols, 4);
eq('markdown: HTML 里 5 个 tr', (nm.markdown.match(/<tr>/g) ?? []).length, 5);

// 模型用真换行代替 <nl> 时也要能分行
const realNewlines = normalizeMarkdown(
  '<fcel>a<fcel>b\n<fcel>c<fcel>d'
);
eq('markdown: 真换行也当行分隔', realNewlines.tables[0].table.rows, 2);

const sm = summarizeMarkdown(nm.markdown);
check('summary: 统计到 1 张表', sm.tables === 1, sm);

const latex = '行内 \\(a^2+b^2\\) 与块级：\n\n\\[E=mc^2\\]\n';
const ln = normalizeMarkdown(latex);
check('markdown: LaTeX 未被破坏', ln.markdown.includes('\\[E=mc^2\\]') && ln.markdown.includes('\\(a^2+b^2\\)'));

// 纯文本任务输出不应被改动
const pure = normalizeMarkdown('这是一行纯文本，没有 markdown 结构。');
eq('纯文本原样保留', pure.markdown, '这是一行纯文本，没有 markdown 结构。');

// ---------------------------------------------------------------- splitBlocks 的块边界
// 模型常把整页公式压成单行 `\[\begin{array}{l} A \\ B \end{array}\]`，
// 早先的实现会一路吞到文件末尾没有闭合标记的行为止，把后面的段落一起吃掉。
{
  const md = '\\[\\begin{array}{l} E = mc^2 \\\\ a + b \\end{array}\\]\n\n后面的段落不能丢。';
  const bs = splitBlocks(md);
  eq('splitBlocks 单行公式块数', bs.length, 2);
  eq('splitBlocks 单行公式 kind', bs[0]?.kind, 'math');
  check('splitBlocks 单行公式内容', (bs[0]?.text ?? '').includes('\\begin{array}'), String(bs[0]?.text));
  eq('splitBlocks 后续段落', bs[1]?.lines, ['后面的段落不能丢。']);
}

// 多行 `\[ ... \]` 仍要正确合并
{
  const bs = splitBlocks('\\[\na^2\n+b^2\n\\]\n\ntail');
  eq('splitBlocks 多行公式块数', bs.length, 2);
  eq('splitBlocks 多行公式 kind', bs[0]?.kind, 'math');
  eq('splitBlocks 多行公式内容', bs[0]?.text, 'a^2\n+b^2');
}

// ---------------------------------------------------------------- 汇总
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

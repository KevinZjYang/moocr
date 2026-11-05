/**
 * 导出格式断言（node --experimental-strip-types 直接跑）。
 * 重点：文本必须 escape、表格标签必须原样保留、docx 必须是合法 zip。
 */
import zlib from 'node:zlib';
import { toMarkdown, toHtmlDocument, toDocxBuffer } from '../src/index.ts';
import { parseTableHtml } from '../../postprocess/src/html.ts';

/** 从内存里的 zip 取一个条目（只需支持 stored / deflate，够读 docx） */
function readZipEntry(zip: Buffer, name: string): string | null {
  let eocd = -1;
  for (let i = zip.length - 22; i >= 0; i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;

  const count = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);

  for (let n = 0; n < count; n++) {
    if (zip.readUInt32LE(p) !== 0x02014b50) return null;
    const method = zip.readUInt16LE(p + 10);
    const compSize = zip.readUInt32LE(p + 20);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const localOff = zip.readUInt32LE(p + 42);
    const entry = zip.subarray(p + 46, p + 46 + nameLen).toString('utf8');

    if (entry === name) {
      const lNameLen = zip.readUInt16LE(localOff + 26);
      const lExtraLen = zip.readUInt16LE(localOff + 28);
      const start = localOff + 30 + lNameLen + lExtraLen;
      const data = zip.subarray(start, start + compSize);
      return method === 0 ? data.toString('utf8') : zlib.inflateRawSync(data).toString('utf8');
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

let passed = 0;
const fails: string[] = [];

function ok(name: string, cond: boolean, extra = ''): void {
  if (cond) passed++;
  else fails.push(`${name}${extra ? ` — ${extra}` : ''}`);
}

function eq(name: string, actual: unknown, expected: unknown): void {
  ok(name, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)}`);
}

// ---- 表格解析 ----
{
  const t = parseTableHtml(
    '<table><tbody><tr><th rowspan="2">季度</th><th colspan="2">产品线</th></tr>' +
      '<tr><td>硬件</td><td>软件</td></tr></tbody></table>'
  );
  eq('parse rows', t.rows.length, 2);
  eq('parse row0 cells', t.rows[0].length, 2);
  eq('parse rowspan', t.rows[0][0].rowspan, 2);
  eq('parse colspan', t.rows[0][1].colspan, 2);
  eq('parse header flag', t.rows[0][0].header, true);
  eq('parse row1 text', t.rows[1].map((c) => c.text), ['硬件', '软件']);
}

// ---- Markdown 拼接 ----
{
  const single = toMarkdown([{ label: 'a.png', markdown: '# T\n\nbody' }]);
  eq('md single no label', single.trim(), '# T\n\nbody');

  const multi = toMarkdown([
    { label: 'p1', markdown: 'one' },
    { label: 'p2', markdown: 'two' },
  ]);
  ok('md multi has labels', multi.includes('## p1') && multi.includes('## p2'));
  ok('md multi has rule', multi.includes('\n---\n'));

  const withTitle = toMarkdown([{ label: 'p1', markdown: 'x' }], { title: 'T' });
  eq('md single ignores title', withTitle.trim(), 'x');
}

// ---- HTML ----
{
  const html = toHtmlDocument([
    { label: 'p1', markdown: '# 标题\n\n正文 **粗** 与 `代码`' },
    { label: 'p2', markdown: '- a\n- b' },
  ]);
  ok('html doctype', html.startsWith('<!DOCTYPE html>'));
  ok('html h1', html.includes('<h1>标题</h1>'));
  ok('html bold', html.includes('<strong>粗</strong>'));
  ok('html code', html.includes('<code>代码</code>'));
  ok('html ul', html.includes('<ul><li>a</li><li>b</li></ul>'));
  ok('html page label', html.includes('page-label'));
  ok('html no script', !/<script/i.test(html));
}

// ---- XSS：模型输出里的标签必须被转义 ----
{
  const html = toHtmlDocument([{ label: 'p', markdown: 'hello <img src=x onerror=alert(1)> world' }]);
  ok('escape img', !html.includes('<img'), html.slice(html.indexOf('hello'), html.indexOf('hello') + 80));
  ok('escape text kept', html.includes('hello &lt;img src=x onerror=alert(1)&gt; world'));

  const html2 = toHtmlDocument([{ label: 'p', markdown: 'a <b>bold</b> c' }]);
  ok('escape bold tag', html2.includes('&lt;b&gt;bold&lt;/b&gt;'));
}

// ---- 表格块原样保留（是我们自己生成的） ----
{
  const table = '<table class="otsl-table"><tbody><tr><td colspan="2">x</td></tr></tbody></table>';
  const html = toHtmlDocument([{ label: 'p', markdown: `before\n\n${table}\n\nafter` }]);
  ok('table preserved', html.includes('<table class="otsl-table">'));
  ok('table colspan kept', html.includes('colspan="2"'));
  ok('text around table', html.includes('<p>before</p>') && html.includes('<p>after</p>'));
}

// ---- 公式 ----
{
  const inline = toHtmlDocument([{ label: 'p', markdown: 'value $E=mc^2$ end' }]);
  ok('inline math', inline.includes('<span class="math-inline">E=mc^2</span>'));

  const block = toHtmlDocument([{ label: 'p', markdown: '\\[\na^2+b^2=c^2\n\\]' }]);
  ok('block math', block.includes('<div class="math-block">a^2+b^2=c^2</div>'));
}

// ---- DOCX ----
{
  const buf = await toDocxBuffer([
    { label: 'p1', markdown: '# 标题\n\n段落 **粗**\n\n<table><tr><td rowspan="2">a</td><td>b</td></tr><tr><td>c</td></tr></table>' },
  ]);
  ok('docx is zip', buf.subarray(0, 2).toString('hex') === '504b', buf.subarray(0, 2).toString('hex'));
  ok('docx size sane', buf.length > 5000 && buf.length < 5_000_000, String(buf.length));
}

// ---- DOCX 公式必须是 OMML，不能是 LaTeX 源码 ----
// 真实输入：out/formula-simple.md 是单行 `\[\begin{array}{l} ... \\ ... \end{array}\]`
{
  const md =
    '\\[\\begin{array}{l} E = m c ^ {2} \\\\ ' +
    '\\int_ {- 0 ^ {\\infty}} e ^ {\\{- x ^ {2} \\}} d x = \\sqrt {\\pi} / 2 ' +
    '\\end{array}\\]\n\n行内 $a^2 + b^2 = c^2$ 随文字排版。';
  const buf = await toDocxBuffer([{ label: 'p3', markdown: md }]);
  const xml = readZipEntry(buf, 'word/document.xml') ?? '';

  const mathCount = (xml.match(/<m:oMath[ >]/g) ?? []).length;
  ok('docx 公式生成 OMML', mathCount >= 2, `oMath=${mathCount}`);
  ok('docx 无 LaTeX 源码残留', !/\\begin\{array\}|\\int_|\\sqrt/.test(xml));
  ok('docx 声明 m 命名空间', /xmlns:m=/.test(xml));
  ok('docx 行内公式也转 OMML', mathCount >= 2);
}

// 转换失败时不能整份崩掉：保留 LaTeX 原文但文档仍可生成
{
  const buf = await toDocxBuffer([{ label: 'x', markdown: '\\[\\undefinedmacro{a}\\]' }]);
  ok('docx 坏公式仍产出文件', buf.subarray(0, 2).toString('hex') === '504b');
  const xml = readZipEntry(buf, 'word/document.xml') ?? '';
  ok('docx 坏公式回退文本', xml.includes('undefinedmacro') || /<m:oMath[ >]/.test(xml));
}

console.log(`${passed} passed, ${fails.length} failed`);
if (fails.length) {
  for (const f of fails) console.log(`  FAIL ${f}`);
  process.exitCode = 1;
}

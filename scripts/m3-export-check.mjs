// 导出格式自检：用 out/ 里的真实识别结果生成 md/html/docx，检查大小与关键结构。
import fs from 'node:fs';
import path from 'node:path';
import { toMarkdown, toHtmlDocument, toDocxBuffer } from '../packages/exporters/src/index.ts';
import { parseTableHtml } from '../packages/postprocess/src/html.ts';

const OUT = 'out';
const TMP = 'out/_export';
fs.mkdirSync(TMP, { recursive: true });

const names = fs.readdirSync(OUT).filter((f) => f.endsWith('.md'));
const pages = names.map((f) => ({
  label: path.basename(f, '.md'),
  markdown: fs.readFileSync(path.join(OUT, f), 'utf8'),
}));
console.log(`pages: ${pages.length}`);

const md = toMarkdown(pages, { title: 'moocr 批量识别' });
fs.writeFileSync(path.join(TMP, 'all.md'), md);
console.log(`markdown ${md.length} chars`);

const html = toHtmlDocument(pages, { title: 'moocr 批量识别' });
fs.writeFileSync(path.join(TMP, 'all.html'), html);
console.log(`html ${html.length} chars`);
if (/<script/i.test(html)) throw new Error('html 含 script');
if (!html.includes('<table>') || !html.includes('colspan="2"')) console.log('warn: 未找到合并表格');

const buffer = await toDocxBuffer(pages, { title: 'moocr 批量识别' });
fs.writeFileSync(path.join(TMP, 'all.docx'), buffer);
console.log(`docx ${buffer.length} bytes, zip=${buffer.subarray(0, 2).toString('hex')}`);

// 表格解析自检
const t = parseTableHtml(
  '<table><tr><th rowspan="2">季度</th><th colspan="2">产品线</th><th>营收</th></tr>' +
    '<tr><td>硬件</td><td>软件</td><td>100</td></tr></table>'
);
console.log('table rows', t.rows.length, 'row0', t.rows[0].map((c) => `${c.text}|${c.colspan}x${c.rowspan}`).join(' '));

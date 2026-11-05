// 用 out/ 里真实的三页识别结果生成 docx（表格页 + 公式页），供 Word 渲染检查
import fs from 'node:fs';
import { toDocx } from '../packages/exporters/src/docx.ts';

const pages = [
  { label: 'p1 混合排版', markdown: fs.readFileSync('out/mix-en-zh.md', 'utf8') },
  { label: 'p2 合并单元格表格', markdown: fs.readFileSync('out/table-merged.md', 'utf8') },
  { label: 'p3 公式', markdown: fs.readFileSync('out/formula-simple.md', 'utf8') },
];

const buf = await toDocx(pages, { title: 'moocr 导出检查' });
fs.writeFileSync('out/_m3/real3.docx', buf);
console.log(`docx ${buf.length} bytes, pages ${pages.length}`);

/**
 * Markdown → DOCX。
 *
 * 只用 docx 库的基础构件，不做花哨排版：
 *   - 标题 → HeadingLevel
 *   - 段落 → Paragraph（行内 code/bold/italic 转 TextRun）
 *   - HTML 表格 → docx Table（保留 colspan/rowspan）
 *   - LaTeX → 真正的 Word 公式（OMML）
 *
 * 公式为什么必须转 OMML：Word 不认 LaTeX，早先直接塞等宽文本，
 * 用户看到的是 `E = m c ^{2}\] \[ \int_...` 这种源码。现在走
 * temml(MathML) → mathml2omml(OMML)，失败才回退纯文本 —— 一条公式
 * 转不出来不该让整份文档失败。
 */
import {
  AlignmentType,
  BorderStyle,
  Document,
  HeadingLevel,
  ImportedXmlComponent,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';
import { parseTableHtml, splitBlocks } from '../../postprocess/src/html.ts';
import { latexToOmml, splitInlineMath, withMathNs } from './math-omml.ts';
import type { ExportPage, ExportOptions } from './index.ts';

const HEADINGS = [
  HeadingLevel.HEADING_1,
  HeadingLevel.HEADING_2,
  HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4,
  HeadingLevel.HEADING_5,
  HeadingLevel.HEADING_6,
];

const MONO = 'Consolas';
const SANS = 'Microsoft YaHei';

type Run = TextRun | ImportedXmlComponent;

/** 把一段纯文本按 **粗体** / *斜体* / `代码` 拆成 TextRun */
function styledRuns(text: string, base: { font?: string; size?: number } = {}): TextRun[] {
  const runs: TextRun[] = [];
  const re = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;

  while ((m = re.exec(text))) {
    if (m.index > last) runs.push(new TextRun({ text: text.slice(last, m.index), ...base }));
    const tok = m[0];
    if (tok.startsWith('`')) {
      runs.push(new TextRun({ text: tok.slice(1, -1), font: MONO, ...base, size: base.size }));
    } else if (tok.startsWith('**')) {
      runs.push(new TextRun({ text: tok.slice(2, -2), bold: true, ...base }));
    } else {
      runs.push(new TextRun({ text: tok.slice(1, -1), italics: true, ...base }));
    }
    last = m.index + tok.length;
  }
  if (last < text.length) runs.push(new TextRun({ text: text.slice(last), ...base }));
  return runs;
}

/** 行内标记 + 行内公式 → runs（公式优先，避免 $..$ 里的 * 被当强调） */
async function inlineRuns(text: string, base: { font?: string; size?: number } = {}): Promise<Run[]> {
  const runs: Run[] = [];
  for (const part of splitInlineMath(text)) {
    if (!part.math) {
      runs.push(...styledRuns(part.text, base));
      continue;
    }
    const omml = await latexToOmml(part.text, false);
    if (omml) runs.push(ImportedXmlComponent.fromXmlString(withMathNs(omml)));
    else runs.push(new TextRun({ text: `$${part.text}$`, font: MONO, ...base }));
  }
  return runs.length ? runs : [new TextRun({ text: '', ...base })];
}

/**
 * 模型常把一整页公式写成 `\begin{array}{l} A \\ B \\ C \end{array}`。
 * 拆成一行一条，各自成段，比塞进一个矩阵好看得多。
 */
function splitArrayRows(tex: string): string[] | null {
  const m = tex.match(/^\s*\\begin\{array\}\{[^}]*\}([\s\S]*?)\\end\{array\}\s*$/);
  if (!m) return null;
  const rows = m[1]
    .split(/\\\\/)
    .map((r) => r.replace(/^\s*\[[^\]]*\]/, '').trim())
    .filter((r) => r.length > 0);
  return rows.length > 0 ? rows : null;
}

/** 块公式 → 居中段落；转不出来就退回等宽源码 + 明确标记 */
async function mathParagraphs(tex: string): Promise<Paragraph[]> {
  const src = tex.trim();
  if (!src) return [];

  const rows = splitArrayRows(src) ?? [src];
  const out: Paragraph[] = [];
  const leftovers: string[] = [];

  for (const row of rows) {
    const omml = await latexToOmml(row, true);
    if (omml) {
      out.push(
        new Paragraph({
          children: [ImportedXmlComponent.fromXmlString(withMathNs(omml))],
          alignment: AlignmentType.CENTER,
          spacing: { before: 120, after: 120 },
        })
      );
    } else {
      leftovers.push(row);
    }
  }

  if (leftovers.length > 0) {
    out.push(
      new Paragraph({
        children: [new TextRun({ text: leftovers.join('\n'), font: MONO, size: 20 })],
        indent: { left: 360 },
        spacing: { before: 120, after: 120 },
      })
    );
  }
  return out;
}

async function tableFromHtml(html: string): Promise<Table | null> {
  const parsed = parseTableHtml(html);
  if (!parsed.rows.length) return null;

  const rows: TableRow[] = [];
  for (const cells of parsed.rows) {
    const tcs: TableCell[] = [];
    for (const c of cells) {
      const children = await inlineRuns(c.text, { font: SANS, size: 20 });
      tcs.push(
        new TableCell({
          children: [new Paragraph({ children })],
          columnSpan: c.colspan > 1 ? c.colspan : undefined,
          rowSpan: c.rowspan > 1 ? c.rowspan : undefined,
          margins: { top: 60, bottom: 60, left: 100, right: 100 },
          ...(c.header ? { shading: { fill: 'F2F4F7' } } : {}),
        })
      );
    }
    rows.push(new TableRow({ children: tcs, tableHeader: cells.every((c) => c.header) }));
  }

  return new Table({
    rows,
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: {
      top: { style: BorderStyle.SINGLE, size: 4, color: 'C8CCD2' },
      bottom: { style: BorderStyle.SINGLE, size: 4, color: 'C8CCD2' },
      left: { style: BorderStyle.SINGLE, size: 4, color: 'C8CCD2' },
      right: { style: BorderStyle.SINGLE, size: 4, color: 'C8CCD2' },
      insideHorizontal: { style: BorderStyle.SINGLE, size: 4, color: 'C8CCD2' },
      insideVertical: { style: BorderStyle.SINGLE, size: 4, color: 'C8CCD2' },
    },
  });
}

async function blockChildren(markdown: string): Promise<(Paragraph | Table)[]> {
  const out: (Paragraph | Table)[] = [];
  // 模型输出的有序列表常被空行拆成多个块（`1. 引言` / 空行 / 正文 / `2. 方法`），
  // 每块单独从 1 开始会变成「1. 1. 1.」。这里跨块延续编号，遇到非列表块才归零。
  let olNext = 1;

  for (const b of splitBlocks(markdown)) {
    if (b.kind === 'heading') olNext = 1;

    switch (b.kind) {
      case 'table': {
        const t = await tableFromHtml(b.html ?? '');
        if (t) out.push(t);
        else out.push(new Paragraph({ children: await inlineRuns(b.html ?? '', { font: SANS }) }));
        break;
      }
      case 'math':
        out.push(...(await mathParagraphs(b.text ?? '')));
        break;
      case 'code':
        for (const line of (b.text ?? '').split('\n')) {
          out.push(new Paragraph({ children: [new TextRun({ text: line, font: MONO, size: 20 })] }));
        }
        break;
      case 'heading':
        out.push(
          new Paragraph({
            children: await inlineRuns(b.text ?? '', { font: SANS }),
            heading: HEADINGS[Math.min((b.level ?? 1) - 1, HEADINGS.length - 1)],
            spacing: { before: 240, after: 120 },
          })
        );
        break;
      case 'ul':
        for (const line of b.lines ?? []) {
          out.push(new Paragraph({ children: await inlineRuns(line, { font: SANS }), bullet: { level: 0 } }));
        }
        break;
      case 'ol': {
        const lines = b.lines ?? [];
        for (const line of lines) {
          out.push(
            new Paragraph({
              children: [new TextRun({ text: `${olNext++}. `, font: SANS }), ...(await inlineRuns(line, { font: SANS }))],
              indent: { left: 360, hanging: 180 },
            })
          );
        }
        break;
      }
      case 'p':
        out.push(
          new Paragraph({
            children: await inlineRuns((b.lines ?? []).join('\n'), { font: SANS }),
            alignment: AlignmentType.LEFT,
            spacing: { after: 120 },
          })
        );
        break;
    }
  }

  return out;
}

export async function toDocx(pages: ExportPage[], opts: ExportOptions = {}): Promise<Buffer> {
  const children: (Paragraph | Table)[] = [];

  if (opts.title) {
    children.push(
      new Paragraph({ children: [new TextRun({ text: opts.title, bold: true, size: 32 })], spacing: { after: 240 } })
    );
  }

  for (let idx = 0; idx < pages.length; idx++) {
    const p = pages[idx];
    if (pages.length > 1) {
      children.push(
        new Paragraph({
          children: [new TextRun({ text: p.label, bold: true, size: 24, color: '6B7280' })],
          spacing: { before: idx === 0 ? 0 : 320, after: 160 },
        })
      );
    }
    children.push(...(await blockChildren(p.markdown)));
  }

  const doc = new Document({
    styles: {
      default: {
        document: {
          run: { font: SANS, size: 22 },
          paragraph: { spacing: { line: 300 } },
        },
      },
    },
    sections: [{ children }],
  });

  return Packer.toBuffer(doc);
}

/**
 * 导出：Markdown / HTML / DOCX。
 *
 * 输入统一是 [{ label, markdown }]，markdown 已由管线渲染完成
 * （表格是 HTML <table>，公式是 LaTeX 原文）。
 */
import { toHtml, type HtmlPage } from '../../postprocess/src/html.ts';
import { toDocx } from './docx.ts';

export interface ExportPage {
  label: string;
  markdown: string;
}

export interface ExportOptions {
  title?: string;
}

const RULE = '\n\n---\n\n';

/** 多页用 `## label` 分段；单页直接给内容（避免给识别结果强加一级标题）。 */
export function toMarkdown(pages: ExportPage[], opts: ExportOptions = {}): string {
  if (pages.length === 0) return opts.title ? `# ${opts.title}\n` : '';
  if (pages.length === 1) return pages[0].markdown.replace(/\s+$/, '') + '\n';

  const parts = pages.map((p) => `## ${p.label}\n\n${p.markdown.replace(/\s+$/, '')}`);
  const body = parts.join(RULE);
  return opts.title ? `# ${opts.title}\n\n${body}\n` : `${body}\n`;
}

export function toHtmlDocument(pages: ExportPage[], opts: ExportOptions = {}): string {
  return toHtml(pages as HtmlPage[], { title: opts.title ?? 'moocr 识别结果', pageLabels: pages.length > 1 });
}

export async function toDocxBuffer(pages: ExportPage[], opts: ExportOptions = {}): Promise<Buffer> {
  return toDocx(pages, opts);
}

export { toHtml };

/**
 * 模型原始输出 → 干净的 Markdown。
 *
 * 实测（docs/CAPABILITY.md）：Xiaomi-OCR-0 的 document 任务输出通常已经是干净
 * markdown（无双引号包裹、无 "Here is" 前言），所以这里只做必要的规范化，
 * 不做激进改写 —— 任何"猜"都可能破坏原文。
 */
import { looksLikeOtsl, otslToHtml, type OtslToHtmlResult } from './otsl.ts';

export interface NormalizeOptions {
  /** 是否把内嵌的 OTSL 块转成 HTML 表格（默认 true） */
  convertOtsl?: boolean;
  /** 是否剥掉最外层 ``` 围栏（默认 true） */
  stripFences?: boolean;
  /** 是否压缩连续空行到最多一个空行（默认 true） */
  collapseBlankLines?: boolean;
}

export interface NormalizeResult {
  markdown: string;
  tables: OtslToHtmlResult[];
  warnings: string[];
}

const FENCE_RE = /^\s*```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)\n\s*```\s*$/;

export function stripCodeFence(text: string): string {
  const t = text.trim();
  const m = t.match(FENCE_RE);
  return m ? m[1] : t;
}

export function normalizeMarkdown(raw: string, opts: NormalizeOptions = {}): NormalizeResult {
  const { convertOtsl = true, stripFences = true, collapseBlankLines = true } = opts;
  const warnings: string[] = [];
  const tables: OtslToHtmlResult[] = [];

  let text = raw.replace(/\r\n?/g, '\n');
  if (stripFences) text = stripCodeFence(text);

  // 注意：`<nl>` 是 OTSL 的行分隔符，必须先交给 otslToHtml 处理，
  // 不能在分块前替换成换行 —— 否则整张表会被解析成单行。
  const blocks = text.split(/\n{2,}/);
  const outBlocks: string[] = [];

  for (const block of blocks) {
    let trimmed = block.trim();
    if (!trimmed) continue;

    if (convertOtsl && looksLikeOtsl(trimmed)) {
      // 模型偶尔用真换行代替 <nl>；只要每行都是单元格，就按行分隔处理
      if (!/<nl>/i.test(trimmed) && /\n/.test(trimmed)) {
        const lines = trimmed.split('\n').map((l) => l.trim()).filter(Boolean);
        if (lines.every((l) => /^<[felux]cel>/i.test(l))) {
          trimmed = lines.join('<nl>');
        }
      }
      const res = otslToHtml(trimmed);
      tables.push(res);
      warnings.push(...res.warnings);
      if (res.html) {
        outBlocks.push(res.html);
        if (res.table.trailing) outBlocks.push(res.table.trailing);
      } else {
        outBlocks.push(trimmed.replace(/<\/?nl>/gi, '\n'));
      }
      continue;
    }

    // 非表格段落里的 <nl> 只是残留标记，转成换行
    outBlocks.push(trimmed.replace(/<\/?nl>/gi, '\n'));
  }

  let markdown = outBlocks.join('\n\n');
  if (collapseBlankLines) markdown = markdown.replace(/\n{3,}/g, '\n\n');
  markdown = markdown.replace(/[ \t]+$/gm, '').trim();

  return { markdown, tables, warnings };
}

/** 简单统计，用于 CLI/UI 展示与回归对比 */
export function summarizeMarkdown(md: string) {
  const chars = [...md].length;
  const lines = md.split('\n');
  const nonEmpty = lines.filter((l) => l.trim()).length;
  const headings = lines.filter((l) => /^#{1,6}\s/.test(l)).length;
  const latexBlocks = (md.match(/\\\[[\s\S]*?\\\]/g) ?? []).length;
  const inlineLatex = (md.match(/\\\([\s\S]*?\\\)/g) ?? []).length;
  const tables = (md.match(/<table[\s>]/g) ?? []).length;
  return { chars, lines: lines.length, nonEmpty, headings, latexBlocks, inlineLatex, tables };
}

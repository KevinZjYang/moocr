/**
 * Markdown → HTML 字符串（供导出用；渲染进程另有 React 版本，两边形态不同）。
 *
 * 输入来自管线：模型输出的文本，其中 OTSL 表格已在 normalizeMarkdown 阶段
 * 转成 <table> 字符串。因此这里对「整块 <table>」必须原样保留，
 * 不能 escape —— 那些标签是我们自己生成的。
 */

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
};

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => HTML_ESCAPES[c] ?? c);
}

function inline(text: string): string {
  // 先把「不能被再次解析」的片段抽出来：行内代码、行内公式
  const slots: string[] = [];
  const keep = (html: string): string => {
    slots.push(html);
    return `\u0000${slots.length - 1}\u0000`;
  };

  let s = text.replace(/`([^`\n]+)`/g, (_m, code: string) => keep(`<code>${escapeHtml(code)}</code>`));
  s = s.replace(/\$([^$\n]+)\$/g, (_m, tex: string) => keep(`<span class="math-inline">${escapeHtml(tex)}</span>`));

  s = escapeHtml(s);
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');

  return s.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => slots[Number(i)] ?? '');
}

interface Block {
  kind: 'table' | 'math' | 'code' | 'heading' | 'ul' | 'ol' | 'p';
  level?: number;
  lines?: string[];
  html?: string;
  text?: string;
}

/** 导出给 docx 等其它格式复用，避免分块规则分叉。 */
export function splitBlocks(markdown: string): Block[] {
  const text = markdown.replace(/\r\n?/g, '\n');
  const blocks: Block[] = [];
  const lines = text.split('\n');

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      i++;
      continue;
    }

    // 整块 HTML 表格（我们自己生成的，逐字保留）
    if (/^\s*<table[\s>]/i.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && !/<\/table>\s*$/i.test(lines[i])) buf.push(lines[i++]);
      if (i < lines.length) buf.push(lines[i++]);
      blocks.push({ kind: 'table', html: buf.join('\n') });
      continue;
    }

    // 整块 LaTeX：\[ ... \] 或 $$ ... $$
    // 模型经常把整页公式压在一行里（`\[\begin{array}{l} A \\ B \end{array}\]`），
    // 所以必须先判断首行是否已闭合，否则会把后面的段落一起吞进来。
    const mathOpen = line.match(/^\s*(\\\[|\$\$)/);
    if (mathOpen) {
      const closer = mathOpen[1] === '\\[' ? '\\]' : '$$';
      const rest = line.replace(/^\s*(\\\[|\$\$)/, '');
      const at = rest.indexOf(closer);

      if (at >= 0) {
        blocks.push({ kind: 'math', text: rest.slice(0, at).trim() });
        const tail = rest.slice(at + closer.length).trim();
        i++;
        if (tail) blocks.push({ kind: 'p', lines: [tail] });
        continue;
      }

      const buf: string[] = [rest];
      i++;
      while (i < lines.length) {
        const cur = lines[i];
        const closeAt = cur.indexOf(closer);
        if (closeAt >= 0) {
          buf.push(cur.slice(0, closeAt));
          i++;
          break;
        }
        buf.push(cur);
        i++;
      }
      blocks.push({ kind: 'math', text: buf.join('\n').trim() });
      continue;
    }

    // ``` 围栏代码块
    const fence = line.match(/^\s*```([a-zA-Z0-9_-]*)\s*$/);
    if (fence) {
      const lang = fence[1] ?? '';
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) buf.push(lines[i++]);
      if (i < lines.length) i++;
      blocks.push({ kind: 'code', text: buf.join('\n'), html: lang });
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      blocks.push({ kind: 'heading', level: heading[1].length, text: heading[2] });
      i++;
      continue;
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*[-*+]\s+/, ''));
        i++;
      }
      blocks.push({ kind: 'ul', lines: buf });
      continue;
    }

    if (/^\s*\d+[.)]\s+/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*\d+[.)]\s+/, ''));
        i++;
      }
      blocks.push({ kind: 'ol', lines: buf });
      continue;
    }

    const buf: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^\s*<table[\s>]/i.test(lines[i]) &&
      !/^\s*(\\\[|\$\$|```)/.test(lines[i]) &&
      !/^(#{1,6})\s+/.test(lines[i]) &&
      !/^\s*[-*+]\s+/.test(lines[i]) &&
      !/^\s*\d+[.)]\s+/.test(lines[i])
    ) {
      buf.push(lines[i++]);
    }
    if (buf.length) blocks.push({ kind: 'p', lines: buf });
  }

  return blocks;
}

function renderBlocks(markdown: string): string {
  const out: string[] = [];
  // 有序列表常被空行拆成多块，跨块延续编号，否则会渲染成 1. 1. 1.
  let olNext = 1;
  for (const b of splitBlocks(markdown)) {
    if (b.kind === 'heading') olNext = 1;
    switch (b.kind) {
      case 'table':
        out.push(b.html ?? '');
        break;
      case 'math':
        out.push(`<div class="math-block">${escapeHtml(b.text ?? '')}</div>`);
        break;
      case 'code':
        out.push(`<pre class="code"><code>${escapeHtml(b.text ?? '')}</code></pre>`);
        break;
      case 'heading':
        out.push(`<h${b.level}>${inline(b.text ?? '')}</h${b.level}>`);
        break;
      case 'ul':
        out.push(`<ul>${(b.lines ?? []).map((l) => `<li>${inline(l)}</li>`).join('')}</ul>`);
        break;
      case 'ol': {
        const lines = b.lines ?? [];
        const start = olNext > 1 ? ` start="${olNext}"` : '';
        olNext += lines.length;
        out.push(`<ol${start}>${lines.map((l) => `<li>${inline(l)}</li>`).join('')}</ol>`);
        break;
      }
      case 'p':
        out.push(`<p>${(b.lines ?? []).map(inline).join('<br>')}</p>`);
        break;
    }
  }
  return out.join('\n');
}

export interface HtmlCell {
  text: string;
  colspan: number;
  rowspan: number;
  header: boolean;
}

export interface HtmlTable {
  rows: HtmlCell[][];
}

function attr(tag: string, name: string): number {
  const m = tag.match(new RegExp(`${name}\\s*=\\s*"?(\\d+)`, 'i'));
  const n = m ? Number(m[1]) : 1;
  return Number.isFinite(n) && n > 0 ? Math.min(n, 64) : 1;
}

function unescapeHtml(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

/** 解析我们自己的 otslToHtml 输出（不追求通用 HTML 解析器的完备性）。 */
export function parseTableHtml(html: string): HtmlTable {
  const rows: HtmlCell[][] = [];
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rm: RegExpExecArray | null;
  while ((rm = rowRe.exec(html))) {
    const cells: HtmlCell[] = [];
    const cellRe = /<(th|td)([^>]*)>([\s\S]*?)<\/\1>/gi;
    let cm: RegExpExecArray | null;
    while ((cm = cellRe.exec(rm[1]))) {
      const tag = `<${cm[1]}${cm[2]}>`;
      cells.push({
        text: unescapeHtml(cm[3]).trim(),
        colspan: attr(tag, 'colspan'),
        rowspan: attr(tag, 'rowspan'),
        header: cm[1].toLowerCase() === 'th',
      });
    }
    if (cells.length) rows.push(cells);
  }
  return { rows };
}

const DOC_CSS = `
:root { color-scheme: light dark; }
body { max-width: 860px; margin: 40px auto; padding: 0 20px;
  font-family: -apple-system, "Segoe UI", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif;
  line-height: 1.7; color: #1a1a1a; background: #fff; }
h1, h2, h3, h4 { line-height: 1.3; margin: 1.6em 0 .6em; }
h1 { font-size: 1.7em; } h2 { font-size: 1.4em; } h3 { font-size: 1.2em; }
table { border-collapse: collapse; margin: 1em 0; font-size: .95em; }
th, td { border: 1px solid #c8ccd2; padding: 6px 10px; text-align: left; vertical-align: top; }
th { background: #f2f4f7; font-weight: 600; }
code { font-family: ui-monospace, Consolas, "Cascadia Mono", monospace;
  background: #f1f3f5; padding: 1px 4px; border-radius: 3px; font-size: .92em; }
pre.code { background: #f6f8fa; padding: 12px 14px; border-radius: 6px; overflow-x: auto; }
pre.code code { background: none; padding: 0; }
.math-inline, .math-block { font-family: "Cambria Math", "Latin Modern Math", serif; }
.math-block { margin: 1em 0; padding: 10px 14px; background: #f8f9fb; border-left: 3px solid #d0d5dd;
  white-space: pre-wrap; overflow-x: auto; }
.page-sep { margin: 3em 0 1.5em; border: 0; border-top: 1px dashed #c8ccd2; }
.page-label { font-size: .8em; color: #8b939f; letter-spacing: .04em; text-transform: uppercase; }
@media (prefers-color-scheme: dark) {
  body { background: #16181c; color: #e6e8eb; }
  th, td { border-color: #3a4048; } th { background: #22262c; }
  code, pre.code { background: #22262c; }
  .math-block { background: #1d2126; border-left-color: #3a4048; }
  .page-sep { border-top-color: #3a4048; }
}
`;

export interface HtmlPage {
  label: string;
  markdown: string;
}

export interface HtmlOptions {
  title?: string;
  /** 多页时是否插入分页标签（默认 true） */
  pageLabels?: boolean;
}

/** 导出为独立可打开的 HTML 文件（无外链、无脚本）。 */
export function toHtml(pages: HtmlPage[], opts: HtmlOptions = {}): string {
  const { title = 'moocr 识别结果', pageLabels = true } = opts;
  const multi = pages.length > 1;
  const body = pages
    .map((p, idx) => {
      const inner = renderBlocks(p.markdown);
      if (!multi) return inner;
      const head = pageLabels ? `<div class="page-label">${escapeHtml(p.label)}</div>` : '';
      const sep = idx > 0 ? '<hr class="page-sep">' : '';
      return `${sep}${head}\n${inner}`;
    })
    .join('\n');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${DOC_CSS}</style>
</head>
<body>
${body}
</body>
</html>
`;
}

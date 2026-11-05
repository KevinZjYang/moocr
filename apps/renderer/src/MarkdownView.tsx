/**
 * 极简 Markdown 渲染器：只支持模型实际会输出的结构。
 *
 * 安全边界：全文走 React 元素，唯一用 innerHTML 的是表格，而且必须先过
 * sanitizeTableHtml —— 只允许 table/thead/tbody/tr/th/td + colspan/rowspan。
 * 模型输出是不可信数据，不做白名单就等于在 Electron 里执行任意 HTML。
 */
import React from 'react';

const CELL_TAGS = /^<(\/?)(table|thead|tbody|tr|th|td)((?:\s+(?:colspan|rowspan|class)="[^"]*")*)\s*(\/?)>$/;

export function sanitizeTableHtml(html: string): string | null {
  const cleaned = html.replace(/<!--[\s\S]*?-->/g, '');
  // 文本节点里不能出现裸 '<'
  if (cleaned.replace(/<[^>]*>/g, '').includes('<')) return null;

  let bad = false;
  const out = cleaned.replace(/<\/?[a-zA-Z][^>]*>/g, (tag) => {
    const m = tag.match(CELL_TAGS);
    if (!m) {
      bad = true;
      return '';
    }
    const attrs = (m[3] ?? '')
      .replace(/\s+class="[^"]*"/g, '')
      .replace(/(colspan|rowspan)="(\d{1,3})"/g, (_, k: string, v: string) => ` ${k}="${Math.min(64, Number(v))}"`);
    return `<${m[1]}${m[2]}${attrs}>`;
  });
  return bad ? null : out;
}

/** 行内：`code`、**粗体**、*斜体*、$公式$ */
function inline(text: string, keyBase: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const re = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(\$[^$\n]+\$)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    const tok = m[0];
    const k = `${keyBase}-${i++}`;
    if (m[1]) nodes.push(<code key={k}>{tok.slice(1, -1)}</code>);
    else if (m[2]) nodes.push(<strong key={k}>{tok.slice(2, -2)}</strong>);
    else if (m[3]) nodes.push(<em key={k}>{tok.slice(1, -1)}</em>);
    else nodes.push(<span key={k} className="math-inline">{tok}</span>);
    last = m.index + tok.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

function renderBlock(block: string, idx: number, olStart = 1): React.ReactNode {
  const key = `b${idx}`;

  if (block.startsWith('<table')) {
    const safe = sanitizeTableHtml(block);
    if (safe) {
      return <div key={key} className="table-wrap" dangerouslySetInnerHTML={{ __html: safe }} />;
    }
    return (
      <pre key={key} className="raw-block" title="表格 HTML 未通过白名单校验，按原文显示">
        {block}
      </pre>
    );
  }

  const heading = block.match(/^(#{1,6})\s+(.*)$/);
  if (heading) {
    const level = heading[1].length;
    const Tag = `h${level}` as 'h1';
    return React.createElement(Tag, { key }, inline(heading[2], key));
  }

  // 整块 LaTeX：\[ ... \]
  if (/^\\\[[\s\S]*\\\]$/.test(block.trim()) || /^\$\$[\s\S]*\$\$$/.test(block.trim())) {
    return (
      <pre key={key} className="math-block">
        {block.trim()}
      </pre>
    );
  }

  const lines = block.split('\n');
  if (lines.every((l) => /^\s*([-*]|\d+\.)\s+/.test(l))) {
    const ordered = /^\s*\d+\./.test(lines[0]);
    const items = lines.map((l, j) => (
      <li key={`${key}-${j}`}>{inline(l.replace(/^\s*([-*]|\d+\.)\s+/, ''), `${key}-${j}`)}</li>
    ));
    return ordered ? (
      <ol key={key} start={olStart}>
        {items}
      </ol>
    ) : (
      <ul key={key}>{items}</ul>
    );
  }

  return <p key={key}>{inline(block, key)}</p>;
}

export function MarkdownView({ markdown }: { markdown: string }): React.ReactElement {
  const blocks = markdown.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);

  // 模型输出的有序列表常被空行拆成多块（`1. 引言` / 空行 / 正文 / `2. 方法`），
  // 每块单独从 1 开始会显示成「1. 1. 1.」。跨块延续编号，遇到标题才归零。
  let olNext = 1;

  return (
    <div className="markdown">
      {blocks.map((b, i) => {
        if (b.startsWith('#')) olNext = 1;
        const ordered = b.split('\n').every((l) => /^\s*\d+\.\s+/.test(l));
        let start = 1;
        if (ordered) {
          start = olNext;
          olNext += b.split('\n').length;
        }
        return renderBlock(b, i, start);
      })}
    </div>
  );
}

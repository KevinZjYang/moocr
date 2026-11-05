/**
 * OTSL (Open Table Structure Language) → HTML 表格。
 *
 * OTSL 单元格标记：
 *   <fcel>  有内容单元格
 *   <ecel>  空单元格
 *   <lcel>  与左侧单元格横向合并（左格 colspan+1）
 *   <ucel>  与上方单元格纵向合并（上格 rowspan+1）
 *   <xcel>  已被合并覆盖（不产生新格）
 *   <nl>    行结束
 *
 * 实测依据（docs/CAPABILITY.md §3.1）：Xiaomi-OCR-0 在合并单元格表格上能正确
 * 产出 <lcel>/<ucel>，但偶发把有值格误标为 <ucel>。因此本模块必须：
 *   1) 严格按 OTSL 语义推导 colspan/rowspan；
 *   2) 对无法归属的 lcel/ucel 降级为空格并给出 warning，而不是抛出。
 */

export type OtslCellKind = 'fcel' | 'ecel' | 'lcel' | 'ucel' | 'xcel';

export interface OtslCell {
  kind: OtslCellKind;
  text: string;
  row: number;
  col: number;
  colspan: number;
  rowspan: number;
}

export interface OtslTable {
  /** 行 × 列 的纯文本网格（合并格重复填充其文本，便于做覆盖率/对齐分析） */
  grid: string[][];
  cells: OtslCell[];
  rows: number;
  cols: number;
  /** 表格之后模型可能续写的说明文字 */
  trailing: string;
  warnings: string[];
}

export interface OtslToHtmlResult {
  html: string;
  table: OtslTable;
  warnings: string[];
}

const TAG_RE = /<(fcel|ecel|lcel|ucel|xcel|nl)\s*>/gi;

interface RawRow {
  kind: OtslCellKind;
  text: string;
}[]

/** 把 OTSL 文本切成行 × 原始单元格 */
export function parseOtsl(input: string): { rows: RawRow[]; trailing: string } {
  const text = input.replace(/\r\n?/g, '\n');
  const rows: RawRow[] = [];
  let current: RawRow = [];
  let sawAnyTag = false;
  let stopped = false;
  let stopIndex = text.length;

  TAG_RE.lastIndex = 0;
  let lastEnd = 0;
  let m: RegExpExecArray | null;

  const flushRow = () => {
    if (current.length > 0) rows.push(current);
    current = [];
  };

  while ((m = TAG_RE.exec(text)) !== null) {
    const between = text.slice(lastEnd, m.index);
    lastEnd = TAG_RE.lastIndex;
    const tag = m[1].toLowerCase();

    if (stopped) continue;

    if (between.trim().length > 0) {
      // 标签前的散文本：在没有当前格时视为表格前的杂讯；有当前格时并入该格
      if (current.length > 0) {
        current[current.length - 1].text += between;
      } else if (sawAnyTag) {
        // 行已结束又出现自由文本 → 表格在此结束
        stopped = true;
        stopIndex = m.index - between.length;
      }
    }

    if (tag === 'nl') {
      flushRow();
      continue;
    }

    sawAnyTag = true;
    // 单元格标记之后、下一个标记之前的内容属于该格
    current.push({ kind: tag as OtslCellKind, text: '' });
  }

  if (!stopped && lastEnd < text.length) {
    const rest = text.slice(lastEnd);
    if (current.length > 0) current[current.length - 1].text += rest;
    else if (rest.trim()) {
      stopped = true;
      stopIndex = lastEnd;
    }
  }
  flushRow();

  const trailing = stopped ? text.slice(stopIndex).trim() : '';
  if (trailing && rows.length > 0) {
    // 去掉 trailing 里可能残留的标签尾巴
    rows[rows.length - 1] = rows[rows.length - 1].map((c) => ({ ...c, text: c.text.trim() }));
  }

  for (const row of rows) for (const c of row) c.text = cleanCellText(c.text);
  return { rows, trailing };
}

function cleanCellText(s: string): string {
  return s
    .replace(/^[\s\u00a0]+|[\s\u00a0]+$/g, '')
    .replace(/\s*\n\s*/g, ' ')
    .replace(/[ \t]{2,}/g, ' ');
}

/** 解析并推导合并结构 */
export function buildOtslTable(input: string): OtslTable {
  const { rows: raw, trailing } = parseOtsl(input);
  const warnings: string[] = [];
  const rowsCount = raw.length;
  const cols = raw.reduce((mx, r) => Math.max(mx, r.length), 0);

  const owner: (OtslCell | null)[][] = Array.from({ length: rowsCount }, () =>
    Array.from({ length: cols }, () => null)
  );
  const cells: OtslCell[] = [];

  for (let r = 0; r < rowsCount; r++) {
    const row = raw[r];
    for (let c = 0; c < row.length; c++) {
      const { kind, text } = row[c];
      if (owner[r][c]) continue; // 已由上方 rowspan 覆盖

      if (kind === 'lcel') {
        const left = c > 0 ? owner[r][c - 1] : null;
        if (left && left.row === r) {
          left.colspan += 1;
          owner[r][c] = left;
        } else {
          warnings.push(`row ${r} col ${c}: <lcel> 找不到左邻格，降级为空格`);
          const cell: OtslCell = { kind: 'ecel', text: '', row: r, col: c, colspan: 1, rowspan: 1 };
          cells.push(cell);
          owner[r][c] = cell;
        }
        continue;
      }

      if (kind === 'ucel') {
        const up = r > 0 ? owner[r - 1][c] : null;
        if (up) {
          up.rowspan += 1;
          owner[r][c] = up;
        } else {
          warnings.push(`row ${r} col ${c}: <ucel> 找不到上邻格，降级为空格`);
          const cell: OtslCell = { kind: 'ecel', text: '', row: r, col: c, colspan: 1, rowspan: 1 };
          cells.push(cell);
          owner[r][c] = cell;
        }
        continue;
      }

      if (kind === 'xcel') {
        warnings.push(`row ${r} col ${c}: 孤立的 <xcel>`);
        continue;
      }

      const cell: OtslCell = { kind, text, row: r, col: c, colspan: 1, rowspan: 1 };
      cells.push(cell);
      owner[r][c] = cell;
    }
  }

  // 纯文本网格（合并格重复填充）
  const grid: string[][] = Array.from({ length: rowsCount }, () => Array.from({ length: cols }, () => ''));
  for (let r = 0; r < rowsCount; r++) {
    for (let c = 0; c < cols; c++) {
      const o = owner[r][c];
      grid[r][c] = o ? o.text : '';
    }
  }

  return { grid, cells, rows: rowsCount, cols, trailing, warnings };
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** 判断一个字符串里是否含 OTSL 标记（用于决定是否走表格转换） */
export function looksLikeOtsl(s: string): boolean {
  return /<(fcel|ecel|lcel|ucel|xcel)>/i.test(s);
}

export interface ToHtmlOptions {
  /** 是否把首行放进 <thead>（默认 false，忠实呈现，不猜表头） */
  firstRowAsHeader?: boolean;
  /** <table> 上的 class，方便前端样式 */
  className?: string;
}

export function otslToHtml(input: string, opts: ToHtmlOptions = {}): OtslToHtmlResult {
  const table = buildOtslTable(input);
  const { cells, rows, cols } = table;

  if (rows === 0 || cols === 0) {
    return { html: '', table, warnings: [...table.warnings, '空表格'] };
  }

  const byRow = new Map<number, OtslCell[]>();
  for (const c of cells) {
    if (!byRow.has(c.row)) byRow.set(c.row, []);
    byRow.get(c.row)!.push(c);
  }

  const renderRow = (r: number) => {
    const list = (byRow.get(r) ?? []).sort((a, b) => a.col - b.col);
    const tds = list.map((c) => {
      const attrs: string[] = [];
      if (c.colspan > 1) attrs.push(` colspan="${c.colspan}"`);
      if (c.rowspan > 1) attrs.push(` rowspan="${c.rowspan}"`);
      const body = escapeHtml(c.text);
      return `<td${attrs.join('')}>${body}</td>`;
    });
    return `<tr>${tds.join('')}</tr>`;
  };

  let html: string;
  const cls = opts.className ?? 'otsl-table';
  if (opts.firstRowAsHeader) {
    const rest = Array.from({ length: rows - 1 }, (_, i) => renderRow(i + 1));
    html = `<table class="${cls}">\n<thead>${renderRow(0)}</thead>\n<tbody>\n${rest.join('\n')}\n</tbody>\n</table>`;
  } else {
    const body = Array.from({ length: rows }, (_, i) => renderRow(i));
    html = `<table class="${cls}">\n<tbody>\n${body.join('\n')}\n</tbody>\n</table>`;
  }

  return { html, table, warnings: table.warnings };
}

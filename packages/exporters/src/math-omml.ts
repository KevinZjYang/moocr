/**
 * LaTeX → OMML（Word 原生公式）。
 *
 * 路线：temml 把 TeX 编成 MathML，mathml2omml 再用 Office 的 MML2OMML XSLT 转成 OMML。
 * 两步都是纯 JS，不依赖 Word/LibreOffice；失败一律返回 null，调用方回退到纯文本，
 * 不能因为一条公式写不出来就让整份文档导出失败。
 */

type TemmlApi = { renderToString: (tex: string, opts?: Record<string, unknown>) => string };

let temmlPromise: Promise<TemmlApi> | null = null;
let mml2ommlPromise: Promise<(mathml: string) => string> | null = null;

async function loadTemml(): Promise<TemmlApi> {
  if (!temmlPromise) {
    temmlPromise = import('temml').then((mod) => {
      // temml 的 ESM 出口把整个 API 挂在 default 上
      const api = ((mod as unknown as { default?: TemmlApi }).default ?? mod) as TemmlApi;
      if (typeof api?.renderToString !== 'function') throw new Error('temml 接口不符');
      return api;
    });
  }
  return temmlPromise;
}

async function loadMml2Omml(): Promise<(mathml: string) => string> {
  if (!mml2ommlPromise) {
    mml2ommlPromise = import('mathml2omml').then((mod) => {
      const fn = (mod as unknown as { mml2omml?: unknown }).mml2omml;
      if (typeof fn !== 'function') throw new Error('mathml2omml 接口不符');
      return fn as (mathml: string) => string;
    });
  }
  return mml2ommlPromise;
}

/** 把模型给的 LaTeX 稍微规整一下再喂给 temml */
function tidy(tex: string): string {
  return tex
    .replace(/\r\n?/g, '\n')
    // 收尾多余的 \\ 会让 array 多出一个空行
    .replace(/\\\\\s*$/, '')
    .trim();
}

/**
 * @param tex LaTeX 源（不含 $ / \[ \] 分隔符）
 * @param display 是否独立成行公式
 * @returns OMML 片段；失败返回 null
 */
export async function latexToOmml(tex: string, display: boolean): Promise<string | null> {
  const src = tidy(tex);
  if (!src) return null;
  try {
    const temml = await loadTemml();
    const mathml = temml.renderToString(src, { displayMode: display, throwOnError: true, annotate: false });
    if (!mathml || !mathml.includes('<math')) return null;

    const toOmml = await loadMml2Omml();
    const omml = toOmml(mathml);
    if (!omml || !String(omml).includes('<m:oMath')) return null;
    return String(omml).trim();
  } catch {
    return null;
  }
}

/**
 * 给 OMML 补上命名空间声明。
 *
 * docx 生成的 document.xml 根节点没有声明 m:，直接塞 <m:oMath> 会被 Word 判为损坏。
 * 在元素自身上声明一次即可（XML 允许局部声明）。
 */
export function withMathNs(omml: string): string {
  if (/\sxmlns:m=/.test(omml)) return omml;
  return omml.replace(/^(\s*<m:oMath)/, `$1 xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"`);
}

/** 行内数学：$...$ 或 \( ... \) */
export function splitInlineMath(text: string): { text: string; math: boolean }[] {
  const out: { text: string; math: boolean }[] = [];
  const re = /\$([^$\n]+)\$|\\\((.+?)\\\)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push({ text: text.slice(last, m.index), math: false });
    out.push({ text: (m[1] ?? m[2] ?? '').trim(), math: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), math: false });
  return out.length > 0 ? out : [{ text, math: false }];
}

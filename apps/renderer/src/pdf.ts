/**
 * PDF 逐页转位图。
 *
 * 为什么在渲染进程做：pdfjs 需要 canvas，主进程没有 DOM。
 * 代价是每页的 PNG/JPEG 要经 IPC 传给主进程识别（走 dataURL）。
 *
 * 尺寸策略来自 M0 实测（docs/CAPABILITY.md）：印刷文档在低 token 预算下
 * 准确率反而更高（630 tok 得 97%），所以长边压到 1600 足够；
 * 更大的位图只会让 prefill 超线性变慢。
 */
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export interface PdfPageImage {
  pageNo: number;
  dataUrl: string;
  width: number;
  height: number;
}

export interface RenderPdfOptions {
  /** 长边像素上限，默认 1600 */
  maxEdge?: number;
  /** 质量，默认 0.9（JPEG） */
  quality?: number;
  /** 逐页回调，便于 UI 显示进度 */
  onPage?: (pageNo: number, total: number) => void;
  /** 最多渲染多少页（防御超大文档），默认 200 */
  maxPages?: number;
}

export async function renderPdf(data: Uint8Array, opts: RenderPdfOptions = {}): Promise<PdfPageImage[]> {
  const { maxEdge = 1600, quality = 0.9, onPage, maxPages = 200 } = opts;

  // isEvalSupported:false —— 渲染进程 CSP 禁止 eval，pdfjs 会退回解释器
  const doc = await pdfjs.getDocument({ data, isEvalSupported: false, useSystemFonts: true }).promise;
  const total = Math.min(doc.numPages, maxPages);
  const out: PdfPageImage[] = [];

  for (let n = 1; n <= total; n++) {
    onPage?.(n, total);
    const page = await doc.getPage(n);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(3, maxEdge / Math.max(base.width, base.height));
    const viewport = page.getViewport({ scale });

    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('无法创建 canvas 上下文');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    await page.render({ canvasContext: ctx, viewport }).promise;
    out.push({
      pageNo: n,
      dataUrl: canvas.toDataURL('image/jpeg', quality),
      width: canvas.width,
      height: canvas.height,
    });
    page.cleanup();
  }

  await doc.destroy();
  return out;
}

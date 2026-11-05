/**
 * 截图覆盖层：拖动选区 → 松手提交；Esc 取消；未拖动就松手视为取消。
 * 画面是主进程截好的静态缩略图，本页只负责画框。
 */
interface OverlayApi {
  config(): Promise<{ imageDataUrl: string; width: number; height: number; displayId: number } | null>;
  finish(rect: { x: number; y: number; width: number; height: number }): void;
  cancel(): void;
}

declare global {
  interface Window {
    overlay: OverlayApi;
  }
}

const shot = document.getElementById('shot') as HTMLImageElement;
const box = document.getElementById('box') as HTMLDivElement;
const sizeEl = document.getElementById('size') as HTMLDivElement;
const shade = document.getElementById('shade') as HTMLDivElement;
const hint = document.getElementById('hint') as HTMLDivElement;

const dpr = window.devicePixelRatio || 1;

let dragging = false;
let sx = 0;
let sy = 0;
let rect = { x: 0, y: 0, width: 0, height: 0 };

function paint(): void {
  if (rect.width < 1 || rect.height < 1) {
    box.style.display = 'none';
    return;
  }
  box.style.display = 'block';
  box.style.left = `${rect.x}px`;
  box.style.top = `${rect.y}px`;
  box.style.width = `${rect.width}px`;
  box.style.height = `${rect.height}px`;
  const pw = Math.round(rect.width * dpr);
  const ph = Math.round(rect.height * dpr);
  sizeEl.textContent = `${pw} × ${ph}`;
  // 选在屏幕顶部时标签会跑出窗口，翻到框内
  sizeEl.style.top = rect.y < 30 ? '4px' : '-26px';
  hint.style.opacity = '0';
}

function begin(x: number, y: number): void {
  dragging = true;
  sx = x;
  sy = y;
  rect = { x, y, width: 0, height: 0 };
  shade.style.display = 'none';
  paint();
}

function move(x: number, y: number): void {
  if (!dragging) return;
  const left = Math.min(sx, x);
  const top = Math.min(sy, y);
  rect = { x: left, y: top, width: Math.abs(x - sx), height: Math.abs(y - sy) };
  paint();
}

function end(): void {
  if (!dragging) return;
  dragging = false;
  if (rect.width < 4 || rect.height < 4) {
    window.overlay.cancel();
    return;
  }
  window.overlay.finish(rect);
}

window.addEventListener('mousedown', (e) => {
  if (e.button !== 0) {
    window.overlay.cancel();
    return;
  }
  begin(e.clientX, e.clientY);
});

window.addEventListener('mousemove', (e) => move(e.clientX, e.clientY));
window.addEventListener('mouseup', () => end());

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.overlay.cancel();
});

// 覆盖层抢不到焦点时 keydown 收不到，这层兜底
window.addEventListener('blur', () => {
  if (!dragging) window.overlay.cancel();
});

void window.overlay.config().then((cfg) => {
  if (!cfg) {
    window.overlay.cancel();
    return;
  }
  shot.src = cfg.imageDataUrl;
});

/**
 * 区域截图：全屏冻结 → 每屏一个覆盖层拖框 → 裁剪出选区。
 *
 * 坐标有两套，别混：
 *   - CSS/DIP 像素：窗口 bounds、鼠标 event.offsetX 用这套
 *   - 物理像素：desktopCapturer 的 thumbnail 用这套（= DIP × scaleFactor）
 * 裁剪时用 image.getSize() / bounds 求比例换算，而不是直接用 scaleFactor ——
 * 缩略图会被截断到 thumbnailSize，实际尺寸未必等于 DIP × scaleFactor。
 */
import { BrowserWindow, desktopCapturer, screen, type NativeImage } from 'electron';
import path from 'node:path';

export interface CaptureResult {
  png: Buffer;
  /** 选区在物理像素下的尺寸 */
  pixelWidth: number;
  pixelHeight: number;
}

interface Shot {
  image: NativeImage;
  bounds: { x: number; y: number; width: number; height: number };
}

interface Session {
  windows: BrowserWindow[];
  shots: Map<number, Shot>;
  timer: NodeJS.Timeout | null;
  settle: (r: CaptureResult | null) => void;
}

let session: Session | null = null;

/** 每个覆盖层窗口对应的显示器 id */
const displayOf = new WeakMap<BrowserWindow, number>();

function overlayPage(): { url?: string; file?: string } {
  if (process.env.MOOCR_DEV === '1') return { url: 'http://127.0.0.1:5183/overlay.html' };
  return { file: path.join(__dirname, '../../../dist/renderer/overlay.html') };
}

function closeSession(): void {
  if (!session) return;
  const s = session;
  session = null;
  if (s.timer) clearTimeout(s.timer);
  for (const w of s.windows) {
    if (!w.isDestroyed()) w.destroy();
  }
}

/** 取消截图（Esc、超时、主窗关闭）。 */
export function cancelCapture(): void {
  const s = session;
  closeSession();
  s?.settle(null);
}

export function isCapturing(): boolean {
  return session !== null;
}

/**
 * 冻结屏幕并进入选区模式。返回 null 表示用户取消。
 * timeoutMs 防止覆盖层因为某些原因没收到事件而永久挂在最上层。
 */
export async function captureRegion(timeoutMs = 60_000): Promise<CaptureResult | null> {
  if (session) return null;

  const displays = screen.getAllDisplays();
  const maxW = Math.max(...displays.map((d) => Math.round(d.bounds.width * d.scaleFactor)));
  const maxH = Math.max(...displays.map((d) => Math.round(d.bounds.height * d.scaleFactor)));

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: maxW, height: maxH },
    fetchWindowIcons: false,
  });
  if (sources.length === 0) return null;

  const shots = new Map<number, Shot>();
  for (const d of displays) {
    const hit = sources.find((s) => s.display_id === String(d.id)) ?? sources[0];
    if (!hit || hit.thumbnail.isEmpty()) continue;
    shots.set(d.id, { image: hit.thumbnail, bounds: d.bounds });
  }
  if (shots.size === 0) return null;

  const page = overlayPage();
  const windows: BrowserWindow[] = [];

  const done = new Promise<CaptureResult | null>((resolve) => {
    session = { windows, shots, timer: null, settle: resolve };
    session.timer = setTimeout(() => cancelCapture(), timeoutMs);
  });

  for (const [displayId, shot] of shots) {
    const d = displays.find((x) => x.id === displayId)!;
    const w = new BrowserWindow({
      x: d.bounds.x,
      y: d.bounds.y,
      width: d.bounds.width,
      height: d.bounds.height,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, 'overlay-preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        // 覆盖层只是画框，关掉后台节流让它始终响应
        backgroundThrottling: false,
      },
    });
    displayOf.set(w, displayId);
    windows.push(w);
    w.setAlwaysOnTop(true, 'screen-saver');
    w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    if (page.url) void w.loadURL(page.url);
    else void w.loadFile(page.file!);
    w.once('ready-to-show', () => w.showInactive());
    w.on('closed', () => {
      // 用户用系统方式关掉（不该发生）时按取消处理
      if (session && session.windows.every((x) => x.isDestroyed())) cancelCapture();
    });
  }

  return done;
}

/** overlay 页面来取自己的背景与尺寸。 */
export function overlayConfig(w: BrowserWindow): {
  imageDataUrl: string;
  width: number;
  height: number;
  displayId: number;
} | null {
  const id = displayOf.get(w);
  if (id === undefined || !session) return null;
  const shot = session.shots.get(id);
  if (!shot) return null;
  return {
    imageDataUrl: shot.image.toDataURL(),
    width: shot.bounds.width,
    height: shot.bounds.height,
    displayId: id,
  };
}

/** overlay 提交选区（局部 DIP 坐标）。 */
export function overlayFinish(
  w: BrowserWindow,
  rect: { x: number; y: number; width: number; height: number },
): boolean {
  const id = displayOf.get(w);
  if (id === undefined || !session) return false;
  const shot = session.shots.get(id);
  if (!shot) return false;

  const s = session;
  const bw = shot.bounds.width;
  const bh = shot.bounds.height;
  const size = shot.image.getSize();
  const kx = size.width / bw;
  const ky = size.height / bh;

  // 夹到屏幕内，crop 越界在 Windows 上会返回黑边
  const x = Math.max(0, Math.min(rect.x, bw));
  const y = Math.max(0, Math.min(rect.y, bh));
  const width = Math.max(1, Math.min(rect.width, bw - x));
  const height = Math.max(1, Math.min(rect.height, bh - y));

  const px = {
    x: Math.max(0, Math.min(Math.round(x * kx), size.width - 1)),
    y: Math.max(0, Math.min(Math.round(y * ky), size.height - 1)),
    width: 0,
    height: 0,
  };
  px.width = Math.max(1, Math.min(Math.round(width * kx), size.width - px.x));
  px.height = Math.max(1, Math.min(Math.round(height * ky), size.height - px.y));

  if (px.width < 4 || px.height < 4) {
    closeSession();
    s.settle(null);
    return false;
  }

  const cropped = shot.image.crop(px);
  const png = cropped.toPNG();
  closeSession();
  s.settle({ png, pixelWidth: px.width, pixelHeight: px.height });
  return true;
}

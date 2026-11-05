import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, nativeTheme, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { runBatch, runPage, type PageRequest, type PageResult, type TaskKind } from '../../../packages/core/src/pipeline.ts';
import { KIE_SCHEMA } from '../../../packages/core/src/prompts.ts';
import { captureRegion, cancelCapture, isCapturing, overlayConfig, overlayFinish } from './capture.ts';
import { ResultCache } from './result-cache.ts';
import {
  startServer,
  stopServer,
  reclaimStaleSidecar,
  imageDataUri,
  type RunningServer,
} from '../../../packages/inference/src/server.ts';
import { toMarkdown, toHtmlDocument, toDocxBuffer } from '../../../packages/exporters/src/index.ts';

const PRESETS: Record<string, number> = {
  fast: 1024,
  standard: 2560,
  accurate: 6144,
  extreme: 12288,
};

const TASKS: TaskKind[] = ['document', 'text', 'table', 'formula', 'kie'];
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tif', '.tiff']);
const MAX_PDF_BYTES = 200 * 1024 * 1024;
const PORT = 8090;

/**
 * 找到「含 resources/models 的根目录」。
 *
 * 打包后资源在 process.resourcesPath（extraResources 落点），
 * 开发时从本文件位置向上找。两条路径都试，避免两套代码。
 */
function findRoot(start: string): string {
  const packaged = process.resourcesPath;
  if (packaged && fs.existsSync(path.join(packaged, 'resources', 'models'))) return packaged;

  let dir = start;
  for (;;) {
    if (fs.existsSync(path.join(dir, 'resources', 'models'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('找不到项目根（缺少 resources/models）');
    dir = parent;
  }
}

// dev 运行时 Electron 默认把 userData 放在 .../Electron 下，和装机版分开；
// 统一成 moocr，缓存与 pid 记录才不会因启动方式不同而各自为政。
app.setName('moocr');

let win: BrowserWindow | null = null;
let server: RunningServer | null = null;
let activePreset: string | null = null;
let activeParallel = 0;
/** 命令行带来的文件，等渲染进程挂载完主动来取（早发会丢） */
let pendingArgv: string[] = [];
let capturing = false;
let cache: ResultCache | null = null;
function resultCache(): ResultCache {
  if (!cache) {
    const root = findRoot(__dirname);
    cache = new ResultCache(
      path.join(app.getPath('userData'), 'result-cache'),
      path.join(root, 'resources', 'models', 'Xiaomi-OCR-0.Q4_K_M.gguf')
    );
  }
  return cache;
}

/** sidecar 被 OOM/驱动重置干掉时，HTTP 层表现为这些错误 */
function isConnectionLoss(msg: string): boolean {
  return /ECONNREFUSED|ECONNRESET|EPIPE|socket hang up|fetch failed|other side closed/i.test(msg);
}

/**
 * 单页识别 + 崩溃自愈：sidecar 挂了就拉起来重跑这一页（只重试一次）。
 * 端口固定，所以 baseUrl 不用改。
 */
async function runPageResilient(req: PageRequest): Promise<PageResult> {
  try {
    return await runPage(req);
  } catch (e) {
    const msg = (e as Error).message ?? '';
    if (!isConnectionLoss(msg)) throw e;
    const preset = activePreset ?? 'standard';
    const par = Math.max(1, activeParallel);
    send('server-state', { state: 'restarting', preset });
    if (server) {
      await stopServer(server).catch(() => {});
      server = null;
      activeParallel = 0;
    }
    await ensureServer(preset, par);
    send('notice', { kind: 'warn', text: '推理服务中断，已重启并重试该页' });
    return await runPage(req);
  }
}

const CAPTURE_HOTKEY = 'CommandOrControl+Shift+O';

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * 走一遍区域截图并把结果落盘。
 *
 * 先把主窗藏起来再截，否则自己会被截进去；隐藏到真正从合成器消失有几十毫秒延迟，
 * 160ms 是这个窗口下的实测安全值（再短会偶尔截到残留的窗口阴影）。
 */
async function runCapture(): Promise<{ ok: boolean; path?: string; error?: string }> {
  if (capturing || isCapturing()) return { ok: false, error: '正在截图中' };
  capturing = true;

  const restore = win && !win.isDestroyed() && win.isVisible();
  try {
    if (restore && win) win.hide();
    await delay(160);

    const shot = await captureRegion();
    if (!shot) return { ok: false, error: '已取消' };

    const dir = path.join(app.getPath('userData'), 'captures');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `cap-${Date.now()}.png`);
    fs.writeFileSync(file, shot.png);

    send('capture-done', { path: file, width: shot.pixelWidth, height: shot.pixelHeight });
    return { ok: true, path: file };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  } finally {
    capturing = false;
    if (restore && win && !win.isDestroyed()) {
      win.show();
      win.focus();
    }
  }
}

function send(channel: string, payload: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

/** sidecar pid 记录的落点：装机后安装目录只读，统一放用户数据目录 */
function stateDirFor(): string {
  const dir = path.join(app.getPath('userData'), 'state');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function ctxFor(preset: string): { imageMaxTokens: number; ctxPerSlot: number } {
  const imageMaxTokens = PRESETS[preset] ?? PRESETS.standard;
  // 单页最坏实测 10745 token，12288 是硬下限（docs/M1.md §3）
  return { imageMaxTokens, ctxPerSlot: Math.max(12288, imageMaxTokens + 4096 + 512) };
}

async function ensureServer(preset: string, parallel = 1): Promise<RunningServer> {
  if (server && activePreset === preset && activeParallel === parallel) return server;

  if (server) {
    send('server-state', { state: 'restarting', preset });
    await stopServer(server);
    server = null;
    activePreset = null;
    activeParallel = 0;
  }

  const root = findRoot(__dirname);
  // 上次被强杀会留下 sidecar 与 pid 记录：属于我们的就清掉重来，
  // 不是我们的（无记录/pid 不符）就报错，绝不静默复用错配置
  const stateDir = stateDirFor();
  const reclaim = await reclaimStaleSidecar(root, PORT, stateDir);
  if (reclaim === 'foreign') {
    throw new Error(`端口 ${PORT} 上有别的服务在监听且不归 moocr 管理。请先关掉它。`);
  }

  const { imageMaxTokens, ctxPerSlot } = ctxFor(preset);
  send('server-state', { state: 'starting', preset, imageMaxTokens });

  server = await startServer(root, {
    port: PORT,
    imageMaxTokens,
    ctxPerSlot,
    parallel,
    stateDir,
    onLog: (m) => send('server-state', { state: 'starting', preset, message: m }),
  });
  activePreset = preset;
  activeParallel = parallel;
  send('server-state', { state: 'ready', preset, imageMaxTokens });
  return server;
}

/** 命令行传入的图片（支持「用 moocr 打开」或 dev 快捷验证） */
function argvFiles(): string[] {
  const out: string[] = [];
  for (const a of process.argv.slice(1)) {
    if (!path.isAbsolute(a)) continue;
    const ext = path.extname(a).toLowerCase();
    if (!IMAGE_EXT.has(ext) && ext !== '.pdf') continue;
    try {
      if (fs.statSync(a).isFile()) out.push(a);
    } catch {
      /* 忽略不存在的参数 */
    }
  }
  return out;
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1080,
    minHeight: 720,
    // 首帧之前窗口就是底色，按系统深浅色给，避免闪一下反色
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0f1115' : '#ffffff',
    title: '墨客 moocr',
    // 菜单与标题栏合并成页面顶部的自绘一行，系统标题栏只保留右上角窗口按钮
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0f1115', symbolColor: '#c9d1d9', height: 40 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  // 原生菜单已移除，加速键改由这里接管。放在 before-input-event 里，
  // 好处是输入框聚焦时也能用，且不会被页面自己的 keydown 抢掉。
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || !win) return;
    const mod = input.control || input.meta;
    const key = input.key.toLowerCase();
    const act = (fn: () => void) => {
      event.preventDefault();
      fn();
    };

    if (mod && !input.shift && !input.alt && key === 'o') return act(() => win!.webContents.send('menu-open'));
    if (mod && key === 'r') return act(() => win!.webContents.reload());
    if (mod && input.shift && key === 'i') return act(() => win!.webContents.toggleDevTools());
    if (!mod && key === 'f12') return act(() => win!.webContents.toggleDevTools());
    if (!mod && key === 'f11') return act(() => win!.setFullScreen(!win!.isFullScreen()));
    if (mod && (key === '=' || key === '+')) return act(() => win!.webContents.setZoomLevel(Math.min(win!.webContents.getZoomLevel() + 0.5, 5)));
    if (mod && key === '-') return act(() => win!.webContents.setZoomLevel(Math.max(win!.webContents.getZoomLevel() - 0.5, -3)));
    if (mod && key === '0') return act(() => win!.webContents.setZoomLevel(0));
  });

  // 命令行带来的文件先存着，等渲染进程挂载后自己来取（详见 claim-argv）
  const pending = argvFiles();
  if (pending.length > 0) pendingArgv = pending;

  if (process.env.MOOCR_DEV === '1') {
    void win.loadURL('http://127.0.0.1:5183/');
  } else {
    void win.loadFile(path.join(__dirname, '../../../dist/renderer/index.html'));
  }

  win.on('closed', () => {
    win = null;
  });
}

function buildMenu(): Electron.Menu {
  const template: Electron.MenuItemConstructorOptions[] = [
    { role: 'appMenu' },
    { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: '视图', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { role: 'togglefullscreen' }] },
  ];
  return Menu.buildFromTemplate(template);
}

// ---------------------------------------------------------------- IPC

ipcMain.handle('capabilities', () => ({
  presets: Object.keys(PRESETS).map((id) => ({ id, imageMaxTokens: PRESETS[id] })),
  tasks: TASKS,
  kieSchema: KIE_SCHEMA,
  hasRuntime: (() => {
    try {
      const root = findRoot(__dirname);
      return fs.existsSync(path.join(root, 'resources', 'models', 'Xiaomi-OCR-0.Q4_K_M.gguf'));
    } catch {
      return false;
    }
  })(),
}));

ipcMain.handle('open-files', async () => {
  const res = await dialog.showOpenDialog({
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: '图片和 PDF', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'tif', 'tiff', 'pdf'] },
      { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'tif', 'tiff'] },
      { name: 'PDF', extensions: ['pdf'] },
    ],
  });
  return res.canceled ? [] : res.filePaths;
});

ipcMain.handle('server-status', () => ({
  running: server !== null,
  preset: activePreset,
  port: PORT,
}));

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
};

/** 渲染进程加载本地图片：dev 下是 http:// 页面，file:// 会被拦，所以走 dataURL */
ipcMain.handle('read-image', async (_e, filePath: string) => {
  if (!IMAGE_EXT.has(path.extname(filePath).toLowerCase())) {
    return { ok: false, error: '不是图片文件' };
  }
  const st = fs.statSync(filePath);
  if (st.size > 40 * 1024 * 1024) return { ok: false, error: '图片超过 40 MB' };
  const buf = await fs.promises.readFile(filePath);
  const mime = MIME[path.extname(filePath).toLowerCase()] ?? 'image/png';
  return { ok: true, dataUrl: `data:${mime};base64,${buf.toString('base64')}` };
});

/** PDF 原始字节交给渲染进程用 pdfjs 渲染（主进程没有 canvas）。 */
ipcMain.handle('read-pdf', async (_e, filePath: string) => {
  if (path.extname(filePath).toLowerCase() !== '.pdf') return { ok: false, error: '不是 PDF 文件' };
  const st = fs.statSync(filePath);
  if (st.size > MAX_PDF_BYTES) return { ok: false, error: 'PDF 超过 200 MB' };
  const buf = await fs.promises.readFile(filePath);
  return { ok: true, data: new Uint8Array(buf), name: path.basename(filePath), bytes: buf.byteLength };
});

interface IdentifyTarget {
  label: string;
  /** 图片走路径 */
  path?: string;
  /** PDF 页等由渲染进程提供位图 */
  imageUri?: string;
}

ipcMain.handle(
  'identify',
  async (
    _e,
    req: {
      targets: IdentifyTarget[];
      task: TaskKind;
      preset: string;
      parallel?: number;
      kieSchema?: Record<string, unknown> | string;
    }
  ): Promise<{ ok: true; results: PageResult[] } | { ok: false; error: string }> => {
    try {
      const targets = (req.targets ?? []).filter((t) => {
        if (t.imageUri) return true;
        if (!t.path) return false;
        if (!IMAGE_EXT.has(path.extname(t.path).toLowerCase())) return false;
        return fs.existsSync(t.path);
      });
      if (targets.length === 0) return { ok: false, error: '没有可识别的目标' };
      if (!TASKS.includes(req.task)) return { ok: false, error: `未知任务: ${req.task}` };
      if (!(req.preset in PRESETS)) return { ok: false, error: `未知预设: ${req.preset}` };

      // 并发不超过目标数，也不超过显存能撑的上限（A770 16G / M0 实测 4 槽约 8G）
      const parallel = Math.max(1, Math.min(req.parallel ?? 1, targets.length, 4));

      // 先按内容寻址查缓存：命中的页直接出结果，既省 GPU 也天然支持「跑到一半崩了再续」
      const cache = resultCache();
      const slots: (PageResult | null)[] = new Array(targets.length).fill(null);
      const keys: string[] = new Array(targets.length).fill('');
      const pending: { index: number; req: PageRequest }[] = [];

      for (let i = 0; i < targets.length; i++) {
        const t = targets[i];
        const uri = t.imageUri ?? (t.path ? await imageDataUri(t.path) : undefined);
        if (!uri) continue;
        const key = cache.key(uri, req.task, req.preset, req.kieSchema);
        keys[i] = key;
        const hit = cache.read(key);
        if (hit) {
          // 缓存里存的是当次识别的 label，复用时要换成本次请求的 label，
          // 否则界面按 label 回填会对不上，表现为「点了识别但一直转圈」。
          slots[i] = { ...hit, file: t.label || hit.file, cached: true };
          send('progress', { index: i, total: targets.length, file: t.label, phase: 'done', ok: true, cached: true });
          continue;
        }
        pending.push({
          index: i,
          req: {
            file: t.label || t.path || `page-${i}`,
            baseUrl: '',
            task: req.task,
            imageUri: uri,
            kieSchema: req.kieSchema,
            timeoutMs: 900_000,
          },
        });
      }

      const errors: string[] = [];
      if (pending.length > 0) {
        const srv = await ensureServer(req.preset, Math.min(parallel, pending.length));
        for (const p of pending) p.req.baseUrl = srv.baseUrl;

        const raw = await runBatch(
          pending.map((p) => p.req),
          parallel,
          (r, k) => {
            const idx = pending[k].index;
            send('progress', {
              index: idx,
              total: targets.length,
              file: targets[idx].label,
              phase: 'done',
              ok: !('error' in r),
            });
          },
          runPageResilient
        );

        raw.forEach((r, k) => {
          const idx = pending[k].index;
          if ('error' in r) {
            errors.push(`${r.file}: ${r.error}`);
            return;
          }
          slots[idx] = r;
          if (keys[idx]) cache.write(keys[idx], r);
        });
      }

      const results = slots.filter((r): r is PageResult => r !== null);
      if (results.length === 0) return { ok: false, error: errors.join('; ') || '全部失败' };
      return { ok: true, results };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }
);

ipcMain.handle(
  'export',
  async (
    _e,
    req: {
      format: 'md' | 'html' | 'docx';
      pages: { label: string; markdown: string }[];
      defaultName?: string;
      /** 仅自动化测试用：给了就跳过保存对话框（渲染进程受 CSP 与隔离约束，且内容只来自本机识别） */
      savePath?: string;
    }
  ): Promise<{ ok: true; path: string } | { ok: false; error?: string; canceled?: boolean }> => {
    try {
      const pages = (req.pages ?? []).filter((p) => p && typeof p.markdown === 'string');
      if (pages.length === 0) return { ok: false, error: '没有可导出的内容' };

      const base = (req.defaultName ?? 'moocr').replace(/[\\/:*?"<>|]/g, '_');
      const ext = req.format;

      let target = '';
      if (req.savePath && path.isAbsolute(req.savePath)) {
        target = req.savePath;
      } else {
        const res = await dialog.showSaveDialog({
          defaultPath: `${base}.${ext}`,
          filters: [
            req.format === 'md'
              ? { name: 'Markdown', extensions: ['md'] }
              : req.format === 'html'
                ? { name: 'HTML', extensions: ['html'] }
                : { name: 'Word 文档', extensions: ['docx'] },
          ],
        });
        if (res.canceled || !res.filePath) return { ok: false, canceled: true };
        target = res.filePath;
      }

      const title = base;
      if (req.format === 'md') {
        await fs.promises.writeFile(target, toMarkdown(pages, { title }), 'utf8');
      } else if (req.format === 'html') {
        await fs.promises.writeFile(target, toHtmlDocument(pages, { title }), 'utf8');
      } else {
        const buf = await toDocxBuffer(pages, { title });
        await fs.promises.writeFile(target, buf);
      }
      return { ok: true, path: target };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }
);

ipcMain.handle('claim-argv', () => {
  const p = pendingArgv;
  pendingArgv = [];
  return p;
});

ipcMain.handle('cache-stats', () => resultCache().stats());
ipcMain.handle('cache-clear', () => {
  const n = resultCache().clear();
  send('notice', { kind: 'info', text: `已清空 ${n} 条识别缓存` });
  return { cleared: n };
});

ipcMain.handle('reveal', (_e, filePath: string) => {
  shell.showItemInFolder(filePath);
});

// 窗口按钮是系统画的，CSS 管不到，主题变了要单独告诉它
ipcMain.handle('chrome-theme', (_e, dark: boolean) => {
  if (!win || win.isDestroyed()) return;
  const bg = dark ? '#0f1115' : '#ffffff';
  win.setTitleBarOverlay({ color: bg, symbolColor: dark ? '#c9d1d9' : '#414a59', height: 40 });
  win.setBackgroundColor(bg);
});

/**
 * 自绘菜单里不涉及界面状态的命令。打开文件、导出这类需要渲染进程状态的，
 * 由渲染进程自己处理，不走这里。
 */
ipcMain.handle('menu-action', async (_e, action: string) => {
  const w = win;
  if (!w || w.isDestroyed()) return { ok: false, error: '窗口已关闭' };
  const wc = w.webContents;

  switch (action) {
    case 'edit-undo':
      wc.undo();
      break;
    case 'edit-redo':
      wc.redo();
      break;
    case 'edit-cut':
      wc.cut();
      break;
    case 'edit-copy':
      wc.copy();
      break;
    case 'edit-paste':
      wc.paste();
      break;
    case 'edit-selectall':
      wc.selectAll();
      break;
    case 'reload':
      wc.reload();
      break;
    case 'devtools':
      wc.toggleDevTools();
      break;
    case 'zoom-in':
      wc.setZoomLevel(Math.min(wc.getZoomLevel() + 0.5, 5));
      break;
    case 'zoom-out':
      wc.setZoomLevel(Math.max(wc.getZoomLevel() - 0.5, -3));
      break;
    case 'zoom-reset':
      wc.setZoomLevel(0);
      break;
    case 'fullscreen':
      w.setFullScreen(!w.isFullScreen());
      break;
    case 'clear-cache': {
      const n = resultCache().clear();
      send('notice', { kind: 'info', text: `已清空 ${n} 条识别缓存` });
      break;
    }
    case 'quit':
      app.quit();
      break;
    case 'about': {
      await dialog.showMessageBox(w, {
        type: 'info',
        title: '关于墨客',
        message: '墨客 moocr',
        detail: [
          `版本 ${app.getVersion()}`,
          '模型 Xiaomi-OCR-0（0.87B，Apache-2.0）',
          '推理 llama.cpp Vulkan 后端，全程本地运行',
          '',
          `Electron ${process.versions.electron} · Node ${process.versions.node}`,
        ].join('\n'),
        buttons: ['好'],
      });
      break;
    }
    default:
      return { ok: false, error: `未知动作 ${action}` };
  }
  return { ok: true };
});

// ---------------------------------------------------------------- 截图

ipcMain.handle('capture', () => runCapture());

ipcMain.handle('overlay-config', (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  return w ? overlayConfig(w) : null;
});

ipcMain.on('overlay-finish', (e, rect: { x: number; y: number; width: number; height: number }) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (w) overlayFinish(w, rect);
});

ipcMain.on('overlay-cancel', (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (w) cancelCapture();
});

// ---------------------------------------------------------------- 生命周期

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    // 第二次启动带文件：此时渲染进程已就绪，直接推过去
    const files = argv.filter((a) => {
      const ext = path.extname(a).toLowerCase();
      return IMAGE_EXT.has(ext) || ext === '.pdf';
    });
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
      if (files.length > 0) send('open-paths', files);
    } else {
      pendingArgv = files;
    }
  });

  void app.whenReady().then(() => {
    // 菜单已经画在页面顶部，系统菜单栏留空；macOS 仍需要它才能 Cmd+Q / Cmd+H
    Menu.setApplicationMenu(process.platform === 'darwin' ? buildMenu() : null);
    createWindow();
    // 全局热键：主窗不在前台也要能截
    if (!globalShortcut.register(CAPTURE_HOTKEY, () => void runCapture())) {
      send('notice', { text: `热键 ${CAPTURE_HOTKEY} 注册失败（可能被别的程序占用）` });
    }
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    globalShortcut.unregisterAll();
    if (server) {
      const s = server;
      server = null;
      void stopServer(s);
    }
  });
}

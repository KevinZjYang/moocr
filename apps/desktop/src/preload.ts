import { contextBridge, ipcRenderer, webUtils } from 'electron';

export interface IdentifyTarget {
  label: string;
  path?: string;
  imageUri?: string;
}

export interface Api {
  capabilities(): Promise<{
    presets: { id: string; imageMaxTokens: number }[];
    tasks: string[];
    kieSchema: Record<string, unknown>;
    hasRuntime: boolean;
  }>;
  openFiles(): Promise<string[]>;
  serverStatus(): Promise<{ running: boolean; preset: string | null; port: number }>;
  readImage(filePath: string): Promise<{ ok: true; dataUrl: string } | { ok: false; error: string }>;
  readPdf(
    filePath: string
  ): Promise<{ ok: true; data: Uint8Array; name: string; bytes: number } | { ok: false; error: string }>;
  pathForFile(file: File): string;
  identify(req: {
    targets: IdentifyTarget[];
    task: string;
    preset: string;
    parallel?: number;
    kieSchema?: Record<string, unknown> | string;
  }): Promise<{ ok: true; results: unknown[] } | { ok: false; error: string }>;
  export(req: {
    format: 'md' | 'html' | 'docx';
    pages: { label: string; markdown: string }[];
    defaultName?: string;
    savePath?: string;
  }): Promise<{ ok: true; path: string } | { ok: false; error?: string; canceled?: boolean }>;
  reveal(filePath: string): Promise<void>;
  claimArgv(): Promise<string[]>;
  cacheStats(): Promise<{ entries: number; bytes: number; hits: number; misses: number }>;
  cacheClear(): Promise<{ cleared: number }>;
  capture(): Promise<{ ok: boolean; path?: string; error?: string }>;
  menuAction(action: string): Promise<{ ok: boolean; error?: string }>;
  /** 把主题结果告诉主进程，用来改窗口按钮配色 */
  setChromeTheme(dark: boolean): Promise<void>;
  onCapture(cb: (c: { path: string; width: number; height: number }) => void): () => void;
  onNotice(cb: (n: { text: string }) => void): () => void;
  onProgress(cb: (p: unknown) => void): () => void;
  onServerState(cb: (s: unknown) => void): () => void;
  onMenuOpen(cb: () => void): () => void;
  onOpenPaths(cb: (paths: string[]) => void): () => void;
}

const api: Api = {
  capabilities: () => ipcRenderer.invoke('capabilities'),
  openFiles: () => ipcRenderer.invoke('open-files'),
  serverStatus: () => ipcRenderer.invoke('server-status'),
  readImage: (filePath) => ipcRenderer.invoke('read-image', filePath),
  readPdf: (filePath) => ipcRenderer.invoke('read-pdf', filePath),
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  },
  identify: (req) => ipcRenderer.invoke('identify', req),
  export: (req) => ipcRenderer.invoke('export', req),
  reveal: (filePath) => ipcRenderer.invoke('reveal', filePath),
  claimArgv: () => ipcRenderer.invoke('claim-argv'),
  cacheStats: () => ipcRenderer.invoke('cache-stats'),
  cacheClear: () => ipcRenderer.invoke('cache-clear'),
  capture: () => ipcRenderer.invoke('capture'),
  menuAction: (action) => ipcRenderer.invoke('menu-action', action),
  setChromeTheme: (dark) => ipcRenderer.invoke('chrome-theme', dark),
  onCapture: (cb) => {
    const h = (_e: unknown, c: { path: string; width: number; height: number }) => cb(c);
    ipcRenderer.on('capture-done', h);
    return () => ipcRenderer.off('capture-done', h);
  },
  onNotice: (cb) => {
    const h = (_e: unknown, n: { text: string }) => cb(n);
    ipcRenderer.on('notice', h);
    return () => ipcRenderer.off('notice', h);
  },
  onProgress: (cb) => {
    const h = (_e: unknown, p: unknown) => cb(p);
    ipcRenderer.on('progress', h);
    return () => ipcRenderer.off('progress', h);
  },
  onServerState: (cb) => {
    const h = (_e: unknown, s: unknown) => cb(s);
    ipcRenderer.on('server-state', h);
    return () => ipcRenderer.off('server-state', h);
  },
  onMenuOpen: (cb) => {
    const h = () => cb();
    ipcRenderer.on('menu-open', h);
    return () => ipcRenderer.off('menu-open', h);
  },
  onOpenPaths: (cb) => {
    const h = (_e: unknown, paths: string[]) => cb(paths);
    ipcRenderer.on('open-paths', h);
    return () => ipcRenderer.off('open-paths', h);
  },
};

contextBridge.exposeInMainWorld('moocr', api);

import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type {
  ComponentId,
  DownloadProgress,
  RuntimeStatus,
} from '../../../packages/runtime/src/index.ts';

export interface IdentifyTarget {
  label: string;
  path?: string;
  imageUri?: string;
}

export interface RuntimeActionResult {
  ok: boolean;
  status: RuntimeStatus;
  error?: string;
  canceled?: boolean;
  imported?: string[];
}

export interface Api {
  capabilities(): Promise<{
    presets: { id: string; imageMaxTokens: number }[];
    tasks: string[];
    kieSchema: Record<string, unknown>;
    hasRuntime: boolean;
    runtime: RuntimeStatus;
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
  }): Promise<
    | { ok: true; results: unknown[] }
    | { ok: false; error: string; code?: 'RUNTIME_MISSING'; missing?: string[] }
  >;
  export(req: {
    format: 'md' | 'html' | 'docx';
    pages: { label: string; markdown: string }[];
    defaultName?: string;
    savePath?: string;
  }): Promise<{ ok: true; path: string } | { ok: false; error?: string; canceled?: boolean }>;
  reveal(filePath: string): Promise<void>;
  openModelsDir(): Promise<{ ok: boolean; path?: string; error?: string }>;
  runtimeStatus(): Promise<RuntimeStatus>;
  runtimeStart(ids?: ComponentId[]): Promise<RuntimeActionResult>;
  runtimePause(): Promise<RuntimeActionResult>;
  runtimeImport(): Promise<RuntimeActionResult>;
  runtimeReset(kind?: 'models' | 'all'): Promise<RuntimeActionResult>;
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
  onRuntimeProgress(cb: (p: DownloadProgress) => void): () => void;
  onRuntimeState(cb: (s: RuntimeStatus) => void): () => void;
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
  openModelsDir: () => ipcRenderer.invoke('open-models-dir'),
  runtimeStatus: () => ipcRenderer.invoke('runtime-status'),
  runtimeStart: (ids) => ipcRenderer.invoke('runtime-start', ids),
  runtimePause: () => ipcRenderer.invoke('runtime-pause'),
  runtimeImport: () => ipcRenderer.invoke('runtime-import'),
  runtimeReset: (kind) => ipcRenderer.invoke('runtime-reset', kind),
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
  onRuntimeProgress: (cb) => {
    const h = (_e: unknown, p: DownloadProgress) => cb(p);
    ipcRenderer.on('runtime-progress', h);
    return () => ipcRenderer.off('runtime-progress', h);
  },
  onRuntimeState: (cb) => {
    const h = (_e: unknown, s: RuntimeStatus) => cb(s);
    ipcRenderer.on('runtime-state', h);
    return () => ipcRenderer.off('runtime-state', h);
  },
};

contextBridge.exposeInMainWorld('moocr', api);

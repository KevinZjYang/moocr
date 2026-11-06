/**
 * 桌面端运行时服务：把 packages/runtime 的解析/下载/校验接到 Electron 的生命周期上。
 *
 * 位置约定（按优先级）：
 *   1. MOOCR_RUNTIME_DIR（测试/绿色版）
 *   2. userData/runtime      ← 应用内下载写这里，安装目录只读也没关系
 *   3. <app>/resources       ← 开发检出；打包后是 resources/runtime（内置 llama.cpp）
 *   4. 0.1.0 旧布局          ← <install>/resources/resources/{llama,models}
 */
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

import manifestJson from '../../../packages/runtime/runtime-manifest.json';
import {
  parseManifest,
  resolveRuntime,
  pathsFromStatus,
  createRuntimeInstaller,
  ensureUserDirs,
  type ComponentId,
  type DownloadProgress,
  type ImportResult,
  type RuntimeInstaller,
  type RuntimeLocations,
  type RuntimeManifest,
  type RuntimeStatus,
} from '../../../packages/runtime/src/index.ts';
import type { PathOverrides } from '../../../packages/inference/src/server.ts';

export interface RuntimeServiceOptions {
  onProgress?: (p: DownloadProgress) => void;
  onStatus?: (s: RuntimeStatus) => void;
  log?: (line: string) => void;
}

/** 开发时从 dist 往上找 package.json，打包后直接用 resourcesPath */
export function appRoot(): string {
  if (app.isPackaged) return process.resourcesPath;
  let dir = __dirname;
  for (let i = 0; i < 6; i += 1) {
    const pkg = path.join(dir, 'package.json');
    if (fs.existsSync(pkg)) {
      try {
        if (JSON.parse(fs.readFileSync(pkg, 'utf8')).name === 'moocr') return dir;
      } catch {
        /* 继续往上找 */
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

export function bundledRuntimeRoot(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'runtime')
    : path.join(appRoot(), 'resources');
}

export function legacyRuntimeRoots(): string[] {
  if (!app.isPackaged) return [];
  // v0.1.0 的 extraResources 把资源放在 resources/resources 下
  return [path.join(process.resourcesPath, 'resources'), process.resourcesPath];
}

export function userRuntimeRoot(): string {
  return path.join(app.getPath('userData'), 'runtime');
}

export class RuntimeService {
  readonly manifest: RuntimeManifest;
  readonly locations: RuntimeLocations;
  private readonly installer: RuntimeInstaller;
  private cached: RuntimeStatus;

  constructor(opts: RuntimeServiceOptions = {}) {
    this.manifest = parseManifest(manifestJson);
    this.locations = {
      userRoot: userRuntimeRoot(),
      bundledRoot: bundledRuntimeRoot(),
      envRoot: process.env.MOOCR_RUNTIME_DIR || undefined,
      legacyRoots: legacyRuntimeRoots(),
    };
    ensureUserDirs(this.locations);

    this.installer = createRuntimeInstaller({
      manifest: this.manifest,
      locations: this.locations,
      onProgress: opts.onProgress,
      onStatus: (s) => {
        this.cached = s;
        opts.onStatus?.(s);
      },
      log: opts.log,
    });
    this.cached = this.installer.status();
  }

  status(): RuntimeStatus {
    return this.cached;
  }

  refresh(): RuntimeStatus {
    this.cached = this.installer.refresh();
    return this.cached;
  }

  get installing(): boolean {
    return this.installer.busy;
  }

  async start(ids?: ComponentId[]): Promise<RuntimeStatus> {
    const s = await this.installer.start(ids);
    this.cached = s;
    return s;
  }

  pause(): RuntimeStatus {
    this.installer.pause();
    return this.status();
  }

  async reset(kind: 'models' | 'all' = 'models'): Promise<RuntimeStatus> {
    this.cached = await this.installer.reset(kind);
    return this.cached;
  }

  async importFiles(files: string[]): Promise<ImportResult> {
    const r = await this.installer.importFiles(files);
    this.cached = r.status;
    return r;
  }

  /** 给 inference 的 StartOptions.assets */
  paths(): PathOverrides {
    const s = this.status();
    const p = pathsFromStatus(s);
    return { root: s.userRoot, serverExe: p.serverExe, model: p.model, mmproj: p.mmproj };
  }

  /** 模型文件的稳定标识，用于结果缓存失效 */
  cacheKey(): string {
    const s = this.status();
    const model = s.components.find((c) => c.id === 'model');
    return model?.path ?? path.join(this.locations.userRoot, 'models', this.manifest.models[0].file);
  }

  modelsDir(): string {
    const dir = path.join(this.locations.userRoot, 'models');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }
}

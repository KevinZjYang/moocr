/**
 * 运行时资产的位置解析。
 *
 * 安装目录在 Program Files 下是只读的，所以权重与 sidecar 状态都必须能落到
 * userData；而已发行的安装包只带 llama.cpp 二进制。于是按「组件」而不是按
 * 「根目录」解析：llama 可能来自安装包，权重可能来自用户下载，两者互不绑定。
 *
 * 优先级（高 → 低）：
 *   MOOCR_RUNTIME_DIR  →  userData/runtime  →  应用内置  →  0.1.0 旧目录
 */
import fs from 'node:fs';
import path from 'node:path';

export type ComponentId = 'llama' | 'model' | 'mmproj';
export type ComponentSource = 'env' | 'user' | 'bundled' | 'legacy';

export interface ModelEntry {
  id: 'model' | 'mmproj';
  label?: string;
  file: string;
  bytes: number;
  sha256: string;
  url: string;
  mirrors?: string[];
}

export interface LlamaArchive {
  url: string;
  mirrors?: string[];
  bytes: number;
  sha256: string;
}

export interface RuntimeManifest {
  schemaVersion: number;
  llama: { version: string; archives: Record<string, LlamaArchive> };
  models: ModelEntry[];
  license?: { name: string; url: string };
  totalBytes: number;
}

export interface RuntimeLocations {
  /** 安装包内只读资产根：打包版 <resourcesPath>/runtime，开发版 <repo>/resources */
  bundledRoot: string;
  /** 可写资产根：<userData>/runtime */
  userRoot: string;
  /** 环境变量覆盖，子目录同样是 llama/bin 与 models */
  envRoot?: string;
  /** 0.1.0 的旧落点，只读探测，不写入 */
  legacyRoots?: string[];
}

export interface ComponentStatus {
  id: ComponentId;
  label: string;
  present: boolean;
  path?: string;
  bytes?: number;
  expectedBytes?: number;
  source?: ComponentSource;
  /** 找到了文件但大小/内容不符时的说明，用于界面提示 */
  note?: string;
}

export interface RuntimeStatus {
  ready: boolean;
  components: ComponentStatus[];
  missing: ComponentId[];
  modelsDir: string;
  llamaBinDir: string;
  userRoot: string;
  bundledRoot: string;
  totalBytes: number;
  llamaVersion: string;
}

export interface ResolvedPaths {
  root: string;
  serverExe: string;
  model: string;
  mmproj: string;
}

interface Candidate {
  root: string;
  source: ComponentSource;
}

const MODEL_LABELS: Record<string, string> = {
  model: 'Xiaomi-OCR-0 Q4_K_M',
  mmproj: '视觉编码器 mmproj',
};

export function serverName(platform: string = process.platform): string {
  return platform === 'win32' ? 'llama-server.exe' : 'llama-server';
}

export function candidates(loc: RuntimeLocations): Candidate[] {
  const list: Candidate[] = [];
  if (loc.envRoot) list.push({ root: loc.envRoot, source: 'env' });
  list.push({ root: loc.userRoot, source: 'user' });
  list.push({ root: loc.bundledRoot, source: 'bundled' });
  for (const root of loc.legacyRoots ?? []) list.push({ root, source: 'legacy' });
  return list;
}

export function llamaBinDirOf(root: string): string {
  return path.join(root, 'llama', 'bin');
}

export function modelsDirOf(root: string): string {
  return path.join(root, 'models');
}

function statFile(file: string): { size: number } | null {
  try {
    const st = fs.statSync(file);
    return st.isFile() ? { size: st.size } : null;
  } catch {
    return null;
  }
}

/**
 * 只看大小不看哈希：启动路径上要对 700 MB 文件做毫秒级判断。
 * 哈希在下载/导入/手动校验后才算（见 verify.ts）。
 */
function matches(file: string, expectedBytes?: number): { ok: boolean; bytes?: number } {
  const st = statFile(file);
  if (!st) return { ok: false };
  if (expectedBytes && st.size !== expectedBytes) return { ok: false, bytes: st.size };
  if (st.size === 0) return { ok: false, bytes: 0 };
  return { ok: true, bytes: st.size };
}

export function resolveRuntime(
  manifest: RuntimeManifest,
  loc: RuntimeLocations,
  platform: string = process.platform
): RuntimeStatus {
  const list = candidates(loc);
  const components: ComponentStatus[] = [];

  const exe = serverName(platform);
  const llama: ComponentStatus = {
    id: 'llama',
    label: `llama.cpp ${manifest.llama.version}（Vulkan）`,
    present: false,
    expectedBytes: manifest.llama.archives[`${platform}-${process.arch}`]?.bytes,
  };
  for (const c of list) {
    const file = path.join(llamaBinDirOf(c.root), exe);
    const m = matches(file);
    if (m.ok) {
      Object.assign(llama, { present: true, path: file, bytes: m.bytes, source: c.source });
      break;
    }
    if (m.bytes !== undefined && !llama.note) {
      llama.note = `${file} 存在但不完整（${m.bytes} 字节）`;
    }
  }
  components.push(llama);

  for (const model of manifest.models) {
    const item: ComponentStatus = {
      id: model.id,
      label: model.label ?? MODEL_LABELS[model.id] ?? model.file,
      present: false,
      expectedBytes: model.bytes,
    };
    for (const c of list) {
      const file = path.join(modelsDirOf(c.root), model.file);
      const m = matches(file, model.bytes);
      if (m.ok) {
        Object.assign(item, { present: true, path: file, bytes: m.bytes, source: c.source });
        break;
      }
      if (m.bytes !== undefined && !item.note) {
        item.note = `${file} 大小不符（${m.bytes} / ${model.bytes} 字节）`;
      }
    }
    components.push(item);
  }

  const byId = new Map(components.map((c) => [c.id, c]));
  const modelComp = byId.get('model');
  const llamaComp = byId.get('llama');
  const missing = components.filter((c) => !c.present).map((c) => c.id);
  const totalBytes = manifest.models.reduce((n, m) => n + m.bytes, 0);

  return {
    ready: missing.length === 0,
    components,
    missing,
    modelsDir: modelComp?.present && modelComp.path
      ? path.dirname(modelComp.path)
      : modelsDirOf(loc.userRoot),
    llamaBinDir: llamaComp?.present && llamaComp.path
      ? path.dirname(llamaComp.path)
      : llamaBinDirOf(loc.userRoot),
    userRoot: loc.userRoot,
    bundledRoot: loc.bundledRoot,
    totalBytes,
    llamaVersion: manifest.llama.version,
  };
}

/** 给 inference 的 resolvePaths 用：只取已解析到的三个组件 */
export function pathsFromStatus(status: RuntimeStatus): ResolvedPaths {
  const byId = new Map(status.components.map((c) => [c.id, c]));
  return {
    root: status.userRoot,
    serverExe:
      byId.get('llama')?.path ?? path.join(status.llamaBinDir, serverName()),
    model:
      byId.get('model')?.path ?? path.join(status.modelsDir, 'Xiaomi-OCR-0.Q4_K_M.gguf'),
    mmproj:
      byId.get('mmproj')?.path ?? path.join(status.modelsDir, 'Xiaomi-OCR-0.mmproj-bf16.gguf'),
  };
}

export function ensureUserDirs(loc: RuntimeLocations): void {
  fs.mkdirSync(modelsDirOf(loc.userRoot), { recursive: true });
  fs.mkdirSync(llamaBinDirOf(loc.userRoot), { recursive: true });
}

/** 清单里某个平台的 llama 归档；没有就返回 null（例如未支持的平台） */
export function archiveFor(
  manifest: RuntimeManifest,
  platform: string = process.platform,
  arch: string = process.arch
): LlamaArchive | null {
  return manifest.llama.archives[`${platform}-${arch}`] ?? null;
}

export function modelById(manifest: RuntimeManifest, id: ComponentId): ModelEntry | null {
  return manifest.models.find((m) => m.id === id) ?? null;
}

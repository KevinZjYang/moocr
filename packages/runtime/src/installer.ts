/**
 * 应用内运行时安装器：单例、可暂停/续传、可离线导入。
 *
 * 只写 userData（<userData>/runtime），从不碰安装目录。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  archiveFor,
  ensureUserDirs,
  llamaBinDirOf,
  modelById,
  modelsDirOf,
  resolveRuntime,
  serverName,
  type ComponentId,
  type RuntimeLocations,
  type RuntimeManifest,
  type RuntimeStatus,
} from './paths.ts';
import {
  downloadFile,
  DownloadPausedError,
  type DownloadProgress,
  type FetchLike,
} from './download.ts';
import { verifyFile } from './verify.ts';
import { extractLlamaBin } from './archive.ts';
import { probeLlamaServer } from './verify.ts';

export type InstallerPhase =
  | 'idle'
  | 'connecting'
  | 'downloading'
  | 'verifying'
  | 'extracting'
  | 'paused'
  | 'done'
  | 'error';

export interface InstallerOptions {
  manifest: RuntimeManifest;
  locations: RuntimeLocations;
  platform?: string;
  arch?: string;
  fetchImpl?: FetchLike;
  onProgress?: (p: DownloadProgress) => void;
  onStatus?: (s: RuntimeStatus) => void;
  log?: (line: string) => void;
}

export interface ImportResult {
  ok: boolean;
  status: RuntimeStatus;
  imported?: string[];
  error?: string;
}

export interface RuntimeInstaller {
  readonly phase: InstallerPhase;
  readonly busy: boolean;
  status(): RuntimeStatus;
  refresh(): RuntimeStatus;
  start(ids?: ComponentId[]): Promise<RuntimeStatus>;
  pause(): void;
  reset(kind?: 'models' | 'all'): Promise<void>;
  importFiles(files: string[]): Promise<ImportResult>;
}

interface InstalledState {
  schemaVersion: 1;
  llama?: { version: string; installedAt: string };
  models?: Record<string, { file: string; bytes: number; sha256: string; installedAt: string }>;
  updatedAt: string;
}

export function createRuntimeInstaller(opts: InstallerOptions): RuntimeInstaller {
  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;
  const loc = opts.locations;
  const manifest = opts.manifest;
  const log = (line: string) => opts.log?.(line);
  const statePath = path.join(loc.userRoot, '.runtime.json');

  let phase: InstallerPhase = 'idle';
  let running: Promise<RuntimeStatus> | null = null;
  let ctrl: AbortController | null = null;
  let pauseRequested = false;
  let lastProgress: DownloadProgress | null = null;

  const status = () => resolveRuntime(manifest, loc, platform);

  const emitStatus = (s: RuntimeStatus) => {
    opts.onStatus?.(s);
    return s;
  };

  const emit = (p: DownloadProgress) => {
    lastProgress = p;
    opts.onProgress?.(p);
  };

  const setPhase = (next: InstallerPhase) => {
    phase = next;
  };

  async function writeState(patch: Partial<InstalledState>): Promise<void> {
    let current: InstalledState = { schemaVersion: 1, updatedAt: new Date().toISOString() };
    try {
      current = { ...current, ...(JSON.parse(await fsp.readFile(statePath, 'utf8')) as InstalledState) };
    } catch {
      /* 首次安装 */
    }
    const next: InstalledState = {
      ...current,
      ...patch,
      models: { ...(current.models ?? {}), ...(patch.models ?? {}) },
      updatedAt: new Date().toISOString(),
    };
    await fsp.mkdir(loc.userRoot, { recursive: true });
    await fsp.writeFile(statePath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  }

  async function installModel(id: 'model' | 'mmproj', base: number, total: number): Promise<number> {
    const entry = modelById(manifest, id);
    if (!entry) throw new Error(`清单里没有 ${id}`);

    const dest = path.join(modelsDirOf(loc.userRoot), entry.file);
    await downloadFile(
      {
        url: entry.url,
        mirrors: entry.mirrors,
        dest,
        bytes: entry.bytes,
        sha256: entry.sha256,
        componentId: id,
        overallBase: base,
        overallTotal: total,
      },
      {
        fetchImpl: opts.fetchImpl,
        signal: ctrl?.signal,
        log,
        onProgress: emit,
      }
    );

    await writeState({
      models: {
        [id]: {
          file: entry.file,
          bytes: entry.bytes,
          sha256: entry.sha256,
          installedAt: new Date().toISOString(),
        },
      },
    });
    log(`模型就绪：${entry.file}`);
    return base + entry.bytes;
  }

  async function installLlama(base: number, total: number): Promise<number> {
    const archive = archiveFor(manifest, platform, arch);
    if (!archive) throw new Error(`没有 ${platform}-${arch} 的 llama.cpp 归档，无法自动安装`);

    const cacheDir = path.join(loc.userRoot, '.cache');
    const zip = path.join(cacheDir, `llama-${manifest.llama.version}-${platform}-${arch}.zip`);
    await fsp.mkdir(cacheDir, { recursive: true });

    await downloadFile(
      {
        url: archive.url,
        mirrors: archive.mirrors,
        dest: zip,
        bytes: archive.bytes,
        sha256: archive.sha256,
        componentId: 'llama',
        overallBase: base,
        overallTotal: total,
      },
      {
        fetchImpl: opts.fetchImpl,
        signal: ctrl?.signal,
        log,
        onProgress: emit,
      }
    );

    setPhase('extracting');
    emit({
      phase: 'extracting',
      componentId: 'llama',
      file: path.basename(zip),
      received: archive.bytes,
      total: archive.bytes,
      bps: 0,
      etaMs: 0,
      overallReceived: base + archive.bytes,
      overallTotal: total,
    });

    const binDir = llamaBinDirOf(loc.userRoot);
    await extractLlamaBin(zip, binDir, { tmpRoot: loc.userRoot, platform });
    await fsp.rm(zip, { force: true }).catch(() => {});

    const exe = path.join(binDir, serverName(platform));
    const probe = await probeLlamaServer(exe, { cwd: binDir });
    if (!probe.ok) {
      log(`llama-server 探活失败：${probe.output.slice(0, 500) || `exit ${probe.code}`}`);
    } else {
      log('llama-server 探活通过');
    }

    await writeState({ llama: { version: manifest.llama.version, installedAt: new Date().toISOString() } });
    log(`llama.cpp ${manifest.llama.version} 就绪`);
    return base + archive.bytes;
  }

  async function run(ids?: ComponentId[]): Promise<RuntimeStatus> {
    pauseRequested = false;
    ctrl = new AbortController();
    ensureUserDirs(loc);

    const before = status();
    const wanted = ids ?? before.missing;
    const tasks: ComponentId[] = [];
    if (wanted.includes('llama') && !before.components.find((c) => c.id === 'llama')?.present) {
      tasks.push('llama');
    }
    for (const model of manifest.models) {
      if (wanted.includes(model.id) && !before.components.find((c) => c.id === model.id)?.present) {
        tasks.push(model.id);
      }
    }

    const total = tasks.reduce((n, id) => {
      if (id === 'llama') return n + (archiveFor(manifest, platform, arch)?.bytes ?? 0);
      return n + (modelById(manifest, id)?.bytes ?? 0);
    }, 0);

    if (tasks.length === 0) {
      setPhase('done');
      return emitStatus(status());
    }

    await assertDiskSpace(total, loc.userRoot);
    setPhase('connecting');
    let base = 0;
    try {
      for (const id of tasks) {
        if (pauseRequested) throw new DownloadPausedError();
        if (id === 'llama') base = await installLlama(base, total);
        else base = await installModel(id, base, total);
        emitStatus(status());
      }
      setPhase('done');
      emit({
        phase: 'done',
        received: total,
        total,
        bps: 0,
        etaMs: 0,
        overallReceived: total,
        overallTotal: total,
      });
      return emitStatus(status());
    } catch (e) {
      if (e instanceof DownloadPausedError || pauseRequested) {
        setPhase('paused');
        emit({
          phase: 'paused',
          received: lastProgress?.received ?? 0,
          total: lastProgress?.total ?? total,
          bps: 0,
          etaMs: null,
          overallReceived: lastProgress?.overallReceived ?? base,
          overallTotal: total,
        });
        return emitStatus(status());
      }
      setPhase('error');
      emit({
        phase: 'error',
        received: lastProgress?.received ?? 0,
        total: lastProgress?.total ?? total,
        bps: 0,
        etaMs: null,
        overallReceived: lastProgress?.overallReceived ?? base,
        overallTotal: total,
        message: (e as Error).message,
      });
      throw e;
    }
  }

  return {
    get phase() {
      return phase;
    },
    get busy() {
      return running !== null;
    },
    status,
    refresh: () => emitStatus(status()),

    start(ids?: ComponentId[]): Promise<RuntimeStatus> {
      if (running) return running;
      running = run(ids).finally(() => {
        running = null;
        ctrl = null;
      });
      return running;
    },

    pause(): void {
      pauseRequested = true;
      ctrl?.abort();
    },

    async reset(kind: 'models' | 'all' = 'models'): Promise<void> {
      if (running) throw new Error('正在下载，先暂停再删除');
      const targets: string[] = [];
      for (const model of manifest.models) {
        targets.push(path.join(modelsDirOf(loc.userRoot), model.file));
        targets.push(path.join(modelsDirOf(loc.userRoot), `${model.file}.part`));
      }
      if (kind === 'all') {
        targets.push(path.join(loc.userRoot, 'llama'));
        targets.push(path.join(loc.userRoot, '.cache'));
      }
      for (const file of targets) {
        await fsp.rm(file, { recursive: true, force: true }).catch(() => {});
      }
      await fsp.rm(statePath, { force: true }).catch(() => {});
      setPhase('idle');
      emitStatus(status());
    },

    async importFiles(files: string[]): Promise<ImportResult> {
      if (running) return { ok: false, status: status(), error: '正在下载，稍后再导入' };
      ensureUserDirs(loc);
      const imported: string[] = [];
      const failures: string[] = [];

      for (const source of files) {
        const name = path.basename(source);
        let entry = manifest.models.find((m) => m.file === name) ?? null;
        let size = 0;
        try {
          size = (await fsp.stat(source)).size;
        } catch {
          failures.push(`${name}：读不到文件`);
          continue;
        }
        if (!entry) entry = manifest.models.find((m) => m.bytes === size) ?? null;
        if (!entry) {
          failures.push(`${name}：不是已知的模型文件`);
          continue;
        }

        emit({
          phase: 'verifying',
          componentId: entry.id,
          file: name,
          received: 0,
          total: entry.bytes,
          bps: 0,
          etaMs: null,
          overallReceived: 0,
          overallTotal: entry.bytes,
          message: `校验 ${name}`,
        });

        const checked = await verifyFile(source, { bytes: entry.bytes, sha256: entry.sha256 });
        if (!checked.ok) {
          failures.push(`${name}：${checked.reason === 'hash' ? 'sha256 不符' : '大小不符'}`);
          continue;
        }

        const dest = path.join(modelsDirOf(loc.userRoot), entry.file);
        const tmp = `${dest}.importing`;
        try {
          await fsp.copyFile(source, tmp);
          await fsp.rm(dest, { force: true });
          await fsp.rename(tmp, dest);
          await writeState({
            models: {
              [entry.id]: {
                file: entry.file,
                bytes: entry.bytes,
                sha256: entry.sha256,
                installedAt: new Date().toISOString(),
              },
            },
          });
          imported.push(entry.file);
          log(`已导入 ${entry.file}`);
        } catch (e) {
          await fsp.rm(tmp, { force: true }).catch(() => {});
          failures.push(`${name}：写入失败（${(e as Error).message}）`);
        }
      }

      setPhase(status().ready ? 'done' : 'idle');
      const s = emitStatus(status());
      if (failures.length > 0) {
        return { ok: false, status: s, imported, error: failures.join('；') };
      }
      return { ok: true, status: s, imported };
    },
  };
}

/**
 * 下载前预检：目标盘至少再留 200 MB 余量，否则解压/临时文件会写到一半失败。
 * statfs 不可用时放行——宁可在写入时报错，也不要误报「空间不足」。
 */
async function assertDiskSpace(needBytes: number, dir: string): Promise<void> {
  if (needBytes <= 0) return;
  try {
    const st = await fsp.statfs(dir);
    const free = Number(st.bavail) * Number(st.bsize);
    const reserve = 200 * 1024 * 1024;
    if (free < needBytes + reserve) {
      const fmt = (n: number) => `${(n / 1000 ** 3).toFixed(2)} GB`;
      throw new Error(
        `磁盘空间不足：${dir} 所在分区需要约 ${fmt(needBytes + reserve)}，当前可用 ${fmt(free)}`
      );
    }
  } catch (e) {
    if ((e as Error).message.startsWith('磁盘空间不足')) throw e;
    // 某些网络盘/旧内核不支持 statfs，交给实际写入去报错
  }
}

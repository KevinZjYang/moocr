/**
 * 断点续传下载器（应用内下载与命令行 fetch 共用同一套语义）。
 *
 * 设计要点：
 *  - 永远写 `<dest>.part`，完整且 sha256 通过后才 rename 成正式文件；
 *  - 有 .part 就带 Range 续传，服务器返回 200 说明不支持续传，从头写；
 *  - 30 秒没有任何字节就中止并换 URL/镜像重试，HF 的连接会静默断流；
 *  - 取消（暂停）保留 .part，下次继续；
 *  - 每个 URL 失败后自动尝试 mirrors，全部失败再整体重来一轮。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { verifyFile } from './verify.ts';
import type { ComponentId } from './paths.ts';

export type FetchLike = (url: string, init?: Record<string, unknown>) => Promise<Response>;

export type DownloadPhase =
  | 'connecting'
  | 'downloading'
  | 'verifying'
  | 'done'
  | 'paused'
  | 'error';

export interface DownloadProgress {
  phase: DownloadPhase;
  componentId?: ComponentId;
  file?: string;
  received: number;
  total: number;
  bps: number;
  etaMs: number | null;
  overallReceived: number;
  overallTotal: number;
  message?: string;
}

export interface DownloadRequest {
  url: string;
  mirrors?: string[];
  dest: string;
  bytes: number;
  sha256?: string;
  componentId?: ComponentId;
  /** 本次任务开始前已完成的字节数，用于算总进度 */
  overallBase?: number;
  overallTotal?: number;
}

export interface DownloadDeps {
  fetchImpl?: FetchLike;
  onProgress?: (p: DownloadProgress) => void;
  signal?: AbortSignal;
  idleTimeoutMs?: number;
  log?: (line: string) => void;
}

export class DownloadPausedError extends Error {
  readonly code = 'DOWNLOAD_PAUSED';
  constructor() {
    super('下载已暂停');
    this.name = 'DownloadPausedError';
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function sizeOf(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

function prettyBytes(n: number): string {
  if (n >= 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}

export async function downloadFile(req: DownloadRequest, deps: DownloadDeps = {}): Promise<void> {
  const fetchImpl = deps.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  if (typeof fetchImpl !== 'function') throw new Error('当前环境没有 fetch，无法下载');

  const part = `${req.dest}.part`;
  const overallBase = req.overallBase ?? 0;
  const overallTotal = req.overallTotal ?? req.bytes;
  const idleTimeoutMs = deps.idleTimeoutMs ?? 30_000;
  const fileName = path.basename(req.dest);

  if (deps.signal?.aborted) {
    deps.onProgress?.({
      phase: 'paused',
      componentId: req.componentId,
      file: fileName,
      received: 0,
      total: req.bytes,
      bps: 0,
      etaMs: null,
      overallReceived: req.overallBase ?? 0,
      overallTotal: req.overallTotal ?? req.bytes,
    });
    throw new DownloadPausedError();
  }

  let received = Math.min(sizeOf(part), req.bytes || Number.MAX_SAFE_INTEGER);
  let windowStart = Date.now();
  let windowBytes = received;
  let lastEmit = 0;
  let bps = 0;

  const emit = (phase: DownloadPhase, extra: Partial<DownloadProgress> = {}, force = false) => {
    const now = Date.now();
    if (!force && now - lastEmit < 200) return;
    lastEmit = now;
    deps.onProgress?.({
      phase,
      componentId: req.componentId,
      file: fileName,
      received,
      total: req.bytes,
      bps,
      etaMs: req.bytes && bps > 0 ? Math.max(0, Math.round(((req.bytes - received) / bps) * 1000)) : null,
      overallReceived: overallBase + received,
      overallTotal,
      ...extra,
    });
  };

  emit('connecting', {}, true);

  const urls = [req.url, ...(req.mirrors ?? [])].filter((u, i, all) => u && all.indexOf(u) === i);
  let lastError: Error | null = null;

  for (let round = 0; round < 3; round++) {
    if (deps.signal?.aborted) {
      emit('paused', {}, true);
      throw new DownloadPausedError();
    }
    for (const url of urls) {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await attemptDownload(url, {
            req,
            part,
            idleTimeoutMs,
            fetchImpl,
            signal: deps.signal,
            log: deps.log,
            emit: (phase, extra) => emit(phase, extra, phase !== 'downloading'),
            onBytes: (got) => {
              received = got;
              const now = Date.now();
              if (now - windowStart >= 500) {
                const inst = (got - windowBytes) / ((now - windowStart) / 1000);
                bps = bps > 0 ? bps * 0.6 + inst * 0.4 : inst;
                windowStart = now;
                windowBytes = got;
              }
              emit('downloading');
            },
          });
          emit('done', {}, true);
          return;
        } catch (e) {
          if (e instanceof DownloadPausedError || deps.signal?.aborted) {
            emit('paused', {}, true);
            throw new DownloadPausedError();
          }
          lastError = e as Error;
          deps.log?.(`下载失败 ${url}（第 ${attempt + 1} 次）：${lastError.message}`);
          // 同一 URL 立刻重试一次只对断流有意义；间隔一下避免打到限流
          if (attempt === 0) await sleep(800);
        }
      }
    }
    if (round < 2) await sleep(1500);
  }

  emit('error', { message: lastError?.message }, true);
  throw new Error(
    `下载失败：${lastError?.message ?? '未知错误'}\n可以检查网络/代理，或改用离线导入。`
  );
}

interface AttemptCtx {
  req: DownloadRequest;
  part: string;
  idleTimeoutMs: number;
  fetchImpl: FetchLike;
  signal?: AbortSignal;
  log?: (line: string) => void;
  emit: (phase: DownloadPhase, extra?: Partial<DownloadProgress>) => void;
  onBytes: (received: number) => void;
}

async function attemptDownload(url: string, ctx: AttemptCtx): Promise<void> {
  const { req, part } = ctx;
  await fsp.mkdir(path.dirname(req.dest), { recursive: true });

  let have = sizeOf(part);
  if (req.bytes > 0 && have > req.bytes) {
    await fsp.rm(part, { force: true });
    have = 0;
  }
  if (req.bytes > 0 && have === req.bytes) {
    await finish(part, req, ctx);
    return;
  }

  const ctrl = new AbortController();
  let idleTimer: NodeJS.Timeout | null = null;
  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => ctrl.abort(), ctx.idleTimeoutMs);
  };
  const onOuterAbort = () => ctrl.abort();
  ctx.signal?.addEventListener('abort', onOuterAbort, { once: true });

  const cleanup = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
    ctx.signal?.removeEventListener('abort', onOuterAbort);
  };

  let stream: fs.WriteStream | null = null;
  let writeError: Error | null = null;
  try {
    armIdle();
    const headers: Record<string, string> = {};
    if (have > 0) headers.Range = `bytes=${have}-`;

    ctx.log?.(`GET ${url}${have > 0 ? `（续传自 ${prettyBytes(have)}）` : ''}`);
    const res = await ctx.fetchImpl(url, {
      headers,
      redirect: 'follow',
      signal: ctrl.signal,
      cache: 'no-store',
    });

    if (res.status === 416 && req.bytes > 0 && have === req.bytes) {
      await finish(part, req, ctx);
      return;
    }
    if (res.status !== 200 && res.status !== 206) {
      throw new Error(`HTTP ${res.status} ${res.statusText || ''}`.trim());
    }
    if (!res.body) throw new Error('响应没有 body');

    if (res.status === 200) have = 0;
    const lengthHeader = Number(res.headers.get('content-length') ?? 0);
    const total = req.bytes || (lengthHeader > 0 ? lengthHeader + have : 0);

    stream = fs.createWriteStream(part, { flags: have > 0 ? 'a' : 'w' });
    // 写失败的权威通道是 write 回调；这里只兜住 'error' 事件，避免它变成未捕获异常
    stream.on('error', (err) => {
      writeError = err;
    });
    const reader = res.body.getReader();
    let got = have;
    ctx.onBytes(got);

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      armIdle();
      await new Promise<void>((resolve, reject) => {
        stream!.write(Buffer.from(value), (err) => (err ? reject(err) : resolve()));
      });
      got += value.length;
      ctx.onBytes(got);
    }

    await new Promise<void>((resolve, reject) => {
      stream!.end((err?: Error | null) => (err ? reject(err) : resolve()));
    });
    stream = null;

    if (total > 0 && got < total) {
      throw new Error(`连接提前结束（${prettyBytes(got)} / ${prettyBytes(total)}）`);
    }
    if (req.bytes > 0 && got > req.bytes) {
      await fsp.rm(part, { force: true });
      throw new Error(`下载字节数超出预期（${got} > ${req.bytes}）`);
    }

    await finish(part, req, ctx);
  } catch (e) {
    if (stream) {
      stream.destroy();
      stream = null;
    }
    if (ctx.signal?.aborted) throw new DownloadPausedError();
    throw writeError ?? e;
  } finally {
    cleanup();
  }
}

async function finish(part: string, req: DownloadRequest, ctx: AttemptCtx): Promise<void> {
  ctx.emit('verifying');
  const checked = await verifyFile(part, { bytes: req.bytes, sha256: req.sha256 });
  if (!checked.ok) {
    // 坏包留着只会让下一次续传接着坏，删掉重下
    await fsp.rm(part, { force: true });
    const reason =
      checked.reason === 'size'
        ? `大小不符（${checked.bytes} / ${req.bytes} 字节）`
        : `sha256 不符（${checked.sha256?.slice(0, 16)}…）`;
    throw new Error(`${path.basename(req.dest)} 校验失败：${reason}`);
  }

  // rename 前落盘，避免断电后得到一个「大小对但内容空」的文件
  try {
    const fh = await fsp.open(part, 'r+');
    try {
      await fh.sync();
    } finally {
      await fh.close();
    }
  } catch {
    /* 某些文件系统不支持，忽略 */
  }

  await fsp.rm(req.dest, { force: true });
  await fsp.rename(part, req.dest);
  ctx.log?.(`完成 ${path.basename(req.dest)}（${prettyBytes(checked.bytes)}）`);
}

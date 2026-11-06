/**
 * llama.cpp `llama-server` sidecar 管理 + /v1/chat/completions 封装。
 *
 * 参数全部来自 docs/CAPABILITY.md 的实测结论：
 *   - `--image-min-tokens 256`：不强行放大小图（我们不做 grounding，无需 1024 下限）
 *   - `--image-max-tokens`     ：唯一显著的性能旋钮，prefill 超线性（§1.2）
 *   - `-c ctxPerSlot * parallel`：单页最坏 10745 token，故每槽 12288（§3.4）
 *   - temperature=0, seed=42   ：实测 5 次两两一致率 100%（§3.3）
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';

export interface ServerOptions {
  port: number;
  /** 图像 token 上限，决定 prefill 成本（capability.json 的 quality_presets） */
  imageMaxTokens: number;
  /** 并发槽数 */
  parallel: number;
  /** 每槽上下文 */
  ctxPerSlot: number;
  threads: number;
  device: string;
  gpuLayers: number;
  host?: string;
  /** 日志文件路径（默认 /tmp 下按端口区分） */
  logPath?: string;
}

export const DEFAULT_SERVER: Omit<ServerOptions, 'port'> = {
  imageMaxTokens: 2560,
  parallel: 1,
  ctxPerSlot: 12288,
  threads: 4,
  device: 'Vulkan0',
  gpuLayers: 99,
};

export interface Paths {
  root: string;
  serverExe: string;
  model: string;
  mmproj: string;
}

/** 桌面端把运行时解析结果（env / userData / 内置 / 旧版目录）传进来 */
export interface PathOverrides {
  root?: string;
  serverExe?: string;
  model?: string;
  mmproj?: string;
}

export function resolvePaths(root: string, overrides?: PathOverrides): Paths {
  const binDir = path.join(root, 'resources', 'llama', 'bin');
  const modelsDir = path.join(root, 'resources', 'models');
  const serverExe = path.join(binDir, 'llama-server.exe');
  const serverExeUnix = path.join(binDir, 'llama-server');
  const exe = fs.existsSync(serverExe) ? serverExe : serverExeUnix;
  const model = path.join(modelsDir, 'Xiaomi-OCR-0.Q4_K_M.gguf');
  const mmproj = path.join(modelsDir, 'Xiaomi-OCR-0.mmproj-bf16.gguf');
  if (!overrides) return { root, serverExe: exe, model, mmproj };
  return {
    root: overrides.root ?? root,
    serverExe: overrides.serverExe ?? exe,
    model: overrides.model ?? model,
    mmproj: overrides.mmproj ?? mmproj,
  };
}

export function validatePaths(p: Paths): string[] {
  const missing: string[] = [];
  if (!fs.existsSync(p.serverExe)) missing.push(p.serverExe);
  if (!fs.existsSync(p.model)) missing.push(p.model);
  if (!fs.existsSync(p.mmproj)) missing.push(p.mmproj);
  return missing;
}

/**
 * 运行时资产不全。桌面端靠 code + missing 决定弹「运行时就绪向导」而不是普通报错。
 */
export class RuntimeMissingError extends Error {
  readonly code = 'RUNTIME_MISSING';
  readonly missing: string[];

  constructor(missing: string[]) {
    super(
      `缺少运行时资产：\n  ${missing.join('\n  ')}\n` +
        `在应用内「设置 → 运行时与模型」下载，或把文件放到模型目录后重试。`
    );
    this.name = 'RuntimeMissingError';
    this.missing = missing;
  }
}

export function serverArgs(p: Paths, o: ServerOptions): string[] {
  const host = o.host ?? '127.0.0.1';
  return [
    '-m', p.model,
    '--mmproj', p.mmproj,
    '-ngl', String(o.gpuLayers),
    '-dev', o.device,
    '-c', String(o.ctxPerSlot * o.parallel),
    '-np', String(o.parallel),
    '-t', String(o.threads),
    '--image-min-tokens', '256',
    '--image-max-tokens', String(o.imageMaxTokens),
    '--host', host,
    '--port', String(o.port),
    '--no-warmup',
  ];
}

function httpJson<T>(url: string, init?: { method?: string; body?: unknown; timeoutMs?: number }): Promise<T> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = init?.body === undefined ? undefined : JSON.stringify(init.body);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: init?.method ?? 'GET',
        headers: payload
          ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
          : undefined,
        timeout: init?.timeoutMs ?? 600_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          if ((res.statusCode ?? 500) >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 500)}`));
            return;
          }
          try {
            resolve(JSON.parse(body) as T);
          } catch {
            reject(new Error(`非 JSON 响应: ${body.slice(0, 300)}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error(`请求超时 ${init?.timeoutMs ?? 600_000}ms`));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

export async function isHealthy(baseUrl: string, timeoutMs = 1500): Promise<boolean> {
  try {
    const r = await httpJson<{ status?: string }>(`${baseUrl}/health`, { timeoutMs });
    return r.status === 'ok';
  } catch {
    return false;
  }
}

export interface RunningServer {
  baseUrl: string;
  port: number;
  options: ServerOptions;
  child: ChildProcess;
  logPath: string;
  /** 启动时的仓库根，用于清理 pid 记录 */
  root: string;
  /** pid 记录的实际落点（装机后安装目录只读） */
  stateDir?: string;
}

/**
 * sidecar 身份记录。放在 resources/models 下（而不是 tmp），这样即使本进程
 * 被强杀、下次从不同 cwd 启动，也能认出「端口上那个 llama-server 是我们上次留下的」。
 */
export interface SidecarRecord {
  pid: number;
  port: number;
  imageMaxTokens: number;
  ctxPerSlot: number;
  startedAt: string;
}

/**
 * 记录默认放仓库的 resources/models，但装机后安装目录在 Program Files 下是只读的，
 * 桌面端会传 stateDir（userData 下的目录）。
 */
export function sidecarRecordPath(root: string, stateDir?: string): string {
  return path.join(stateDir ?? path.join(root, 'resources', 'models'), '.sidecar.json');
}

export function readSidecarRecord(root: string, stateDir?: string): SidecarRecord | null {
  try {
    const raw = fs.readFileSync(sidecarRecordPath(root, stateDir), 'utf8');
    const rec = JSON.parse(raw) as SidecarRecord;
    return typeof rec.pid === 'number' && typeof rec.port === 'number' ? rec : null;
  } catch {
    return null;
  }
}

export function writeSidecarRecord(root: string, rec: SidecarRecord, stateDir?: string): void {
  try {
    fs.mkdirSync(stateDir ?? path.join(root, 'resources', 'models'), { recursive: true });
    fs.writeFileSync(sidecarRecordPath(root, stateDir), JSON.stringify(rec, null, 2), 'utf8');
  } catch {
    /* 记录失败不影响推理 */
  }
}

export function clearSidecarRecord(root: string, stateDir?: string): void {
  try {
    fs.unlinkSync(sidecarRecordPath(root, stateDir));
  } catch {
    /* 本来就没有 */
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM = 进程存在但没权限发信号，仍算活着
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * 处理上一次异常退出留下的 sidecar。
 * 只在本仓库写的 pid 记录与端口都对得上时才杀 —— 别人的服务一律不动，
 * 交给调用方报错（避免"静默复用错配置"，见 docs/M1.md §5）。
 */
export async function reclaimStaleSidecar(
  root: string,
  port: number,
  stateDir?: string
): Promise<'none' | 'reclaimed' | 'foreign'> {
  const baseUrl = `http://127.0.0.1:${port}`;
  if (!(await isHealthy(baseUrl))) return 'none';

  const rec = readSidecarRecord(root, stateDir);
  if (!rec || rec.port !== port || !isProcessAlive(rec.pid)) return 'foreign';

  try {
    process.kill(rec.pid);
  } catch {
    return 'foreign';
  }
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (!(await isHealthy(baseUrl, 400))) {
      clearSidecarRecord(root, stateDir);
      return 'reclaimed';
    }
  }
  return 'foreign';
}

async function waitForHealth(baseUrl: string, timeoutMs: number, onTick?: (s: number) => void): Promise<void> {
  const started = Date.now();
  let last = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await isHealthy(baseUrl, 1500)) return;
    if (onTick && Date.now() - last > 5000) {
      last = Date.now();
      onTick(Math.round((Date.now() - started) / 1000));
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`服务在 ${timeoutMs}ms 内未就绪`);
}

export interface StartOptions extends Partial<Omit<ServerOptions, 'port'>> {
  port: number;
  /** 端口上已有服务时报错而不是复用 —— 复用会让配置静默不匹配 */
  refuseIfBusy?: boolean;
  timeoutMs?: number;
  onLog?: (line: string) => void;
  /** .sidecar.json 的落点；装机后安装目录只读，桌面端传 userData */
  stateDir?: string;
  /** 运行时资产位置；省略则用 <root>/resources/{llama,models} */
  assets?: PathOverrides;
}

/**
 * 启动一个受本进程管理的 sidecar。生命周期与调用方绑定：用完必须 stopServer，
 * 否则 llama-server 会作为孤儿进程留在系统里。
 */
export async function startServer(root: string, opts: StartOptions): Promise<RunningServer> {
  const paths = resolvePaths(root, opts.assets);
  const missing = validatePaths(paths);
  if (missing.length) {
    throw new RuntimeMissingError(missing);
  }

  const options: ServerOptions = { ...DEFAULT_SERVER, ...opts, port: opts.port };
  const host = options.host ?? '127.0.0.1';
  const baseUrl = `http://${host}:${options.port}`;
  const logPath = options.logPath ?? path.join(process.env.TEMP ?? '/tmp', `moocr-server-${options.port}.log`);

  if (opts.refuseIfBusy !== false) {
    const reclaim = await reclaimStaleSidecar(root, options.port, options.stateDir);
    if (reclaim === 'foreign') {
      throw new Error(
        `端口 ${options.port} 已被另一个 llama-server 占用（能响应 /health，但不是本目录启动的）。\n` +
          `常见原因：桌面版 moocr 正在运行，它把 pid 记录写在用户数据目录，命令行看不到。\n` +
          `  复用：--attach ${baseUrl}\n` +
          `  或换端口：--port 8091`
      );
    }
  }

  const args = serverArgs(paths, options);
  const logFd = fs.openSync(logPath, 'w');
  const child = spawn(paths.serverExe, args, {
    cwd: path.dirname(paths.serverExe),
    stdio: ['ignore', logFd, logFd],
    windowsHide: true,
  });
  child.on('error', (e) => {
    console.error(`[inference] 启动失败: ${e.message}`);
  });

  try {
    await waitForHealth(baseUrl, opts.timeoutMs ?? 180_000, (s) =>
      opts.onLog?.(`等待模型加载... ${s}s`)
    );
  } catch (e) {
    child.kill();
    const tail = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').slice(-2000) : '';
    throw new Error(`${(e as Error).message}\n--- 服务日志尾部 ---\n${tail}`);
  } finally {
    fs.closeSync(logFd);
  }

  const srv: RunningServer = { baseUrl, port: options.port, options, child, logPath, root, stateDir: options.stateDir };
  writeSidecarRecord(
    root,
    {
      pid: child.pid ?? -1,
      port: options.port,
      imageMaxTokens: options.imageMaxTokens,
      ctxPerSlot: options.ctxPerSlot,
      startedAt: new Date().toISOString(),
    },
    options.stateDir
  );
  return srv;
}

export async function stopServer(srv: RunningServer): Promise<void> {
  const child = srv.child;
  await new Promise<void>((resolve) => {
    if (child.exitCode !== null) {
      resolve();
      return;
    }
    child.once('exit', () => resolve());
    child.kill();
    setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* 已退出 */
      }
      resolve();
    }, 5000);
  });
  clearSidecarRecord(srv.root, srv.stateDir);
}

// ---------------------------------------------------------------- 推理请求

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
};

export function imageMime(filePath: string): string {
  return MIME[path.extname(filePath).toLowerCase()] ?? 'image/png';
}

export async function imageDataUri(filePath: string): Promise<string> {
  const buf = await fsp.readFile(filePath);
  return `data:${imageMime(filePath)};base64,${buf.toString('base64')}`;
}

/** llama.cpp 返回的 timings 字段（缺失时全部为 null） */
export interface RawTimings {
  prompt_n?: number;
  prompt_ms?: number;
  predicted_n?: number;
  predicted_ms?: number;
  /**
   * 命中 KV 前缀缓存的 token 数。同图同 prompt 复跑时 prompt_n 只剩增量，
   * 直接用 prompt_n 当输入量会显示成个位数（实测 305 → 4）。
   */
  cache_n?: number;
}

export interface CompletionRequest {
  baseUrl: string;
  prompt: string;
  imageUri: string;
  maxTokens: number;
  temperature?: number;
  seed?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface CompletionResponse {
  text: string;
  finishReason: string;
  timings: {
    /** 完整 prompt 长度（含缓存命中部分） */
    promptTokens: number | null;
    /** 其中命中前缀缓存、未真正计算的部分 */
    cachedTokens: number | null;
    promptMs: number | null;
    predictedTokens: number | null;
    predictedMs: number | null;
    wallMs: number;
    /** 仅在全量 prefill（无缓存命中）时有意义，否则为 null */
    prefillTps: number | null;
    decodeTps: number | null;
  };
}

interface ChatCompletionJson {
  choices?: { message?: { content?: string }; finish_reason?: string }[];
  timings?: RawTimings;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
  error?: { message?: string };
}

export async function complete(req: CompletionRequest): Promise<CompletionResponse> {
  const body = {
    model: 'xiaomi-ocr-0',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: req.prompt },
          { type: 'image_url', image_url: { url: req.imageUri } },
        ],
      },
    ],
    max_tokens: req.maxTokens,
    temperature: req.temperature ?? 0,
    seed: req.seed ?? 42,
    stream: false,
  };

  const t0 = Date.now();
  const json = await httpJson<ChatCompletionJson>(`${req.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    body,
    timeoutMs: req.timeoutMs ?? 900_000,
  });
  const wallMs = Date.now() - t0;

  if (json.error?.message) throw new Error(`推理失败: ${json.error.message}`);

  const choice = json.choices?.[0];
  const t = json.timings ?? {};
  const cached = json.usage?.prompt_tokens_details?.cached_tokens ?? t.cache_n ?? 0;
  const promptTokens = json.usage?.prompt_tokens ?? (t.prompt_n !== undefined ? t.prompt_n + cached : null);
  // 有缓存命中时 prompt_ms 只覆盖增量，tok/s 会失真，宁可给 null 也不给错数
  const prefillTps = cached === 0 && t.prompt_n && t.prompt_ms ? (t.prompt_n / t.prompt_ms) * 1000 : null;
  const decodeTps = t.predicted_n && t.predicted_ms ? (t.predicted_n / t.predicted_ms) * 1000 : null;

  return {
    text: choice?.message?.content ?? '',
    finishReason: choice?.finish_reason ?? 'unknown',
    timings: {
      promptTokens,
      cachedTokens: cached || null,
      promptMs: t.prompt_ms ?? null,
      predictedTokens: t.predicted_n ?? json.usage?.completion_tokens ?? null,
      predictedMs: t.predicted_ms ?? null,
      wallMs,
      prefillTps,
      decodeTps,
    },
  };
}

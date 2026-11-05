#!/usr/bin/env node
/**
 * moocr CLI —— M1 的可执行入口。
 *
 *   node packages/cli/src/main.ts fixtures/qianziwen.jpeg --out -
 *   node packages/cli/src/main.ts fixtures/ --task document --out out/
 *   node packages/cli/src/main.ts page.png --preset accurate --json
 *   node packages/cli/src/main.ts page.png --attach http://127.0.0.1:8090
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { runBatch, PROMPTS, DEFAULT_MAX_TOKENS, type TaskKind } from '../../core/src/pipeline.ts';
import { startServer, stopServer, resolvePaths, isHealthy } from '../../inference/src/server.ts';

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tif', '.tiff']);

/** capability.json 的 quality_presets：图像 token 上限 → prefill 成本（§1.2） */
const PRESETS: Record<string, number> = {
  fast: 1024,
  standard: 2560,
  accurate: 6144,
  extreme: 12288,
};

interface Args {
  inputs: string[];
  task: TaskKind;
  preset: string;
  maxTokens: number | null;
  out: string | null;
  json: boolean;
  attach: string | null;
  parallel: number;
  port: number;
  quiet: boolean;
}

function usage(): string {
  return `墨客 moocr —— Xiaomi-OCR-0 本地 OCR

用法: moocr <文件或目录...> [选项]

选项:
  --task <document|text|table|formula>  识别任务，默认 document
  --preset <fast|standard|accurate|extreme>
                                        图像 token 预算，默认 standard
                                        fast 1024 / standard 2560 / accurate 6144 / extreme 12288
  --max-tokens <n>                      输出 token 上限，默认按任务
  --out <路径|->                        输出目录，或 - 表示打印到标准输出
  --json                                同时输出结构化 JSON
  --attach <url>                        复用已在运行的服务，不自己启动
  --parallel <n>                        并发页数 / 服务槽数，默认 1
  --port <n>                            服务端口，默认 8090
  --quiet                               不打印进度
  -h, --help
`;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    inputs: [],
    task: 'document',
    preset: 'standard',
    maxTokens: null,
    out: null,
    json: false,
    attach: null,
    parallel: 1,
    port: 8090,
    quiet: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${k} 缺少参数值`);
      return v;
    };
    switch (k) {
      case '-h':
      case '--help':
        process.stdout.write(usage());
        process.exit(0);
        break;
      case '--task': {
        const t = val();
        if (!['document', 'text', 'table', 'formula'].includes(t)) throw new Error(`未知任务: ${t}`);
        a.task = t as TaskKind;
        break;
      }
      case '--preset':
        a.preset = val();
        break;
      case '--max-tokens':
        a.maxTokens = Number(val());
        break;
      case '--out':
        a.out = val();
        break;
      case '--json':
        a.json = true;
        break;
      case '--attach':
        a.attach = val();
        break;
      case '--parallel':
        a.parallel = Math.max(1, Number(val()));
        break;
      case '--port':
        a.port = Number(val());
        break;
      case '--quiet':
        a.quiet = true;
        break;
      default:
        if (k.startsWith('-')) throw new Error(`未知选项: ${k}`);
        a.inputs.push(k);
    }
  }
  if (a.inputs.length === 0) throw new Error('至少需要一个输入文件或目录');
  if (!(a.preset in PRESETS)) throw new Error(`未知预设: ${a.preset}（可选 ${Object.keys(PRESETS).join('/')}）`);
  return a;
}

/** 从 cwd 向上找到含 resources/models 的项目根 */
function findRoot(start: string): string {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, 'resources', 'models'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('找不到项目根（缺少 resources/models），请在仓库内运行');
    dir = parent;
  }
}

function collectImages(input: string, acc: string[]): void {
  const st = fs.statSync(input);
  if (st.isDirectory()) {
    for (const ent of fs.readdirSync(input, { withFileTypes: true })) {
      if (ent.name.startsWith('.')) continue;
      collectImages(path.join(input, ent.name), acc);
    }
    return;
  }
  if (IMAGE_EXT.has(path.extname(input).toLowerCase())) acc.push(input);
}

function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
}

function fmtNum(n: number | null, digits = 1): string {
  return n === null ? '-' : n.toFixed(digits);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const root = findRoot(process.cwd());

  const files: string[] = [];
  for (const input of args.inputs) collectImages(path.resolve(input), files);
  if (files.length === 0) throw new Error('输入中没有可识别的图片文件');

  const imageMaxTokens = PRESETS[args.preset];
  const maxTokens = args.maxTokens ?? DEFAULT_MAX_TOKENS[args.task];
  // 每槽上下文必须容得下图像 token + 输出，再留 512 余量
  const ctxPerSlot = Math.max(12288, imageMaxTokens + maxTokens + 512);

  const log = (s: string) => {
    if (!args.quiet) process.stderr.write(`${s}\n`);
  };

  let baseUrl = args.attach;
  let srv: Awaited<ReturnType<typeof startServer>> | null = null;

  if (baseUrl) {
    if (!(await isHealthy(baseUrl))) throw new Error(`--attach 的服务不可用: ${baseUrl}`);
    log(`复用服务 ${baseUrl}`);
  } else {
    log(`启动服务：preset=${args.preset}（image-max-tokens=${imageMaxTokens}）parallel=${args.parallel}`);
    srv = await startServer(root, {
      port: args.port,
      imageMaxTokens,
      parallel: args.parallel,
      ctxPerSlot,
      onLog: (m) => log(m),
    });
    baseUrl = srv.baseUrl;
    log(`服务就绪 ${baseUrl}（日志 ${srv.logPath}）`);
  }

  const outDir =
    args.out && args.out !== '-' ? path.resolve(args.out) : args.out === '-' ? null : path.resolve('out');
  if (outDir) fs.mkdirSync(outDir, { recursive: true });

  const t0 = Date.now();
  let done = 0;
  const results = await runBatch(
    files.map((file) => ({ file, baseUrl: baseUrl as string, task: args.task, maxTokens })),
    args.parallel,
    (r, i) => {
      done++;
      const name = path.basename(r.file);
      if ('error' in r) {
        log(`[${done}/${files.length}] ${name} 失败: ${r.error}`);
      } else {
        log(
          `[${done}/${files.length}] ${name} ${fmtMs(r.timings.wallMs)} ` +
            `${r.summary.chars} 字 ${r.summary.tables} 表` +
            (r.warnings.length ? ` ⚠ ${r.warnings.join('; ')}` : '')
        );
      }
      void i;
    }
  );
  const totalMs = Date.now() - t0;

  // 落盘
  for (const r of results) {
    if ('error' in r) continue;
    const base = path.basename(r.file, path.extname(r.file));
    const dir = outDir ?? path.dirname(path.resolve(r.file));
    if (args.out === '-') {
      process.stdout.write(
        files.length > 1 ? `\n===== ${path.basename(r.file)} =====\n${r.markdown}\n` : `${r.markdown}\n`
      );
    } else {
      await fsp.writeFile(path.join(dir, `${base}.md`), r.markdown, 'utf8');
    }
    if (args.json) {
      const meta = {
        file: r.file,
        task: r.task,
        chars: r.summary.chars,
        tables: r.summary.tables,
        latexBlocks: r.summary.latexBlocks,
        finishReason: r.finishReason,
        degenerated: r.degenerated,
        warnings: r.warnings,
        timings: r.timings,
        attempts: r.attempts,
      };
      if (args.out === '-') process.stderr.write(`${JSON.stringify(meta)}\n`);
      else await fsp.writeFile(path.join(dir, `${base}.json`), JSON.stringify(meta, null, 2), 'utf8');
    }
  }

  const ok = results.filter((r) => !('error' in r));
  const failed = results.length - ok.length;
  const sumWall = ok.reduce((s, r) => s + (r as Exclude<typeof r, { error: string }>).timings.wallMs, 0);
  log(
    `完成 ${ok.length}/${results.length} 页，总耗时 ${fmtMs(totalMs)}，` +
      `单页均值 ${fmtMs(ok.length ? sumWall / ok.length : 0)}` +
      (failed ? `，失败 ${failed}` : '')
  );

  if (srv) await stopServer(srv);

  if (failed > 0) process.exitCode = 1;
}

main().catch((e) => {
  process.stderr.write(`错误: ${(e as Error).message}\n`);
  process.exit(1);
});

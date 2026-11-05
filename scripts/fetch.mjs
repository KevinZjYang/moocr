/**
 * 拉取运行时资产：llama.cpp（Vulkan）、Xiaomi-OCR-0 GGUF、示例图。
 *
 *   npm run fetch          # 缺什么下什么，已完整则跳过
 *   npm run fetch -- --force
 *
 * 跨平台，只用 Node 内置模块。断点续传 + 大小校验 + 停顿重试 —— HF 的连接
 * 会静默断流，不带停顿检测会挂在那里不动（M0 时踩过）。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

const ROOT = process.cwd();
const FORCE = process.argv.includes('--force');

const MODEL_BASE = 'https://huggingface.co/prithivMLmods/Xiaomi-OCR-0-GGUF/resolve/main';
const PIC_BASE = 'https://huggingface.co/xiaomi-research/Xiaomi-OCR-0/resolve/main/example_pics';
const LLAMA_RELEASE = 'https://github.com/ggml-org/llama.cpp/releases/download/b12110';

/** 这个版本对应 llama.cpp nightly b12110；升级时同步改文件名前缀 */
const PLATFORM_ARCHIVES = {
  'win32-x64': 'llama-b12110-bin-win-vulkan-x64.zip',
  'linux-x64': 'llama-b12110-bin-ubuntu-vulkan-x64.zip',
};

const FILES = [
  {
    url: `${MODEL_BASE}/Xiaomi-OCR-0.Q4_K_M.gguf`,
    dest: 'resources/models/Xiaomi-OCR-0.Q4_K_M.gguf',
    size: 529_297_664,
    label: 'Xiaomi-OCR-0 Q4_K_M',
  },
  {
    url: `${MODEL_BASE}/Xiaomi-OCR-0.mmproj-bf16.gguf`,
    dest: 'resources/models/Xiaomi-OCR-0.mmproj-bf16.gguf',
    size: 207_346_624,
    label: '视觉编码器 mmproj',
  },
];

const SAMPLES = [
  'qianziwen.jpeg', 'qianziwen.md',
  'dense-equations.jpg', 'dense-equations.md',
  'handwrite-formula.jpg', 'handwrite-formula.md',
  'receipt.jpg', 'receipt.md',
];

const mb = (n) => (n / 1024 / 1024).toFixed(1) + ' MB';

async function sizeOf(p) {
  try {
    return (await fsp.stat(p)).size;
  } catch {
    return 0;
  }
}

/** 简单进度：每 500 ms 打一行，终端里能看到在动 */
function progressPrinter(label) {
  let last = 0;
  const t0 = Date.now();
  return (got, total) => {
    const now = Date.now();
    if (now - last < 500 && got !== total) return;
    last = now;
    const pct = total ? ((got / total) * 100).toFixed(1) + '%' : '';
    const speed = got / ((now - t0) / 1000 || 1);
    process.stdout.write(`\r    ${label}  ${mb(got)}${total ? ` / ${mb(total)}` : ''}  ${pct}  ${mb(speed)}/s   `);
  };
}

/** 带续传的单文件下载：最多 8 次，30 秒内低于 20 KB/s 视为断流 */
async function download(url, dest, expectedSize) {
  await fsp.mkdir(path.dirname(dest), { recursive: true });

  for (let attempt = 1; attempt <= 8; attempt++) {
    let have = await sizeOf(dest);
    if (expectedSize > 0 && have >= expectedSize) return;
    if (attempt > 1) await new Promise((r) => setTimeout(r, 1500));

    const headers = {};
    if (have > 0) headers.Range = `bytes=${have}-`;

    const ctrl = new AbortController();
    let idleTimer;
    const armIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => ctrl.abort(), 30_000);
    };

    try {
      armIdle();
      const res = await fetch(url, { headers, signal: ctrl.signal, redirect: 'follow' });

      if (res.status === 416) return; // 已经完整
      if (res.status !== 200 && res.status !== 206) throw new Error(`HTTP ${res.status}`);

      if (res.status === 200) have = 0; // 服务器不支持续传，从头写
      const total = expectedSize || Number(res.headers.get('content-length') || 0);
      const tick = progressPrinter(path.basename(dest));
      let got = have;

      const out = fs.createWriteStream(dest, { flags: have > 0 ? 'a' : 'w' });
      const body = Readable.fromWeb(res.body);
      body.on('data', (chunk) => {
        got += chunk.length;
        armIdle();
        tick(got, total);
      });
      await pipeline(body, out);
      clearTimeout(idleTimer);
      process.stdout.write('\n');

      const now = await sizeOf(dest);
      if (!total || now >= total) return;
      process.stdout.write(`    不完整 ${mb(now)} / ${mb(total)}，重试 ${attempt}/8\n`);
    } catch (e) {
      clearTimeout(idleTimer);
      process.stdout.write(`\n    中断（${e.message}），重试 ${attempt}/8\n`);
    }
  }

  const now = await sizeOf(dest);
  if (expectedSize > 0 && now < expectedSize) {
    throw new Error(`${dest} 只有 ${mb(now)}，期望 ${mb(expectedSize)}`);
  }
}

async function sha256(file) {
  const { createHash } = await import('node:crypto');
  const h = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) h.update(chunk);
  return h.digest('hex');
}

async function unzip(zip, dir) {
  await fsp.mkdir(dir, { recursive: true });
  if (process.platform === 'win32') {
    // Windows 自带 tar 可解 zip（bsdtar）
    await exec('tar', ['-xf', zip, '-C', dir]);
  } else {
    await exec('unzip', ['-o', '-q', zip, '-d', dir]);
  }
}

async function main() {
  const asset = PLATFORM_ARCHIVES[`${process.platform}-${process.arch}`];
  if (!asset) {
    console.log(`没有为 ${process.platform}-${process.arch} 准备的 llama.cpp 构建。`);
    console.log('请自行下载 Vulkan 版并放到 resources/llama/bin/，或改用 CPU 版；');
    console.log('模型文件仍会照常下载。');
  }

  console.log('\n[1/3] llama.cpp（Vulkan 推理后端）');
  if (asset) {
    const zip = 'resources/llama/llama-vulkan.zip';
    const binDir = 'resources/llama/bin';
    const serverName = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';
    const present = await sizeOf(path.join(binDir, serverName));
    if (present > 0 && !FORCE) {
      console.log('    已存在，跳过解压');
    } else {
      await download(`${LLAMA_RELEASE}/${asset}`, zip, 0);
      await unzip(zip, binDir);
      console.log(`    解压到 ${binDir}`);
    }
  }

  console.log('\n[2/3] 模型权重（约 700 MB）');
  for (const f of FILES) {
    const have = await sizeOf(f.dest);
    if (have >= f.size && !FORCE) {
      console.log(`    ${f.label}：已完整（${mb(have)}）`);
      continue;
    }
    console.log(`    ${f.label}：${have ? `续传自 ${mb(have)}` : '开始下载'}`);
    await download(f.url, f.dest, f.size);
    console.log(`    完成 ${mb(await sizeOf(f.dest))}`);
  }

  console.log('\n[3/3] 示例图片与参考输出');
  for (const name of SAMPLES) {
    const dest = path.join('fixtures', name);
    if ((await sizeOf(dest)) > 0 && !FORCE) continue;
    try {
      await download(`${PIC_BASE}/${name}`, dest, 0);
    } catch (e) {
      console.log(`    ${name} 失败：${e.message}（不影响使用）`);
    }
  }

  console.log('\n校验');
  for (const f of FILES) {
    const size = await sizeOf(f.dest);
    const digest = size ? (await sha256(f.dest)).slice(0, 16) : 'missing';
    console.log(`  ${path.basename(f.dest)}  ${mb(size)}  sha256:${digest}…`);
  }

  console.log('\n完成。运行 `npm start` 启动桌面应用，或 `npm run ocr -- 图片路径`。');
}

await main();

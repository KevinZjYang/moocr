/**
 * 拉取运行时资产：llama.cpp（Vulkan）、Xiaomi-OCR-0 GGUF、示例图。
 *
 *   npm run fetch             # 缺什么下什么，已完整则跳过
 *   npm run fetch -- --force
 *
 * URL / 大小 / sha256 全部来自 packages/runtime/runtime-manifest.json —— 应用内
 * 下载用的是同一份清单，避免「命令行能跑、装完却少文件」。
 * 跨平台，只用 Node 内置模块；断点续传 + 大小与哈希校验 + 停顿重试。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FORCE = process.argv.includes('--force');
const MANIFEST = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'packages/runtime/runtime-manifest.json'), 'utf8')
);

const PIC_BASE = 'https://huggingface.co/xiaomi-research/Xiaomi-OCR-0/resolve/main/example_pics';

const SAMPLES = [
  'qianziwen.jpeg', 'qianziwen.md',
  'dense-equations.jpg', 'dense-equations.md',
  'handwrite-formula.jpg', 'handwrite-formula.md',
  'receipt.jpg', 'receipt.md',
];

const mb = (n) => (n / 1024 / 1024).toFixed(1) + ' MB';
const rel = (p) => path.relative(ROOT, p) || '.';

async function sizeOf(p) {
  try {
    return (await fsp.stat(p)).size;
  } catch {
    return 0;
  }
}

async function sha256(file) {
  const h = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) h.update(chunk);
  return h.digest('hex');
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

/**
 * 带续传的下载：最多 8 次尝试，镜像轮流上，30 秒没数据视为断流。
 * 有 sha256 时在完整后核对，坏包删掉重来（否则续传会一直续在坏数据上）。
 */
async function download(urls, dest, expectedSize, expectedSha) {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const list = urls.filter(Boolean);

  for (let attempt = 1; attempt <= 8; attempt++) {
    const url = list[(attempt - 1) % list.length];
    let have = await sizeOf(dest);
    if (expectedSize > 0 && have === expectedSize) {
      if (!expectedSha || (await sha256(dest)) === expectedSha) return;
      await fsp.rm(dest, { force: true });
      have = 0;
    }
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

      if (res.status === 416) {
        // 本地 .part 比服务器认为的还长：要么已完整，要么是坏包
        const now = await sizeOf(dest);
        if (expectedSize > 0 && now === expectedSize && (!expectedSha || (await sha256(dest)) === expectedSha)) {
          return;
        }
        await fsp.rm(dest, { force: true });
        continue;
      }
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
      if (total && now < total) {
        process.stdout.write(`    不完整 ${mb(now)} / ${mb(total)}，重试 ${attempt}/8\n`);
        continue;
      }
      if (expectedSha) {
        const digest = await sha256(dest);
        if (digest !== expectedSha) {
          await fsp.rm(dest, { force: true });
          process.stdout.write(`    sha256 不符，删掉重下（${attempt}/8）\n`);
          continue;
        }
      }
      return;
    } catch (e) {
      clearTimeout(idleTimer);
      process.stdout.write(`\n    中断（${e.message}），重试 ${attempt}/8\n`);
    }
  }

  const now = await sizeOf(dest);
  if (expectedSize > 0 && now !== expectedSize) {
    throw new Error(`${rel(dest)} 只有 ${mb(now)}，期望 ${mb(expectedSize)}`);
  }
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

/** 压缩包内层可能带一级目录，找到 llama-server 所在目录后把内容平铺进 bin */
async function installLlamaBin(zip, binDir) {
  const tmp = path.join(ROOT, 'resources/llama/.extract');
  await fsp.rm(tmp, { recursive: true, force: true });
  await unzip(zip, tmp);

  const exeName = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';
  const entries = fs.readdirSync(tmp, { recursive: true, withFileTypes: false });
  const found = entries.find(
    (p) => typeof p === 'string' && path.basename(p) === exeName
  );
  if (!found) throw new Error(`压缩包里没有 ${exeName}`);

  const srcDir = path.dirname(path.join(tmp, found));
  await fsp.mkdir(binDir, { recursive: true });
  for (const name of await fsp.readdir(srcDir)) {
    await fsp.cp(path.join(srcDir, name), path.join(binDir, name), { recursive: true });
  }
  await fsp.rm(tmp, { recursive: true, force: true });
}

async function main() {
  const platformKey = `${process.platform}-${process.arch}`;
  const archive = MANIFEST.llama.archives[platformKey];

  console.log('\n[1/3] llama.cpp（Vulkan 推理后端）');
  if (!archive) {
    console.log(`    没有为 ${platformKey} 准备的 llama.cpp 构建。`);
    console.log('    请自行下载 Vulkan 版并放到 resources/llama/bin/；模型仍会照常下载。');
  } else {
    const binDir = path.join(ROOT, 'resources/llama/bin');
    const exeName = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';
    const present = await sizeOf(path.join(binDir, exeName));
    if (present > 0 && !FORCE) {
      console.log(`    已存在（${rel(binDir)}），跳过`);
    } else {
      const zip = path.join(
        ROOT,
        `resources/llama/llama-${MANIFEST.llama.version}-${platformKey}.zip`
      );
      console.log(`    下载 ${archive.url}`);
      await download([archive.url, ...(archive.mirrors ?? [])], zip, archive.bytes, archive.sha256);
      await installLlamaBin(zip, binDir);
      console.log(`    解压到 ${rel(binDir)}`);
    }
  }

  console.log('\n[2/3] 模型权重（约 700 MB）');
  for (const model of MANIFEST.models) {
    const dest = path.join(ROOT, 'resources/models', model.file);
    const have = await sizeOf(dest);
    if (have === model.bytes && !FORCE) {
      console.log(`    ${model.label ?? model.file}：已完整（${mb(have)}）`);
      continue;
    }
    console.log(`    ${model.label ?? model.file}：${have ? `续传自 ${mb(have)}` : '开始下载'}`);
    await download([model.url, ...(model.mirrors ?? [])], dest, model.bytes, model.sha256);
    console.log(`    完成 ${mb(await sizeOf(dest))}`);
  }

  console.log('\n[3/3] 示例图片与参考输出');
  for (const name of SAMPLES) {
    const dest = path.join(ROOT, 'fixtures', name);
    if ((await sizeOf(dest)) > 0 && !FORCE) continue;
    try {
      await download([`${PIC_BASE}/${name}`], dest, 0);
    } catch (e) {
      console.log(`    ${name} 失败：${e.message}（不影响使用）`);
    }
  }

  console.log('\n校验');
  let ok = true;
  for (const model of MANIFEST.models) {
    const dest = path.join(ROOT, 'resources/models', model.file);
    const size = await sizeOf(dest);
    const digest = size ? await sha256(dest) : 'missing';
    const pass = size === model.bytes && digest === model.sha256;
    if (!pass) ok = false;
    console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${model.file}  ${mb(size)}  sha256:${String(digest).slice(0, 16)}…`);
  }
  if (!ok) {
    console.error('\n有文件不完整，重跑 `npm run fetch` 会续传；网络不稳可多试几次。');
    process.exit(1);
  }

  console.log('\n完成。运行 `npm start` 启动桌面应用，或 `npm run ocr -- 图片路径`。');
}

await main();

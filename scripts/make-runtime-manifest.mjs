/**
 * 生成 / 校验运行时清单。
 *
 *   npm run runtime:manifest           # 从 resources/models/*.gguf 重算 size + sha256 并写回
 *   npm run runtime:manifest -- --check  # 只校验清单与本机文件是否一致（发布前必跑）
 *
 * 清单是唯一事实来源：应用内下载、scripts/fetch.mjs、打包前检查都读它，
 * 避免 URL / 大小 / 哈希散落在三处各改一遍。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = path.join(ROOT, 'packages/runtime/runtime-manifest.json');
const MODEL_DIR = path.join(ROOT, 'resources/models');
const CHECK = process.argv.includes('--check');

const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;

async function sha256(file) {
  const hash = crypto.createHash('sha256');
  let seen = 0;
  let last = 0;
  for await (const chunk of fs.createReadStream(file)) {
    hash.update(chunk);
    seen += chunk.length;
    const now = Date.now();
    if (now - last > 1000) {
      last = now;
      process.stdout.write(`\r    哈希 ${path.basename(file)}  ${mb(seen)}   `);
    }
  }
  if (seen > 0) process.stdout.write('\r');
  return hash.digest('hex');
}

async function main() {
  const manifest = JSON.parse(await fsp.readFile(MANIFEST, 'utf8'));
  if (!Array.isArray(manifest.models) || manifest.models.length === 0) {
    throw new Error('清单里没有 models 条目');
  }

  let total = 0;
  let drift = 0;
  const rows = [];

  for (const model of manifest.models) {
    const file = path.join(MODEL_DIR, model.file);
    if (!fs.existsSync(file)) {
      throw new Error(`缺少本地权重：${file}\n先执行 npm run fetch（或从其它机器拷入）。`);
    }
    const size = (await fsp.stat(file)).size;
    const digest = await sha256(file);

    const sizeOk = size === model.bytes;
    const hashOk = digest === model.sha256;
    if (!sizeOk || !hashOk) drift += 1;
    if (!CHECK) {
      model.bytes = size;
      model.sha256 = digest;
    }
    total += size;
    rows.push({
      file: model.file,
      size,
      sha: digest,
      sizeOk,
      hashOk,
    });
  }

  if (!CHECK) {
    manifest.totalBytes = total;
    await fsp.writeFile(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  }

  for (const r of rows) {
    const mark = CHECK ? (r.sizeOk && r.hashOk ? ' ok ' : ' 差异') : '写入';
    console.log(`${mark}  ${r.file}  ${mb(r.size)}  ${r.sha.slice(0, 16)}…`);
  }
  console.log(`\n合计 ${mb(total)}（${total} 字节）`);
  console.log(CHECK ? '清单与本机文件一致。' : `已更新 ${MANIFEST}`);

  if (CHECK && drift > 0) {
    console.error(`\n有 ${drift} 个文件与清单不符。跑一次 npm run runtime:manifest 重新生成。`);
    process.exit(1);
  }
}

await main();

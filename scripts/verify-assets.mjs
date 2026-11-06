/**
 * 打包前检查：清单合法、llama.cpp 二进制在位。
 *
 *   npm run verify:assets               # 基本检查（不要求本机有 700 MB 权重）
 *   npm run verify:assets -- --with-models   # 额外核对权重文件大小
 *
 * 之所以不默认要求权重：安装包本来就不含权重，CI / 干净检出也应该能构建。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST_PATH = path.join(ROOT, 'packages/runtime/runtime-manifest.json');
const WITH_MODELS = process.argv.includes('--with-models');

const errors = [];
const warnings = [];
const HEX64 = /^[a-f0-9]{64}$/;

function fail(msg) {
  errors.push(msg);
}

function main() {
  if (!fs.existsSync(MANIFEST_PATH)) {
    fail(`缺少运行时清单：${MANIFEST_PATH}`);
    return;
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  } catch (e) {
    fail(`清单不是合法 JSON：${e.message}`);
    return;
  }

  if (manifest.schemaVersion !== 1) fail(`schemaVersion 应为 1，实际 ${manifest.schemaVersion}`);
  if (!manifest.llama || !manifest.llama.archives) fail('清单缺少 llama.archives');

  const platformKey = `${process.platform}-${process.arch}`;
  const archive = manifest.llama?.archives?.[platformKey];
  if (!archive) {
    fail(`清单没有 ${platformKey} 的 llama.cpp 归档`);
  } else {
    if (!/^https:\/\//.test(archive.url ?? '')) fail('llama 归档 url 必须是 https');
    if (!(archive.bytes > 0)) fail('llama 归档 bytes 必须大于 0');
    if (!HEX64.test(archive.sha256 ?? '')) fail('llama 归档 sha256 非法');
    for (const m of archive.mirrors ?? []) {
      if (!/^https:\/\//.test(m)) fail(`llama 镜像不是 https：${m}`);
    }
  }

  if (!Array.isArray(manifest.models) || manifest.models.length === 0) {
    fail('manifest.models 为空');
  } else {
    const ids = new Set();
    const files = new Set();
    let sum = 0;
    for (const model of manifest.models) {
      if (!['model', 'mmproj'].includes(model.id)) fail(`未知模型 id：${model.id}`);
      if (ids.has(model.id)) fail(`模型 id 重复：${model.id}`);
      ids.add(model.id);
      if (!model.file || files.has(model.file)) fail(`模型文件名缺失或重复：${model.file}`);
      files.add(model.file);
      if (!(model.bytes > 0)) fail(`${model.file} 的 bytes 非法`);
      if (!HEX64.test(model.sha256 ?? '')) fail(`${model.file} 的 sha256 非法`);
      if (!/^https:\/\//.test(model.url ?? '')) fail(`${model.file} 的 url 必须是 https`);
      for (const m of model.mirrors ?? []) {
        if (!/^https:\/\//.test(m)) fail(`${model.file} 的镜像不是 https：${m}`);
      }
      sum += model.bytes ?? 0;
    }
    if (manifest.totalBytes !== sum) {
      fail(`totalBytes 应为 ${sum}，实际 ${manifest.totalBytes}`);
    }
  }

  if (manifest.license && !/^https:\/\//.test(manifest.license.url ?? '')) {
    fail('license.url 必须是 https');
  }

  const exe = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';
  const bin = path.join(ROOT, 'resources/llama/bin', exe);
  if (!fs.existsSync(bin)) {
    fail(`缺少 llama.cpp 运行时：${bin}\n先执行 npm run fetch，或手动放入。`);
  } else {
    // 新版 llama.cpp 把实现拆到 llama-server-impl.dll，只查 exe 不够
    if (process.platform === 'win32' && !fs.existsSync(path.join(ROOT, 'resources/llama/bin/llama-server-impl.dll'))) {
      warnings.push('resources/llama/bin 里没有 llama-server-impl.dll，安装包可能无法启动推理');
    }
  }

  if (WITH_MODELS && Array.isArray(manifest.models)) {
    for (const model of manifest.models) {
      const file = path.join(ROOT, 'resources/models', model.file);
      if (!fs.existsSync(file)) {
        fail(`缺少权重：${file}`);
        continue;
      }
      const size = fs.statSync(file).size;
      if (size !== model.bytes) fail(`${model.file} 大小 ${size}，清单是 ${model.bytes}`);
    }
  }
}

main();

for (const w of warnings) console.warn(`[warn] ${w}`);
if (errors.length > 0) {
  for (const e of errors) console.error(`[error] ${e}`);
  process.exit(1);
}
console.log(`运行时清单与二进制检查通过（${process.platform}-${process.arch}）。`);

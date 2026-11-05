// 把验证脚本里的硬编码绝对路径换成基于仓库根的相对路径
// 用法：node scripts/_relativize.mjs
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const FILES = [
  'scripts/m3-export-real.mjs',
  'scripts/m3-kie-check.mjs',
  'scripts/m4-cache-check.mjs',
  'scripts/m4-parallel-big.mjs',
  'scripts/m4-parallel-check.mjs',
  'scripts/m4-recover-check.mjs',
  'scripts/m5-export-e2e.mjs',
];

for (const rel of FILES) {
  const abs = path.join(ROOT, rel);
  let src = fs.readFileSync(abs, 'utf8');
  const before = src;

  // 字面量：'E:/Github/moocr/xxx' → path.join(ROOT, 'xxx')
  src = src.replace(/'E:\/Github\/moocr\/([^']*)'/g, (_, p) => `path.join(ROOT, '${p.replace(/\\/g, '/')}')`);
  // 双反斜杠写法：'E:\\\\Github\\\\moocr\\\\xxx'（源文件里是 E:\\Github\\moocr\\x）
  src = src.replace(/'E:\\\\\\\\Github\\\\\\\\moocr\\\\\\\\([^']*)'/g, (_, p) => `path.join(ROOT, '${p.replace(/\\\\\\\\/g, '/')}')`);
  src = src.replace(/"E:\\\\Github\\\\moocr\\\\([^"]*)"/g, (_, p) => `path.join(ROOT, '${p.replace(/\\\\/g, '/')}')`);

  if (src === before) {
    console.log(`skip  ${rel}`);
    continue;
  }

  // 确保有 path 与 ROOT
  if (!/^import path from 'node:path';/m.test(src)) {
    src = src.replace(/^(import .*from 'node:[a-z]+';)$/m, "$1\nimport path from 'node:path';");
    if (!/^import path from 'node:path';/m.test(src)) src = `import path from 'node:path';\n${src}`;
  }
  if (!/const ROOT = /.test(src)) {
    src = src.replace(/^(import .*;\n)+/m, (m) => `${m}\nconst ROOT = path.resolve(import.meta.dirname, '..');\n`);
  }

  fs.writeFileSync(abs, src);
  console.log(`done  ${rel}`);
}

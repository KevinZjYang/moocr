/**
 * 生产模式启动：先确保主进程/渲染进程都已构建，再拉起 Electron。
 *
 * 两个坑在这里一次性堵住：
 * 1. ELECTRON_RUN_AS_NODE —— 本机 shell 里是设着的，它让 electron.exe 退化成
 *    纯 Node，require('electron') 变成"返回二进制路径"，主进程 ipcMain 直接 undefined。
 * 2. 渲染进程没构建时窗口会白屏，所以 check 一下 dist/renderer/index.html。
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const electronBin = require('electron');
const root = fileRoot();

function fileRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

const mainBundle = path.join(root, 'apps', 'desktop', 'dist', 'main.cjs');
const rendererIndex = path.join(root, 'dist', 'renderer', 'index.html');

for (const [p, hint] of [
  [mainBundle, 'npm run build:main'],
  [rendererIndex, 'npm run build:renderer'],
]) {
  if (!fs.existsSync(p)) {
    console.error(`缺少构建产物 ${p}\n先执行: ${hint}`);
    process.exit(1);
  }
}

const localModel = path.join(root, 'resources', 'models', 'Xiaomi-OCR-0.Q4_K_M.gguf');
if (!fs.existsSync(localModel)) {
  // 不再拦死：应用内会弹「运行时就绪向导」，可以直接下载到 userData。
  console.warn('提示：本地还没有模型权重，应用启动后会引导一键下载（约 700 MB）。');
  console.warn('      也可以先跑 `npm run fetch` 预置到 resources/models。');
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

// --detach：脚本立刻返回，Electron 完全脱离当前终端/父进程存活。
// 不这样做的后果是父 shell 一收尾（比如在后台任务里跑 npm start），
// 进程组被一起清掉，窗口凭空消失。
const detach = process.argv.includes('--detach');
const args = process.argv.slice(2).filter((a) => a !== '--detach');

const child = spawn(electronBin, [mainBundle, ...args], {
  stdio: detach ? 'ignore' : 'inherit',
  cwd: root,
  env,
  detached: detach,
});

if (detach) {
  child.unref();
  console.log(`moocr 已启动 (pid ${child.pid})`);
  process.exit(0);
}

child.on('exit', (code) => process.exit(code ?? 0));

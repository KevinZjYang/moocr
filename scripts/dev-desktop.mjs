/**
 * 开发模式：起 Vite dev server，等它就绪，再拉起 Electron 主进程。
 * 不做热重启 —— 改主进程代码需要重新运行本脚本（渲染进程有 HMR）。
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const electronBin = require('electron');

/**
 * 必须删掉 ELECTRON_RUN_AS_NODE：它让 electron.exe 退化成纯 Node，
 * require('electron') 会返回二进制路径字符串而不是内置模块，
 * 主进程里 ipcMain 就成了 undefined（本机 shell 里这个变量是设着的）。
 */
function electronEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

// 直接用 node 跑 vite.js，避免 Windows 上 spawn .cmd 需要 shell:true 的坑
const viteBin = fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url));
const vite = spawn(process.execPath, [viteBin], { stdio: 'inherit', env: process.env });
vite.on('exit', (code) => {
  if (code !== 0) process.exit(code ?? 0);
});

async function waitFor(url, timeoutMs = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Vite 在 ${timeoutMs}ms 内未就绪`);
}

await waitFor('http://127.0.0.1:5183/');
console.log('[dev] vite 就绪，启动 Electron');

const electron = spawn(electronBin, ['apps/desktop/dist/main.cjs', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: electronEnv({ MOOCR_DEV: '1' }),
});
electron.on('exit', (code) => {
  vite.kill();
  process.exit(code ?? 0);
});

process.on('SIGINT', () => {
  electron.kill();
  vite.kill();
  process.exit(0);
});

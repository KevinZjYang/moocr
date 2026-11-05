/**
 * 用 esbuild 把 Electron 主进程与 preload 打成单文件。
 * 主进程依赖 packages/core 的 .ts 源码，esbuild 会一路内联，不需要 tsc。
 */
import esbuild from 'esbuild';
import fs from 'node:fs';

const shared = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: true,
  // docx 有原生 CJS 出口且依赖多，交给运行时 require，避免打包体积与副作用
  external: ['electron', 'docx'],
  logLevel: 'warning',
};

fs.mkdirSync('apps/desktop/dist', { recursive: true });

await esbuild.build({
  ...shared,
  entryPoints: ['apps/desktop/src/main.ts'],
  outfile: 'apps/desktop/dist/main.cjs',
});

await esbuild.build({
  ...shared,
  entryPoints: ['apps/desktop/src/preload.ts'],
  outfile: 'apps/desktop/dist/preload.cjs',
});

await esbuild.build({
  ...shared,
  entryPoints: ['apps/desktop/src/overlay-preload.ts'],
  outfile: 'apps/desktop/dist/overlay-preload.cjs',
});

console.log('主进程打包完成: apps/desktop/dist/{main,preload,overlay-preload}.cjs');

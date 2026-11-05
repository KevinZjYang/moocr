import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'apps/renderer',
  base: './',
  plugins: [react()],
  server: {
    // 必须显式绑 IPv4：默认 host「localhost」在 Windows 上常解析到 ::1，
    // dev-desktop.mjs 的 127.0.0.1 探活就会一直失败
    host: '127.0.0.1',
    port: 5183,
    strictPort: true,
  },
  build: {
    outDir: '../../dist/renderer',
    emptyOutDir: true,
    rollupOptions: {
      // 主界面 + 截图覆盖层，两个独立入口
      // 两个入口：主界面 + 截图覆盖层。input 按 cwd（项目根）解析，不是 root
      input: {
        main: 'apps/renderer/index.html',
        overlay: 'apps/renderer/overlay.html',
      },
    },
  },
});

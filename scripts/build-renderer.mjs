/**
 * 构建渲染进程（vite build）。独立成脚本是为了让 `npm start` 也能一条龙。
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const viteBin = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');

const child = spawn(process.execPath, [viteBin, 'build'], { stdio: 'inherit', cwd: root });
child.on('exit', (code) => process.exit(code ?? 0));

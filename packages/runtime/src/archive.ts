/**
 * llama.cpp 发行包是 zip，Windows 自带 bsdtar 就能解，不引第三方依赖。
 * 解压后不能假设目录结构：不同版本有的把文件放 zip 根，有的放 build/bin/。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { serverName } from './paths.ts';

const exec = promisify(execFile);

export async function extractZip(zip: string, dest: string): Promise<void> {
  await fsp.mkdir(dest, { recursive: true });
  if (process.platform === 'win32') {
    try {
      await exec('tar', ['-xf', zip, '-C', dest], { windowsHide: true });
      return;
    } catch (e) {
      // 极老的 Win10 没有 bsdtar，退回 unzip（如果装了）
      try {
        await exec('unzip', ['-o', '-q', zip, '-d', dest], { windowsHide: true });
        return;
      } catch {
        throw new Error(`解压失败：系统缺少 tar/unzip（${(e as Error).message}）`);
      }
    }
  }
  await exec('unzip', ['-o', '-q', zip, '-d', dest]);
}

/** 在解压目录里找 llama-server，最多下探 4 层 */
async function findServer(dir: string, exe: string, depth = 0): Promise<string | null> {
  if (depth > 4) return null;
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    if (e.isFile() && e.name.toLowerCase() === exe.toLowerCase()) return path.join(dir, e.name);
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const hit = await findServer(path.join(dir, e.name), exe, depth + 1);
    if (hit) return hit;
  }
  return null;
}

/**
 * 解压 zip 并把 llama-server 所在目录的内容铺到 binDir。
 * 先解到临时目录，成功后再拷贝，避免半解压状态被当成可用。
 */
export async function extractLlamaBin(
  zip: string,
  binDir: string,
  opts: { tmpRoot: string; platform?: string } = { tmpRoot: path.dirname(binDir) }
): Promise<void> {
  const exe = serverName(opts.platform ?? process.platform);
  const tmp = path.join(opts.tmpRoot, `.extract-${process.pid}-${Date.now()}`);
  try {
    await extractZip(zip, tmp);
    const server = await findServer(tmp, exe);
    if (!server) {
      const names = await fsp.readdir(tmp).catch(() => []);
      throw new Error(`压缩包里没找到 ${exe}（顶层：${names.slice(0, 8).join(', ') || '空'}）`);
    }

    await fsp.mkdir(binDir, { recursive: true });
    const srcDir = path.dirname(server);
    for (const name of await fsp.readdir(srcDir)) {
      await fsp.cp(path.join(srcDir, name), path.join(binDir, name), {
        recursive: true,
        force: true,
      });
    }
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

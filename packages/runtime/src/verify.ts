/**
 * 完整性校验与 llama-server 探活。
 *
 * 下载/导入后必须过 sha256；启动时只比较大小（700 MB 不宜每次启动都哈希）。
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { spawn } from 'node:child_process';

export interface VerifyExpectation {
  bytes?: number;
  sha256?: string;
}

export type VerifyResult =
  | { ok: true; bytes: number; sha256: string }
  | { ok: false; reason: 'missing' | 'size' | 'hash'; bytes?: number; sha256?: string };

export async function sha256File(
  file: string,
  onProgress?: (bytes: number) => void
): Promise<string> {
  const hash = crypto.createHash('sha256');
  let seen = 0;
  for await (const chunk of fs.createReadStream(file)) {
    hash.update(chunk as Buffer);
    seen += (chunk as Buffer).length;
    onProgress?.(seen);
  }
  return hash.digest('hex');
}

export async function verifyFile(file: string, expect: VerifyExpectation): Promise<VerifyResult> {
  let size: number;
  try {
    const st = await fs.promises.stat(file);
    if (!st.isFile()) return { ok: false, reason: 'missing' };
    size = st.size;
  } catch {
    return { ok: false, reason: 'missing' };
  }

  if (expect.bytes !== undefined && size !== expect.bytes) {
    return { ok: false, reason: 'size', bytes: size };
  }
  if (!expect.sha256) return { ok: true, bytes: size, sha256: '' };

  const digest = await sha256File(file);
  if (digest !== expect.sha256.toLowerCase()) {
    return { ok: false, reason: 'hash', bytes: size, sha256: digest };
  }
  return { ok: true, bytes: size, sha256: digest };
}

export interface ProbeResult {
  ok: boolean;
  output: string;
  code?: number | null;
  timedOut?: boolean;
}

/**
 * 跑一次 `llama-server --version`，把「DLL 缺失 / Vulkan 驱动不对」这类问题
 * 在下载完成后就暴露出来，而不是等到识别时 180 秒超时。
 */
export function probeLlamaServer(
  exe: string,
  opts: { timeoutMs?: number; cwd?: string } = {}
): Promise<ProbeResult> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  return new Promise((resolve) => {
    let out = '';
    let settled = false;
    let timedOut = false;

    const finish = (r: ProbeResult) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(exe, ['--version'], {
        cwd: opts.cwd ?? path.dirname(exe),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      finish({ ok: false, output: (e as Error).message });
      return;
    }

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    }, timeoutMs);

    const collect = (buf: Buffer) => {
      if (out.length < 8192) out += buf.toString('utf8');
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);

    child.on('error', (e) => {
      clearTimeout(timer);
      finish({ ok: false, output: `${out}${e.message}` });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      const text = out.trim();
      // 有的构建把版本打在 stderr 并以 0 退出，有的只认 --help；有输出且不是
      // Windows 的 0xc0000135（DLL 缺失）就认为二进制能起来。
      const ok = !timedOut && (code === 0 || /version|usage|llama-server/i.test(text));
      finish({ ok, output: text, code, timedOut });
    });
  });
}

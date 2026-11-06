/**
 * packages/runtime 的最小回归：不打网络，全部本地临时目录 + 本地 HTTP。
 * 运行：node packages/runtime/test/run.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { parseManifest } from '../src/index.ts';
import {
  resolveRuntime,
  pathsFromStatus,
  type RuntimeManifest,
  type RuntimeLocations,
} from '../src/paths.ts';
import { verifyFile } from '../src/verify.ts';
import { downloadFile, DownloadPausedError } from '../src/download.ts';
import { createRuntimeInstaller } from '../src/installer.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const HEX0 = '0'.repeat(64);

function sha(data: Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function tmpDir(tag: string): string {
  const dir = path.join(os.tmpdir(), `moocr-rt-${process.pid}-${Date.now()}-${tag}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function write(file: string, data: Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
}

function synthManifest(model: Buffer, mmproj: Buffer): RuntimeManifest {
  return {
    schemaVersion: 1,
    llama: {
      version: 'test',
      archives: {
        [`${process.platform}-${process.arch}`]: {
          url: 'https://example.invalid/llama.zip',
          bytes: 4,
          sha256: HEX0,
        },
      },
    },
    models: [
      {
        id: 'model',
        file: 'm.gguf',
        bytes: model.length,
        sha256: sha(model),
        url: 'https://example.invalid/m.gguf',
        mirrors: ['https://mirror.invalid/m.gguf'],
      },
      {
        id: 'mmproj',
        file: 'mm.gguf',
        bytes: mmproj.length,
        sha256: sha(mmproj),
        url: 'https://example.invalid/mm.gguf',
      },
    ],
    license: { name: 'Apache-2.0', url: 'https://example.invalid/license' },
    totalBytes: model.length + mmproj.length,
  };
}

function serve(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

async function testManifest(): Promise<void> {
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'packages/runtime/runtime-manifest.json'), 'utf8'));
  const m = parseManifest(raw);
  assert.equal(m.totalBytes, m.models.reduce((n, x) => n + x.bytes, 0));
  assert.throws(() => parseManifest({ ...raw, totalBytes: 1 }), /totalBytes/);
  assert.throws(() => parseManifest({ ...raw, models: [{ ...raw.models[0], sha256: 'x' }] }), /sha256/);
}

async function testResolution(): Promise<void> {
  const model = Buffer.alloc(16, 1);
  const mmproj = Buffer.alloc(8, 2);
  const manifest = synthManifest(model, mmproj);
  const base = tmpDir('resolve');

  const bundled = path.join(base, 'bundled');
  const user = path.join(base, 'user');
  const env = path.join(base, 'env');
  const legacy = path.join(base, 'legacy');

  write(path.join(bundled, 'llama/bin/llama-server.exe'), Buffer.from('exe'));
  write(path.join(bundled, 'llama/bin/llama-server'), Buffer.from('exe'));
  write(path.join(user, 'models/m.gguf'), model);
  write(path.join(legacy, 'models/mm.gguf'), mmproj);

  const loc: RuntimeLocations = {
    bundledRoot: bundled,
    userRoot: user,
    envRoot: env,
    legacyRoots: [legacy],
  };

  let s = resolveRuntime(manifest, loc, 'win32');
  assert.equal(s.ready, true, JSON.stringify(s.components));
  assert.equal(s.components.find((c) => c.id === 'llama')?.source, 'bundled');
  assert.equal(s.components.find((c) => c.id === 'model')?.source, 'user');
  assert.equal(s.components.find((c) => c.id === 'mmproj')?.source, 'legacy');
  assert.equal(s.modelsDir, path.join(user, 'models'));

  write(path.join(env, 'models/m.gguf'), model);
  write(path.join(env, 'models/mm.gguf'), mmproj);
  write(path.join(env, 'llama/bin/llama-server.exe'), Buffer.from('exe'));
  s = resolveRuntime(manifest, { ...loc, envRoot: env }, 'win32');
  assert.equal(s.components.find((c) => c.id === 'model')?.source, 'env');
  assert.equal(s.components.find((c) => c.id === 'llama')?.source, 'env');

  // 大小不符不能算存在
  write(path.join(user, 'models/m.gguf'), Buffer.alloc(3));
  s = resolveRuntime(manifest, { ...loc, envRoot: undefined }, 'win32');
  assert.equal(s.components.find((c) => c.id === 'model')?.present, false);
  assert.match(s.components.find((c) => c.id === 'model')?.note ?? '', /大小不符/);

  const paths = pathsFromStatus(s);
  assert.ok(paths.serverExe.endsWith(path.join('llama', 'bin', 'llama-server.exe')));
  await fsp.rm(base, { recursive: true, force: true });
}

async function testVerify(): Promise<void> {
  const dir = tmpDir('verify');
  const file = path.join(dir, 'a.bin');
  write(file, Buffer.from('abcdef'));
  assert.equal((await verifyFile(file, { bytes: 6, sha256: sha(Buffer.from('abcdef')) })).ok, true);
  const bad = await verifyFile(file, { bytes: 7 });
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.equal(bad.reason, 'size');
  await fsp.rm(dir, { recursive: true, force: true });
}

async function testDownloadResume(): Promise<void> {
  const body = Buffer.from('0123456789abcdef');
  const ranges: string[] = [];
  const srv = await serve((req, res) => {
    const range = String(req.headers.range ?? '');
    ranges.push(range);
    const start = range ? Number(/bytes=(\d+)-/.exec(range)?.[1] ?? 0) : 0;
    const slice = body.subarray(start);
    res.writeHead(range ? 206 : 200, { 'content-length': slice.length });
    res.end(slice);
  });

  const dir = tmpDir('dl');
  const dest = path.join(dir, 'data.bin');
  write(`${dest}.part`, body.subarray(0, 4));

  await downloadFile({
    url: `${srv.url}/data.bin`,
    dest,
    bytes: body.length,
    sha256: sha(body),
  });
  assert.deepEqual(fs.readFileSync(dest), body);
  assert.equal(fs.existsSync(`${dest}.part`), false);
  assert.equal(ranges[0], 'bytes=4-');
  await srv.close();
  await fsp.rm(dir, { recursive: true, force: true });
}

async function testDownloadIgnoresRange(): Promise<void> {
  const body = Buffer.from('abcdefghij');
  const srv = await serve((_req, res) => {
    res.writeHead(200, { 'content-length': body.length });
    res.end(body);
  });
  const dir = tmpDir('dl200');
  const dest = path.join(dir, 'data.bin');
  write(`${dest}.part`, body.subarray(0, 3));
  await downloadFile({ url: `${srv.url}/x`, dest, bytes: body.length, sha256: sha(body) });
  assert.deepEqual(fs.readFileSync(dest), body);
  await srv.close();
  await fsp.rm(dir, { recursive: true, force: true });
}

async function testMirrorAndHashFailure(): Promise<void> {
  const body = Buffer.from('mirror-me');
  let primaryHits = 0;
  const srv = await serve((req, res) => {
    if (req.url?.startsWith('/primary')) {
      primaryHits += 1;
      res.writeHead(503).end('no');
      return;
    }
    res.writeHead(200, { 'content-length': body.length });
    res.end(body);
  });
  const dir = tmpDir('mirror');
  const dest = path.join(dir, 'm.bin');
  await downloadFile({
    url: `${srv.url}/primary`,
    mirrors: [`${srv.url}/mirror`],
    dest,
    bytes: body.length,
    sha256: sha(body),
    idleTimeoutMs: 5000,
  });
  assert.deepEqual(fs.readFileSync(dest), body);
  assert.ok(primaryHits >= 1);

  // 哈希不对：不能留下 dest，也不能留坏 part
  const badDir = tmpDir('bad');
  const badDest = path.join(badDir, 'bad.bin');
  await assert.rejects(
    downloadFile({ url: `${srv.url}/x`, dest: badDest, bytes: body.length, sha256: HEX0, idleTimeoutMs: 5000 }),
    /校验失败|下载失败/
  );
  assert.equal(fs.existsSync(badDest), false);
  await srv.close();
  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.rm(badDir, { recursive: true, force: true });
}

async function testPause(): Promise<void> {
  const ctrl = new AbortController();
  ctrl.abort();
  const dir = tmpDir('pause');
  const dest = path.join(dir, 'p.bin');
  write(`${dest}.part`, Buffer.from('xx'));
  await assert.rejects(
    downloadFile(
      { url: 'https://example.invalid/p', dest, bytes: 4, sha256: HEX0 },
      { signal: ctrl.signal }
    ),
    (e: unknown) => e instanceof DownloadPausedError
  );
  assert.equal(fs.readFileSync(`${dest}.part`).length, 2);
  await fsp.rm(dir, { recursive: true, force: true });
}

async function testInstallerWithFakeFetch(): Promise<void> {
  const model = Buffer.from('model-bytes-1234');
  const mmproj = Buffer.from('mmproj');
  const manifest = synthManifest(model, mmproj);
  const base = tmpDir('installer');
  const locations: RuntimeLocations = {
    bundledRoot: path.join(base, 'bundled'),
    userRoot: path.join(base, 'user'),
  };
  const dir = tmpDir('installer-src');
  const src = path.join(dir, 'm.gguf');
  write(src, model);

  // llama.cpp 二进制作成「已存在」，只验证模型下载；真机由打包内置
  write(path.join(locations.userRoot, 'llama/bin/llama-server.exe'), Buffer.from('exe'));

  const fetchImpl = async (url: string) => {
    const data = url.endsWith('/mm.gguf') ? mmproj : model;
    return new Response(data as unknown as BodyInit, {
      status: 200,
      headers: { 'content-length': String(data.length) },
    });
  };

  const installer = createRuntimeInstaller({ manifest, locations, fetchImpl, platform: 'win32' });
  const s = await installer.start(['model', 'mmproj']);
  assert.equal(s.ready, true, JSON.stringify(s.components));
  assert.deepEqual(fs.readFileSync(path.join(locations.userRoot, 'models/m.gguf')), model);

  await installer.reset('models');
  assert.equal(installer.status().ready, false);

  const imp = await installer.importFiles([src]);
  assert.equal(imp.ok, true, imp.error);
  assert.equal(installer.status().components.find((c) => c.id === 'model')?.present, true);

  const wrong = path.join(dir, 'wrong.gguf');
  write(wrong, Buffer.from('not-the-model'));
  const bad = await installer.importFiles([wrong]);
  assert.equal(bad.ok, false);

  await fsp.rm(base, { recursive: true, force: true });
  await fsp.rm(dir, { recursive: true, force: true });
}

const tests: [string, () => Promise<void>][] = [
  ['manifest', testManifest],
  ['resolution', testResolution],
  ['verify', testVerify],
  ['download resume', testDownloadResume],
  ['download 200 fallback', testDownloadIgnoresRange],
  ['mirror + hash failure', testMirrorAndHashFailure],
  ['pause', testPause],
  ['installer', testInstallerWithFakeFetch],
];

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (e) {
    failed += 1;
    console.error(`FAIL ${name}`);
    console.error(e);
  }
}
if (failed > 0) process.exit(1);
console.log(`\n${tests.length} 项通过`);

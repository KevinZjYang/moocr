/**
 * 运行时资产：位置解析、完整性校验、断点续传下载、安装器。
 *
 * 这个包不依赖 Electron，桌面端、CLI、测试共用。
 */
export * from './paths.ts';
export * from './verify.ts';
export * from './download.ts';
export * from './archive.ts';
export * from './installer.ts';

import type { RuntimeManifest } from './paths.ts';

const HEX64 = /^[a-f0-9]{64}$/;

/** 解析并校验清单；宁可在启动时炸掉，也不要拿半张清单去下 700 MB */
export function parseManifest(input: unknown): RuntimeManifest {
  const m = input as RuntimeManifest;
  const bad = (msg: string) => {
    throw new Error(`runtime-manifest.json 不合法：${msg}`);
  };

  if (!m || typeof m !== 'object') bad('不是对象');
  if (m.schemaVersion !== 1) bad(`schemaVersion 应为 1，实际 ${m.schemaVersion}`);
  if (!m.llama || typeof m.llama !== 'object') bad('缺少 llama');
  if (!m.llama.archives || typeof m.llama.archives !== 'object') bad('缺少 llama.archives');
  if (!Array.isArray(m.models) || m.models.length === 0) bad('models 为空');

  const ids = new Set<string>();
  let sum = 0;
  for (const model of m.models) {
    if (model.id !== 'model' && model.id !== 'mmproj') bad(`未知模型 id：${model.id}`);
    if (ids.has(model.id)) bad(`模型 id 重复：${model.id}`);
    ids.add(model.id);
    if (!model.file) bad(`${model.id} 缺少 file`);
    if (!(model.bytes > 0)) bad(`${model.file} 的 bytes 非法`);
    if (!HEX64.test(model.sha256 ?? '')) bad(`${model.file} 的 sha256 非法`);
    if (!/^https:\/\//.test(model.url ?? '')) bad(`${model.file} 的 url 必须是 https`);
    for (const mirror of model.mirrors ?? []) {
      if (!/^https:\/\//.test(mirror)) bad(`${model.file} 的镜像必须是 https`);
    }
    sum += model.bytes;
  }
  if (m.totalBytes !== sum) bad(`totalBytes 应为 ${sum}，实际 ${m.totalBytes}`);

  for (const [platform, archive] of Object.entries(m.llama.archives)) {
    if (!archive.url) bad(`${platform} 缺少 url`);
    if (!(archive.bytes > 0)) bad(`${platform} 的 bytes 非法`);
    if (!HEX64.test(archive.sha256 ?? '')) bad(`${platform} 的 sha256 非法`);
  }

  return m;
}

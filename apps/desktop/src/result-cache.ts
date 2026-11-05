/**
 * 识别结果缓存 —— 断点续跑的实际形态。
 *
 * 不引入「任务」概念，而是按「图片内容 + 任务 + 预设 + 模型版本」做内容寻址：
 * - 同一张图重复识别立即返回（PDF 重开、批量重跑都不再烧 GPU）
 * - 跑到一半崩溃，重启后已完成的页自动命中，等价于断点续跑
 * - 换 preset / 换模型会让 key 变化，不会误命中旧精度结果
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { PageResult } from '../../../packages/core/src/pipeline.ts';

/** 模型换了就让缓存失效：用权重文件大小 + 修改时间派生 */
function modelVersion(modelPath: string): string {
  try {
    const st = fs.statSync(modelPath);
    return `${st.size}-${Math.round(st.mtimeMs)}`;
  } catch {
    return 'unknown';
  }
}

export class ResultCache {
  private dir: string;
  private version: string;
  private hits = 0;
  private misses = 0;

  /**
   * @param dir 缓存目录。桌面端传 app.getPath('userData') 下的位置 —— 安装目录
   *   在 Program Files 里是只读的，写 resources/ 会失败。
   * @param modelPath 权重文件路径，用于派生失效版本号
   */
  constructor(dir: string, modelPath: string) {
    this.dir = dir;
    this.version = modelVersion(modelPath);
  }

  key(imageUri: string, task: string, preset: string, kieSchema?: unknown): string {
    const h = crypto.createHash('sha256');
    // 图片字节可能几十 MB，先算内容摘要再拼元信息
    h.update(imageUri);
    h.update('\u0000');
    h.update([task, preset, this.version, kieSchema ? JSON.stringify(kieSchema) : ''].join('\u0001'));
    return h.digest('hex');
  }

  read(key: string): PageResult | null {
    try {
      const file = path.join(this.dir, `${key}.json`);
      if (!fs.existsSync(file)) {
        this.misses++;
        return null;
      }
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as PageResult;
      if (!parsed || typeof parsed.markdown !== 'string') {
        this.misses++;
        return null;
      }
      this.hits++;
      return { ...parsed, cached: true };
    } catch {
      this.misses++;
      return null;
    }
  }

  write(key: string, result: PageResult): void {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      // timings 不再有意义，但留着便于排查；cached 标记不落盘
      const { cached: _c, ...rest } = result;
      fs.writeFileSync(path.join(this.dir, `${key}.json`), JSON.stringify(rest));
    } catch {
      // 缓存失败不影响主流程
    }
  }

  /** 统计 + 清理 */
  stats(): { entries: number; bytes: number; hits: number; misses: number } {
    let entries = 0;
    let bytes = 0;
    try {
      for (const name of fs.readdirSync(this.dir)) {
        if (!name.endsWith('.json')) continue;
        entries++;
        bytes += fs.statSync(path.join(this.dir, name)).size;
      }
    } catch {
      // 目录不存在
    }
    return { entries, bytes, hits: this.hits, misses: this.misses };
  }

  clear(): number {
    const { entries } = this.stats();
    try {
      fs.rmSync(this.dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    this.hits = 0;
    this.misses = 0;
    return entries;
  }
}

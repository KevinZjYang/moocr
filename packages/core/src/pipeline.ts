/**
 * 单页 / 批量识别管线。
 *
 * 关键设计来自 docs/CAPABILITY.md §4（退化处理）与 §2（质量预设）：
 *   1. 每页只发一次请求（temperature=0，实测 100% 确定性），
 *   2. 只有 `text` 任务实测出现退化（nonce-cjk 55.9%），`document` 任务 12 组退化扫描全 0%
 *      → 退化时：非 document 任务先换 document prompt 重试一次；仍退化则截断尾部重复。
 *   3. finish_reason=length 单独告警，不与退化混为一谈。
 */
import { PROMPTS, DEFAULT_MAX_TOKENS, TASK_LABELS, buildKiePrompt, type TaskKind } from './prompts.ts';
import { complete, imageDataUri, type CompletionResponse } from '../../inference/src/server.ts';
import { normalizeMarkdown, summarizeMarkdown, stripCodeFence, type MarkdownSummary } from '../../postprocess/src/markdown.ts';
import { otslToHtml, looksLikeOtsl } from '../../postprocess/src/otsl.ts';
import { repeatStats, truncateDegeneration } from '../../postprocess/src/degeneration.ts';

export type { TaskKind };
export { PROMPTS, TASK_LABELS, DEFAULT_MAX_TOKENS };

export interface PageTimings {
  wallMs: number;
  promptTokens: number | null;
  /** 命中 KV 前缀缓存的 token（同图同 prompt 复跑时 >0） */
  cachedTokens: number | null;
  predictedTokens: number | null;
  prefillTps: number | null;
  decodeTps: number | null;
}

export interface AttemptInfo {
  task: TaskKind;
  finishReason: string;
  chars: number;
  degenerated: boolean;
  wallMs: number;
}

export interface PageResult {
  file: string;
  task: TaskKind;
  markdown: string;
  summary: MarkdownSummary;
  timings: PageTimings;
  attempts: AttemptInfo[];
  finishReason: string;
  degenerated: boolean;
  warnings: string[];
  /** 模型原始输出，便于排查（不进 UI 主视图） */
  raw: string;
  /** kie 任务解析成功的 JSON（解析失败则 undefined，markdown 里保留原文） */
  json?: unknown;
  /** 命中本地结果缓存：timings 是首次识别的，不代表本次耗时 */
  cached?: boolean;
}

export interface PageRequest {
  file: string;
  baseUrl: string;
  task?: TaskKind;
  maxTokens?: number;
  timeoutMs?: number;
  /** 便于测试注入；默认走真实 HTTP */
  completeFn?: (req: Parameters<typeof complete>[0]) => Promise<CompletionResponse>;
  /** 便于测试跳过 base64 读取 */
  imageUri?: string;
  /** kie 任务的字段 schema（对象或 JSON 文本），默认 KIE_SCHEMA */
  kieSchema?: Record<string, unknown> | string;
}

function aggregate(attempts: AttemptInfo[], responses: CompletionResponse[]): PageTimings {
  const wallMs = responses.reduce((s, r) => s + r.timings.wallMs, 0);
  const last = responses[responses.length - 1];
  const promptTokens = responses.reduce<number | null>(
    (s, r) => (s === null && r.timings.promptTokens === null ? null : (s ?? 0) + (r.timings.promptTokens ?? 0)),
    null
  );
  const predictedTokens =
    last.timings.predictedTokens === null
      ? null
      : responses.reduce((s, r) => s + (r.timings.predictedTokens ?? 0), 0);
  const cachedTokens = responses.some((r) => (r.timings.cachedTokens ?? 0) > 0)
    ? responses.reduce((s, r) => s + (r.timings.cachedTokens ?? 0), 0)
    : null;
  return {
    wallMs,
    promptTokens,
    cachedTokens,
    predictedTokens,
    prefillTps: last.timings.prefillTps,
    decodeTps: last.timings.decodeTps,
  };
}

/** 任务相关的最小后处理：表格任务整体转 HTML，kie 解析 JSON，其余走通用 markdown 归一。 */
function render(
  task: TaskKind,
  raw: string,
  kieSchema?: Record<string, unknown> | string
): { markdown: string; warnings: string[]; json?: unknown } {
  const warnings: string[] = [];
  const body = stripCodeFence(raw).trim();

  if (task === 'kie') {
    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch {
      // 模型偶尔在 JSON 前后加一句话；取第一个 { 到最后一个 } 再试一次
      const a = body.indexOf('{');
      const b = body.lastIndexOf('}');
      if (a >= 0 && b > a) {
        try {
          json = JSON.parse(body.slice(a, b + 1));
        } catch {
          /* 保持失败 */
        }
      }
    }
    if (json !== undefined) {
      // 模型有时把单条结果包成 [{...}]；单元素数组直接解包，多元素保留
      if (Array.isArray(json) && json.length === 1 && json[0] && typeof json[0] === 'object') {
        json = json[0];
      }
      return { markdown: '```json\n' + JSON.stringify(json, null, 2) + '\n```', warnings, json };
    }
    void kieSchema;
    warnings.push('KIE 输出不是合法 JSON，已按原文返回');
    return { markdown: body, warnings };
  }

  if (task === 'table') {
    if (looksLikeOtsl(body)) {
      const res = otslToHtml(body);
      warnings.push(...res.warnings);
      const tail = res.table.trailing.trim();
      return { markdown: tail ? `${res.html}\n\n${tail}` : res.html, warnings };
    }
    if (body.includes('<table')) return { markdown: body, warnings };
    warnings.push('表格任务输出未识别为 OTSL，按纯文本返回');
    return { markdown: body, warnings };
  }

  if (task === 'formula' || task === 'text') {
    return { markdown: body, warnings };
  }

  const norm = normalizeMarkdown(raw);
  warnings.push(...norm.warnings);
  return { markdown: norm.markdown, warnings };
}

export async function runPage(req: PageRequest): Promise<PageResult> {
  const task = req.task ?? 'document';
  const maxTokens = req.maxTokens ?? DEFAULT_MAX_TOKENS[task];
  const imageUri = req.imageUri ?? (await imageDataUri(req.file));
  const call0 = req.completeFn ?? complete;

  const attempts: AttemptInfo[] = [];
  const responses: CompletionResponse[] = [];
  const warnings: string[] = [];

  /** 取当前任务实际要发的 prompt：kie 需要把 schema 拼在指令后面 */
  const promptFor = (t: TaskKind): string => (t === 'kie' ? buildKiePrompt(req.kieSchema) : PROMPTS[t]);

  const call = async (t: TaskKind): Promise<CompletionResponse> => {
    const res = await call0({
      baseUrl: req.baseUrl,
      prompt: promptFor(t),
      imageUri,
      maxTokens: t === task ? maxTokens : DEFAULT_MAX_TOKENS[t],
      timeoutMs: req.timeoutMs,
    });
    responses.push(res);
    return res;
  };

  let res = await call(task);
  let degenerated = repeatStats(res.text).degenerated;
  attempts.push({
    task,
    finishReason: res.finishReason,
    chars: res.text.length,
    degenerated,
    wallMs: res.timings.wallMs,
  });

  // 退化守卫：document 实测 12 组全 0%，其余任务可能退化。
  // 非 document 任务退回整页 prompt 重试一次；kie 必须保持自己的 prompt
  // （换成 document prompt 会丢掉 JSON 结构），故同 prompt 重试一次。
  if (degenerated && task !== 'document') {
    const retryAs: TaskKind = task === 'kie' ? 'kie' : 'document';
    warnings.push(
      retryAs === 'kie'
        ? `${TASK_LABELS[task]}输出发生退化，已重试一次`
        : `${TASK_LABELS[task]}输出发生退化，已改用整页 prompt 重试`
    );
    res = await call(retryAs);
    degenerated = repeatStats(res.text).degenerated;
    attempts.push({
      task: retryAs,
      finishReason: res.finishReason,
      chars: res.text.length,
      degenerated,
      wallMs: res.timings.wallMs,
    });
  }

  let raw = res.text;
  if (degenerated) {
    const trunc = truncateDegeneration(raw);
    if (trunc.cut > 0) {
      raw = trunc.text;
      warnings.push(`已截断尾部重复输出（${trunc.cut} 字符）`);
    }
    warnings.push('输出仍存在重复，结果可能不完整');
  }

  if (res.finishReason === 'length') {
    warnings.push(`输出达到 ${maxTokens} token 上限被截断，可提高 --max-tokens`);
  }

  const rendered = render(attempts[attempts.length - 1].task, raw, req.kieSchema);
  warnings.push(...rendered.warnings);

  return {
    file: req.file,
    task,
    markdown: rendered.markdown,
    summary: summarizeMarkdown(rendered.markdown),
    timings: aggregate(attempts, responses),
    attempts,
    finishReason: res.finishReason,
    degenerated,
    warnings,
    raw: res.text,
    ...(rendered.json === undefined ? {} : { json: rendered.json }),
  };
}

/** 简单并发池：保持输入顺序，单页失败不影响其余页。 */
export async function runBatch(
  requests: PageRequest[],
  concurrency: number,
  onDone?: (result: PageResult | { file: string; error: string }, index: number) => void,
  /** 单页执行器，默认 runPage；桌面端注入带崩溃自愈的版本 */
  runner: (req: PageRequest) => Promise<PageResult> = runPage
): Promise<(PageResult | { file: string; error: string })[]> {
  const out: (PageResult | { file: string; error: string })[] = new Array(requests.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, requests.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= requests.length) return;
      try {
        out[i] = await runner(requests[i]);
      } catch (e) {
        out[i] = { file: requests[i].file, error: (e as Error).message };
      }
      onDone?.(out[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

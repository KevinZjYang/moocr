/**
 * core 管线测试：不联网，用注入的 completeFn 覆盖退化守卫、截断告警、表格渲染。
 *   node packages/core/test/run.ts
 */
import { runPage, PROMPTS, DEFAULT_MAX_TOKENS } from '../src/pipeline.ts';
import { buildKiePrompt } from '../src/prompts.ts';
import type { CompletionResponse } from '../../inference/src/server.ts';

let pass = 0;
let fail = 0;

function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}`, detail === undefined ? '' : detail);
  }
}

function eq<T>(name: string, actual: T, expected: T): void {
  check(name, Object.is(actual, expected), `实际 ${String(actual)} 期望 ${String(expected)}`);
}

function res(text: string, finishReason = 'stop', wallMs = 100, promptTokens = 500): CompletionResponse {
  return {
    text,
    finishReason,
    timings: {
      promptTokens,
      promptMs: 500,
      predictedTokens: 50,
      predictedMs: 300,
      wallMs,
      prefillTps: 1000,
      decodeTps: 166,
    },
  };
}

const FILE = 'fake.png';
const URI = 'data:image/png;base64,AAAA';
/** 明确的退化串：单字连发，被 degeneration 判为异常 */
const DEGENERATE = '㕥'.repeat(80);

/** 记录调用顺序的假推理函数 */
function scripted(seq: CompletionResponse[]) {
  const calls: { prompt: string; maxTokens: number }[] = [];
  const fn = async (r: { prompt: string; maxTokens: number }) => {
    calls.push({ prompt: r.prompt, maxTokens: r.maxTokens });
    const next = seq[Math.min(calls.length - 1, seq.length - 1)];
    return next;
  };
  return { fn, calls };
}

async function main(): Promise<void> {
  console.log('[prompts]');
  eq('document prompt 逐字匹配官方', PROMPTS.document.startsWith('Extract all information from the main body'), true);
  eq('每个任务都有默认预算', Object.keys(DEFAULT_MAX_TOKENS).length, Object.keys(PROMPTS).length);

  console.log('\n[退化守卫]');
  {
    const s = scripted([res(DEGENERATE), res('干净正文')]);
    const r = await runPage({
      file: FILE,
      baseUrl: 'http://x',
      imageUri: URI,
      task: 'text',
      completeFn: s.fn,
    });
    eq('text 任务退化后重试一次', s.calls.length, 2);
    check('重试用的是 document prompt', s.calls[1].prompt === PROMPTS.document, s.calls[1].prompt.slice(0, 40));
    eq('结果采用重试输出', r.markdown, '干净正文');
    check('warnings 说明已改整页重试', r.warnings.some((w) => w.includes('整页 prompt 重试')), r.warnings);
    eq('attempts 记录两次', r.attempts.length, 2);
    eq('wallMs 为两次之和', r.timings.wallMs, 200);
    eq('最终 degenerated=false', r.degenerated, false);
  }

  {
    const s = scripted([res(DEGENERATE)]);
    const r = await runPage({
      file: FILE,
      baseUrl: 'http://x',
      imageUri: URI,
      task: 'document',
      completeFn: s.fn,
    });
    eq('document 任务退化不重试', s.calls.length, 1);
    check('warnings 提示截断', r.warnings.some((w) => w.includes('截断')), r.warnings);
    check('截断后不再含 80 连发', !r.markdown.includes('㕥'.repeat(80)), r.markdown.length);
    eq('degenerated 标记为 true', r.degenerated, true);
  }

  {
    const s = scripted([res('正文')]);
    const r = await runPage({
      file: FILE,
      baseUrl: 'http://x',
      imageUri: URI,
      task: 'text',
      completeFn: s.fn,
      maxTokens: 2048,
    });
    eq('正常输出不触发重试', s.calls.length, 1);
    eq('maxTokens 透传到请求', s.calls[0].maxTokens, 2048);
    eq('无 warning', r.warnings.length, 0);
  }

  console.log('\n[截断告警]');
  {
    const s = scripted([res('部分输出', 'length')]);
    const r = await runPage({
      file: FILE,
      baseUrl: 'http://x',
      imageUri: URI,
      task: 'document',
      completeFn: s.fn,
    });
    check('finish_reason=length 产生告警', r.warnings.some((w) => w.includes('token 上限')), r.warnings);
    eq('finishReason 保留原值', r.finishReason, 'length');
  }

  console.log('\n[渲染]');
  {
    const otsl = '<fcel>a<fcel>b<nl><fcel>c<fcel>d<nl>';
    const s = scripted([res(otsl)]);
    const r = await runPage({
      file: FILE,
      baseUrl: 'http://x',
      imageUri: URI,
      task: 'table',
      completeFn: s.fn,
    });
    check('table 任务输出 HTML 表格', r.markdown.includes('<table'), r.markdown.slice(0, 80));
    eq('table 任务 2 行', (r.markdown.match(/<tr>/g) ?? []).length, 2);
    eq('summary 统计到表', r.summary.tables, 1);
  }

  {
    const s = scripted([res('# 标题\n\n<fcel>a<fcel>b<nl><fcel>c<fcel>d<nl>\n\n尾注')]);
    const r = await runPage({
      file: FILE,
      baseUrl: 'http://x',
      imageUri: URI,
      task: 'document',
      completeFn: s.fn,
    });
    check('document 内嵌表转 HTML', r.markdown.includes('<table'), r.markdown.slice(0, 120));
    check('标题保留', r.markdown.startsWith('# 标题'), r.markdown.slice(0, 20));
    check('尾注保留', r.markdown.includes('尾注'));
  }

  {
    const s = scripted([res('这不是表格')]);
    const r = await runPage({
      file: FILE,
      baseUrl: 'http://x',
      imageUri: URI,
      task: 'table',
      completeFn: s.fn,
    });
    check('非 OTSL 表格输出退回纯文本并告警', r.warnings.some((w) => w.includes('未识别为 OTSL')), r.warnings);
    eq('纯文本内容保留', r.markdown, '这不是表格');
  }

  // ---- KIE ----
  {
    const p = buildKiePrompt();
    check('KIE prompt 含固定指令', p.startsWith(PROMPTS.kie));
    check('KIE prompt 含 schema 指令', p.includes('according to the following schema'));
    for (const k of ['date', 'seller_name', 'total_amount', 'total_tax']) {
      check(`KIE 默认模板含 ${k}`, p.includes(`"${k}"`), p);
    }
    check('KIE 默认模板不是 JSON Schema 元语言', !p.includes('"properties"'));

    const fromSchema = buildKiePrompt({
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'string' } },
      required: ['a'],
    });
    check('KIE 识别 properties 并转模板', fromSchema.includes('"a"') && !fromSchema.includes('required'), fromSchema);
  }

  {
    const s = scripted([res('{"date":"2017-10-18","total_amount":"5.90"}')]);
    const r = await runPage({
      file: FILE,
      baseUrl: 'http://x',
      imageUri: URI,
      task: 'kie',
      completeFn: s.fn,
    });
    eq('KIE json 已解析', (r.json as { total_amount?: string })?.total_amount, '5.90');
    check('KIE markdown 是 json 围栏', r.markdown.startsWith('```json'), r.markdown.slice(0, 20));
    check('KIE 无退化告警', r.warnings.length === 0, r.warnings);
  }

  {
    const s = scripted([res('[{"total_amount":"1.00"}]')]);
    const r = await runPage({
      file: FILE,
      baseUrl: 'http://x',
      imageUri: URI,
      task: 'kie',
      completeFn: s.fn,
    });
    eq('KIE 单元素数组解包', (r.json as { total_amount?: string })?.total_amount, '1.00');
  }

  {
    const s = scripted([res('抱歉，我无法识别')]);
    const r = await runPage({
      file: FILE,
      baseUrl: 'http://x',
      imageUri: URI,
      task: 'kie',
      completeFn: s.fn,
    });
    check('KIE 非 JSON 时告警', r.warnings.some((w) => w.includes('不是合法 JSON')), r.warnings);
    check('KIE 非 JSON 保留原文', r.markdown.includes('抱歉'));
    check('KIE 非 JSON 时不设置 json 字段', r.json === undefined);
  }

  {
    // kie 退化时应保持自己的 prompt（换 document prompt 会丢 JSON 结构）
    const s = scripted([res('㕥'.repeat(200)), res('{"total_amount":"2.00"}')]);
    const r = await runPage({
      file: FILE,
      baseUrl: 'http://x',
      imageUri: URI,
      task: 'kie',
      completeFn: s.fn,
    });
    eq('KIE 退化后重试一次', r.attempts.length, 2);
    check('KIE 重试仍用 kie prompt', s.calls[1].prompt.includes('according to the following schema'), s.calls[1].prompt.slice(0, 80));
    eq('KIE 重试结果被采用', (r.json as { total_amount?: string })?.total_amount, '2.00');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exitCode = 1;
}

void main();

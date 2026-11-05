/**
 * 官方 prompt（逐字取自 HF model card / GitHub README，与 docs/capability.json 一致）。
 * 独立成文件是为了让 M2 的渲染进程也能引用，且可被测试断言防漂移。
 */
export type TaskKind = 'document' | 'text' | 'table' | 'formula' | 'kie';

export const PROMPTS: Record<TaskKind, string> = {
  document:
    'Extract all information from the main body of the document image and represent it in markdown format, ignoring headers and footers. Tables should be expressed in OTSL format, formulas in the document should be represented using LATEX format, and the parsing should be organized according to the reading order.',
  text: 'Extract the text in the image.',
  table: 'Parse the table in the image into OTSL.',
  formula: 'Identify the formula in the image and represent it using LATEX format.',
  // KIE 的官方写法是「固定前缀 + JSON schema」，schema 由调用方给（见 buildKiePrompt）
  kie: 'Extract key information in the image',
};

/** 按任务给输出预算。实测：dense 页 1613 tok、手写 1023 tok、双栏 124 tok。 */
export const DEFAULT_MAX_TOKENS: Record<TaskKind, number> = {
  document: 4096,
  table: 1536,
  formula: 1024,
  text: 2048,
  kie: 1024,
};

export const TASK_LABELS: Record<TaskKind, string> = {
  document: '整页文档',
  text: '纯文本',
  table: '表格',
  formula: '公式',
  kie: '关键信息',
};

/**
 * 收据 KIE 的默认字段模板。
 *
 * 注意：这里用的是「示例对象」（键 + 空值），**不是** JSON Schema 元语言。
 * 实测（M3）：给模型完整的 {"type":"object","properties":{...}} 它并不认，
 * 会按自己的理解输出一堆自造字段、还包成数组；换回 M0 验证过的扁平模板
 * （6 键全对：date / total_amount / total_tax 都正确）后恢复正常。
 */
export const KIE_SCHEMA: Record<string, unknown> = {
  date: '',
  seller_address: '',
  seller_gst_id: '',
  seller_name: '',
  total_amount: '',
  total_tax: '',
};

/** 若用户粘贴的是完整 JSON Schema，取 properties 的键拼成模板。 */
function toTemplate(schema: Record<string, unknown> | string): Record<string, unknown> | string {
  if (typeof schema === 'string') return schema;
  const props = schema.properties;
  if (props && typeof props === 'object' && !Array.isArray(props)) {
    const keys = Object.keys(props as Record<string, unknown>);
    if (keys.length) return Object.fromEntries(keys.map((k) => [k, '']));
  }
  return schema;
}

/**
 * 拼 KIE prompt。
 * 措辞逐字沿用 M0 实测有效的那一版（docs/capability.json 的 kie 用例），
 * 只把模板部分参数化。
 */
export function buildKiePrompt(schema: Record<string, unknown> | string = KIE_SCHEMA): string {
  const tpl = toTemplate(schema);
  const body = typeof tpl === 'string' ? tpl.trim() : JSON.stringify(tpl, null, 2);
  return `${PROMPTS.kie}\n\nPlease output the key information in JSON format according to the following schema:\n${body}`;
}

/** 解析 utf8 的 schema 文本（UI 里允许用户粘贴），失败返回 null。 */
export function parseKieSchema(text: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

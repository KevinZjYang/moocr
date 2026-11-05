import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
/**
 * 验证结果缓存：同图重复识别应命中、换 preset 应失效、清空后应重算。
 * 用法: node scripts/m4-cache-check.mjs [port]
 */
const PORT = process.argv[2] ?? '9222';
const BASE = `http://127.0.0.1:${PORT}`;

const targets = await (await fetch(`${BASE}/json/list`)).json();
const page = targets.find((t) => t.type === 'page' && !t.url.startsWith('devtools://'));
if (!page) throw new Error('no page target');

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
});
let seq = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { res, rej } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
  }
};
const send = (method, params = {}) => {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((res, rej) => pending.set(id, { res, rej }));
};
const evalJs = async (expression, awaitPromise = false) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true, userGesture: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval failed');
  return r.result.value;
};

await send('Runtime.enable');

const T = [{ label: 'ru-paragraph.png', path: path.join(ROOT, 'fixtures/synth/ru-paragraph.png') }];
const ident = (preset) =>
  evalJs(
    `window.moocr.identify(${JSON.stringify({ targets: T, task: 'document', preset, parallel: 1 })})`,
    true
  );

const t = async (label, fn) => {
  const t0 = Date.now();
  const r = await fn();
  const ms = Date.now() - t0;
  const cached = r?.results?.[0]?.cached === true;
  const chars = r?.results?.[0]?.summary?.chars ?? 0;
  console.log(`${label}: ${ms} ms · ${chars} 字 · cached=${cached}`);
  if (!r?.ok) throw new Error(`${label} 失败: ${r?.error}`);
  return { ms, cached };
};

const clear = () => evalJs('window.moocr.cacheClear()', true);

console.log('清理旧缓存…');
const cleared = await clear();
console.log(`  cleared=${cleared.cleared}\n`);

const a = await t('第 1 次 standard', () => ident('standard'));
const b = await t('第 2 次 standard', () => ident('standard'));
const c = await t('换 preset accurate', () => ident('accurate'));
const d = await t('再回 standard', () => ident('standard'));

const stats = await evalJs('window.moocr.cacheStats()', true);
console.log(`\ncache stats: ${JSON.stringify(stats)}`);

const fail = [];
if (a.cached) fail.push('首次不该命中缓存');
if (!b.cached) fail.push('第二次应命中缓存');
if (b.ms > a.ms / 3) fail.push(`缓存命中不够快（${b.ms} ms vs ${a.ms} ms）`);
if (c.cached) fail.push('换 preset 后不该命中');
if (!d.cached) fail.push('回到原 preset 应命中');
if (stats.entries < 2) fail.push(`entries 应 ≥2，实际 ${stats.entries}`);

if (fail.length > 0) {
  console.error('\n失败:\n  ' + fail.join('\n  '));
  process.exit(1);
}
console.log('\nCACHE OK');
process.exit(0);

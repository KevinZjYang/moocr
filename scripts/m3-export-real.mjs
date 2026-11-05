/**
 * M3 真实链路导出验证：图片 → identify → 用真实 PageResult 导出 md/html/docx。
 * 用法: node scripts/m3-export-real.mjs [port]
 */
import fs from 'node:fs';
import path from 'node:path';

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
async function evalJs(expression, awaitPromise = false) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true, userGesture: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval failed');
  return r.result.value;
}

await send('Runtime.enable');

const ROOT = path.resolve(import.meta.dirname, '..').replace(/\/g, '/');
const files = ['fixtures/synth/table-merged.png', 'fixtures/synth/mix-en-zh.png', 'fixtures/synth/formula-simple.png'];
const targets2 = files.map((f) => ({ label: path.basename(f), path: `${ROOT}/${f}` }));

console.log('identify 3 images…');
const r = await evalJs(
  `window.moocr.identify(${JSON.stringify({ targets: targets2, task: 'document', preset: 'standard' })})`,
  true,
);
if (!r?.ok) throw new Error(`identify failed: ${r?.error}`);
console.log(`results: ${r.results.length}`);
for (const p of r.results) {
  console.log(`  ${p.file}: ${p.markdown.length} chars, warnings=${p.warnings.length}`);
}

const pages = r.results.map((p) => ({ label: p.file.replace(/\.\w+$/, ''), markdown: p.markdown }));

const outDir = path.join(ROOT, 'out/_m3/real');
fs.mkdirSync(outDir, { recursive: true });

for (const format of ['md', 'html', 'docx']) {
  const savePath = path.join(outDir, `real.${format}`).replace(/\\/g, '/');
  const res = await evalJs(
    `window.moocr.export(${JSON.stringify({ format, pages, defaultName: 'real', savePath })})`,
    true,
  );
  if (!res?.ok) throw new Error(`export ${format} failed: ${res?.error}`);
  const size = fs.statSync(savePath).size;
  console.log(`  ${format}: ${size} bytes → ${savePath}`);
  if (size < 200) throw new Error(`${format} 输出过小（${size}）`);
}

const html = fs.readFileSync(path.join(outDir, 'real.html'), 'utf8');
const md = fs.readFileSync(path.join(outDir, 'real.md'), 'utf8');
const docx = fs.readFileSync(path.join(outDir, 'real.docx'));

const tables = (html.match(/<table/g) ?? []).length;
const colspans = (html.match(/colspan="/g) ?? []).length;
console.log(`\nhtml: tables=${tables} colspan=${colspans}`);
console.log(`docx magic: ${docx.subarray(0, 2).toString('hex')} (期望 504b)`);
console.log(`md 含 p1 段: ${md.includes('## table-merged')}, 含公式: ${md.includes('\\frac') || md.includes('\\sqrt')}`);

if (tables < 1) throw new Error('HTML 没有表格');
if (colspans < 1) throw new Error('HTML 缺 colspan（合并单元格丢失）');
if (docx.subarray(0, 2).toString('hex') !== '504b') throw new Error('DOCX 不是 zip');
console.log('\nEXPORT OK');
process.exit(0);

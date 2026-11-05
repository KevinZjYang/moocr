// 端到端验证：真实识别公式图 → 导出 docx → 交付给 Word 检查
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

const PORT = process.argv[2] ?? '9223';
const OUT = process.argv[3] ?? 'out/moocr-e2e.docx';

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === 'page');
if (!page) throw new Error('no page target');

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', () => reject(new Error('ws error')), { once: true });
});

let seq = 0;
const pending = new Map();

ws.addEventListener('message', (e) => {
  const msg = JSON.parse(e.data.toString());
  const p = pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id);
  msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
});

function send(method, params = {}) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`timeout ${method}`));
    }, 180_000).unref?.();
  });
}

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, timeout: 170000 });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval failed');
  return r.result.value;
}

await send('Runtime.enable');

const targets = [
  { label: 'p1 混合排版', path: path.join(ROOT, 'fixtures/synth/mix-en-zh.png') },
  { label: 'p2 合并单元格', path: path.join(ROOT, 'fixtures/synth/table-merged.png') },
  { label: 'p3 公式', path: path.join(ROOT, 'fixtures/synth/formula-simple.png') },
];

const res = await evaluate(
  `window.moocr.identify({targets: ${JSON.stringify(targets)}, task: 'document', preset: 'standard', parallel: 1})`
);

console.log(`identify ok=${res.ok} pages=${res.results?.length ?? 0}`);
for (const p of res.results ?? []) {
  console.log(`  ${p.file}: ${p.summary?.chars ?? 0} chars, ${p.timings?.wallMs ?? 0} ms${p.error ? ` ERROR ${p.error}` : ''}`);
}

const pages = (res.results ?? []).filter((p) => !p.error).map((p) => ({ label: p.file, markdown: p.markdown }));

const savePath = path.resolve(OUT);
const exp = await evaluate(
  `window.moocr.export({format: 'docx', pages: ${JSON.stringify(pages)}, defaultName: 'moocr-e2e', savePath: ${JSON.stringify(savePath)}})`
);
console.log(`export ${JSON.stringify(exp)}`);
console.log(`exists ${fs.existsSync(savePath)} size ${fs.existsSync(savePath) ? fs.statSync(savePath).size : 0}`);

ws.close();
process.exit(0);

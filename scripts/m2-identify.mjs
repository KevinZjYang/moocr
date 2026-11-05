/**
 * 在渲染进程里调用 window.moocr.identify，验证 IPC → sidecar → runPage 全链路。
 * 用法: node scripts/m2-identify.mjs <task> <preset> <cdpPort> <file...>
 */
import fs from 'node:fs';

const [task = 'document', preset = 'standard', port = '9222', ...files] = process.argv.slice(2);
if (files.length === 0) {
  console.error('用法: node scripts/m2-identify.mjs <task> <preset> <port> <file...>');
  process.exit(1);
}

const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const progress = [];

ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    return;
  }
  if (msg.method === 'Runtime.consoleAPICalled') {
    const text = (msg.params.args ?? []).map((a) => a.value ?? a.description).join(' ');
    console.log('  console:', text.slice(0, 200));
  }
});

function send(method, params = {}, timeoutMs = 600_000) {
  const mid = ++id;
  ws.send(JSON.stringify({ id: mid, method, params }));
  return new Promise((resolve, reject) => {
    // timer 必须 unref，否则进程会挂到超时才退出
    const timer = setTimeout(() => {
      if (pending.has(mid)) {
        pending.delete(mid);
        reject(new Error(`timeout: ${method}`));
      }
    }, timeoutMs);
    timer.unref?.();
    pending.set(mid, { resolve, reject });
  });
}

await new Promise((r, j) => {
  ws.addEventListener('open', r, { once: true });
  ws.addEventListener('error', (e) => j(new Error(e.message)), { once: true });
});

await send('Runtime.enable');

// 监听 progress 事件
await send('Runtime.evaluate', {
  expression: `window.__progress = []; window.moocr.onProgress(p => window.__progress.push(p)); 1`,
});

const arg = JSON.stringify({ files, task, preset });
const t0 = Date.now();
const res = await send('Runtime.evaluate', {
  expression: `window.moocr.identify(${arg})`,
  awaitPromise: true,
  returnByValue: true,
});
console.log(`round-trip: ${((Date.now() - t0) / 1000).toFixed(2)}s`);

const value = res.result?.value;
if (!value) {
  console.log('raw:', JSON.stringify(res).slice(0, 800));
  process.exit(1);
}

if (!value.ok) {
  console.log('FAILED:', value.error);
  process.exit(1);
}

for (const r of value.results) {
  console.log('\n=== ' + r.file);
  console.log(
    `task=${r.task} end=${r.finishReason} degenerated=${r.degenerated} chars=${r.summary.chars} ` +
      `wall=${(r.timings.wallMs / 1000).toFixed(2)}s in=${r.timings.promptTokens} out=${r.timings.predictedTokens} ` +
      `prefill=${r.timings.prefillTps ? Math.round(r.timings.prefillTps) : '-'}tps decode=${r.timings.decodeTps ? Math.round(r.timings.decodeTps) : '-'}tps ` +
      `attempts=${r.attempts.length} tables=${r.summary.tables}`
  );
  if (r.warnings?.length) console.log('warnings: ' + r.warnings.join(' | '));
  console.log('--- markdown ---');
  console.log(r.markdown.slice(0, 1600));
  if (r.markdown.length > 1600) console.log(`… (+${r.markdown.length - 1600} chars)`);

  const safe = r.file.replace(/[^A-Za-z0-9._-]/g, '_');
  const out = `out/ui-${safe}.md`;
  fs.mkdirSync('out', { recursive: true });
  fs.writeFileSync(out, r.markdown);
  console.log(`saved: ${out}`);
}

const prog = await send('Runtime.evaluate', {
  expression: `JSON.stringify((window.__progress||[]).map(p => p.phase + ':' + p.index))`,
  returnByValue: true,
});
console.log('\nprogress events:', prog.result.value);
ws.close();
process.exit(0);

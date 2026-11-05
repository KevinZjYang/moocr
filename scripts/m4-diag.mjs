/**
 * 抓当前页面的 DOM 概况与控制台错误，排查白屏。
 * 用法: node scripts/m4-diag.mjs [port]
 */
const PORT = process.argv[2] ?? '9222';
const BASE = `http://127.0.0.1:${PORT}`;

const targets = await (await fetch(`${BASE}/json/list`)).json();
const page = targets.find((t) => t.type === 'page' && !t.url.startsWith('devtools://'));
if (!page) throw new Error('no page');

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
});
let seq = 0;
const pending = new Map();
const logs = [];
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.method === 'Runtime.consoleAPICalled') {
    logs.push(`${msg.params.type}: ${msg.params.args.map((a) => a.value ?? a.description ?? a.type).join(' ')}`);
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    logs.push(`EXCEPTION: ${msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text}`);
  }
  if (msg.id && pending.has(msg.id)) {
    const { res } = pending.get(msg.id);
    pending.delete(msg.id);
    res(msg.result);
  }
};
const send = (method, params = {}) => {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((res) => pending.set(id, { res }));
};
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
  return r.result?.value;
};

await send('Runtime.enable');
await new Promise((r) => setTimeout(r, 600));

console.log('url:', page.url);
console.log('root children:', await ev(`document.getElementById('root')?.children.length`));
console.log('body len:', await ev(`document.body.innerHTML.length`));
console.log('aside:', await ev(`document.querySelector('aside') ? 'yes' : 'no'`));
console.log('toolbar buttons:', await ev(`document.querySelectorAll('.controls button').length`));
console.log('file items:', await ev(`document.querySelectorAll('.file').length`));

console.log('\n-- console --');
for (const l of logs.slice(-25)) console.log(l);

ws.close();
process.exit(0);

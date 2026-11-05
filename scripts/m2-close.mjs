/**
 * 通过 CDP 让 Electron 窗口正常关闭，用于验证 before-quit 是否收掉 sidecar。
 * 用法: node scripts/m2-close.mjs [cdpPort]
 */
const port = Number(process.argv[2] ?? 9222);
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = targets.find((t) => t.type === 'page');
if (!page) {
  console.log('没有 page target（窗口已关？）');
  process.exit(0);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
ws.addEventListener('message', () => {});
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
ws.send(JSON.stringify({ id: ++id, method: 'Runtime.evaluate', params: { expression: 'window.close()' } }));
await new Promise((r) => setTimeout(r, 1500));
console.log('已发送 window.close()');
ws.close();
process.exit(0);

import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
/**
 * 验证崩溃自愈：杀掉 sidecar 后继续识别，应自动重启并补完该页。
 * 用法: node scripts/m4-recover-check.mjs [port]
 */
import { execSync } from 'node:child_process';

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
const notices = [];
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.method === 'Runtime.consoleAPICalled') {
    // 不依赖 console；notice 走独立事件
  }
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
// 订阅 notice，验证自愈时有提示
await evalJs(`window.__notices = []; window.moocr.onNotice((n) => window.__notices.push(n)); true`);

const T = [{ label: 'ja-paragraph.png', path: path.join(ROOT, 'fixtures/synth/ja-paragraph.png') }];
const ident = () =>
  evalJs(`window.moocr.identify(${JSON.stringify({ targets: T, task: 'document', preset: 'standard', parallel: 1 })})`, true);

await evalJs('window.moocr.cacheClear()', true);

console.log('预热（建立 sidecar）…');
let r = await ident();
if (!r?.ok) throw new Error(`预热失败: ${r?.error}`);
console.log(`  ok · ${r.results[0].summary.chars} 字`);

await evalJs('window.moocr.cacheClear()', true);

console.log('强杀 llama-server.exe …');
try {
  execSync('taskkill /F /IM llama-server.exe', { stdio: 'pipe' });
} catch {
  // 可能已经没有进程
}
await new Promise((r) => setTimeout(r, 1500));

console.log('再次识别（应自动重启并完成）…');
const t0 = Date.now();
r = await ident();
const ms = Date.now() - t0;
if (!r?.ok) {
  console.error(`失败: ${r?.error}`);
  process.exit(1);
}
console.log(`  ok · ${r.results[0].summary.chars} 字 · ${ms} ms`);

const got = await evalJs('window.__notices ?? []');
console.log(`notices: ${JSON.stringify(got)}`);

// 渲染进程有 CSP（connect-src 只允许自身），不能直连 8090，改问主进程
const status = await evalJs('window.moocr.serverStatus()', true);
console.log(`serverStatus: ${JSON.stringify(status)}`);
const health = status?.running ? 200 : 0;

const issues = [];
if (r.results[0].summary.chars < 50) issues.push('识别结果异常短');
if (!Array.isArray(got) || !got.some((n) => String(n.text ?? '').includes('重启'))) issues.push('没有发出「已重启」提示');
if (health !== 200) issues.push(`sidecar 未恢复健康（${health}）`);

if (issues.length > 0) {
  console.error('\n失败:\n  ' + issues.join('\n  '));
  process.exit(1);
}
console.log('\nRECOVER OK');
process.exit(0);

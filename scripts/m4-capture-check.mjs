/**
 * M4 截图流程验证：触发 capture → 找到覆盖层 → 注入鼠标拖框 → 校验产物。
 * 用法: node scripts/m4-capture-check.mjs [port]
 */
import fs from 'node:fs';

const PORT = process.argv[2] ?? '9222';
const BASE = `http://127.0.0.1:${PORT}`;

async function connect(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
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
  return { ws, send, evalJs };
}

const list = async () => await (await fetch(`${BASE}/json/list`)).json();

const main = (await list()).find((t) => t.type === 'page' && /index\.html|127\.0\.0\.1:5183\/?$/.test(t.url));
if (!main) throw new Error('找不到主窗口 target');
console.log('main target:', main.url);

const M = await connect(main);
await M.send('Runtime.enable');

console.log('trigger capture…');
await M.evalJs(`window.__cap = null; window.moocr.capture().then(r => window.__cap = r); true`);

// 等覆盖层窗口出现
let overlay = null;
for (let i = 0; i < 60; i++) {
  await new Promise((r) => setTimeout(r, 250));
  const t = (await list()).find((x) => x.url.includes('overlay.html'));
  if (t) {
    overlay = t;
    break;
  }
}
if (!overlay) throw new Error('覆盖层窗口没出现');
console.log('overlay target:', overlay.url);

const O = await connect(overlay);
await O.send('Runtime.enable');
await new Promise((r) => setTimeout(r, 400));

const cfg = await O.evalJs(`window.overlay.config()`, true);
console.log(`overlay config: ${cfg?.width}x${cfg?.height} display=${cfg?.displayId} img=${(cfg?.imageDataUrl ?? '').length} chars`);
if (!cfg?.imageDataUrl?.startsWith('data:image/png;base64,')) throw new Error('覆盖层没拿到背景图');

const dpr = await O.evalJs(`window.devicePixelRatio`);

// 拖一个 400x300 的框
const x1 = 120;
const y1 = 140;
const x2 = x1 + 400;
const y2 = y1 + 300;

await O.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x1, y: y1, button: 'left', clickCount: 1 });
for (let i = 1; i <= 5; i++) {
  await O.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: x1 + ((x2 - x1) * i) / 5,
    y: y1 + ((y2 - y1) * i) / 5,
    button: 'left',
  });
}
const label = await O.evalJs(`document.getElementById('size')?.textContent`);
console.log('selection label:', label);

// 拖到一半时截一张，确认遮罩与冻结画面正常
{
  const shot = await O.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('docs/m4-overlay.png', Buffer.from(shot.data, 'base64'));
  console.log('overlay screenshot: docs/m4-overlay.png');
}

await O.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x2, y: y2, button: 'left', clickCount: 1 });

let cap = null;
for (let i = 0; i < 80; i++) {
  await new Promise((r) => setTimeout(r, 250));
  cap = await M.evalJs(`window.__cap`);
  if (cap) break;
}
if (!cap) throw new Error('capture 没有返回');
console.log('capture result:', JSON.stringify(cap));
if (!cap.ok) throw new Error(`capture failed: ${cap.error}`);

const st = fs.statSync(cap.path);
console.log(`file: ${cap.path} ${st.size} bytes`);

// 期望像素 = 选中 DIP × dpr（缩略图按同比例缩放）
const expectW = Math.round(400 * dpr);
const expectH = Math.round(300 * dpr);
console.log(`expect ≈ ${expectW}x${expectH} (dpr=${dpr})`);

// 用 sharp 之类没必要，读 PNG 头拿尺寸
const buf = fs.readFileSync(cap.path);
const w = buf.readUInt32BE(16);
const h = buf.readUInt32BE(20);
console.log(`png: ${w}x${h}`);

const tol = 2;
if (Math.abs(w - expectW) > tol || Math.abs(h - expectH) > tol) {
  throw new Error(`尺寸不符：实际 ${w}x${h}，期望 ${expectW}x${expectH}`);
}
if (st.size < 500) throw new Error('产物过小，可能是空图');

// 覆盖层应已关闭
await new Promise((r) => setTimeout(r, 300));
const stillOpen = (await list()).some((x) => x.url.includes('overlay.html'));
console.log('overlay closed:', !stillOpen);
if (stillOpen) throw new Error('覆盖层没关掉');

// UI 应该自动收下这张并识别（截图的意义就是截完就出结果）
console.log('\nwaiting for auto-identify…');
let autoDone = false;
for (let i = 0; i < 160; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  autoDone = await M.evalJs(`document.querySelectorAll('.file.done').length > 0`);
  if (autoDone) break;
}
const sidebar = await M.evalJs(`document.querySelectorAll('.file').length`);
const firstName = await M.evalJs(`document.querySelector('.file')?.innerText?.split('\\n')[0]`);
console.log(`sidebar items: ${sidebar}, first: ${firstName}, auto-identified: ${autoDone}`);
if (!autoDone) throw new Error('截图后没有自动识别');
if (!String(firstName ?? '').includes('截图')) throw new Error(`新项名字不对：${firstName}`);

console.log('\nCAPTURE OK');
process.exit(0);

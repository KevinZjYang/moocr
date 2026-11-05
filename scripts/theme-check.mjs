// 主题验证：浅色/深色/跟随系统各截一张，并读出实际生效的背景色
import fs from 'node:fs';

const PORT = process.argv[2] ?? '9250';

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => {
  ws.addEventListener('open', r, { once: true });
  ws.addEventListener('error', () => j(new Error('ws')), { once: true });
});

let seq = 0;
const pending = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data.toString());
  const p = pending.get(m.id);
  if (!p) return;
  pending.delete(m.id);
  m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
});

const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => pending.delete(id) && reject(new Error(`timeout ${method}`)), 90_000).unref?.();
  });

const js = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval');
  return r.result.value;
};

await send('Runtime.enable');
await send('Page.enable');
await send('Page.bringToFront');
await new Promise((r) => setTimeout(r, 400));

// 先识别两张图，让截图里有内容
if ((await js(`document.querySelectorAll('.file').length`)) > 0) {
  await js(`window.moocr.cacheClear()`);
  await js(`document.querySelector('.controls button.primary').click()`);
  for (let i = 0; i < 60; i++) {
    const done = await js(`document.querySelectorAll('.file.done').length`);
    if (done > 0) break;
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function probe(label) {
  const info = await js(`(() => {
    const cs = getComputedStyle(document.body);
    const root = document.documentElement;
    return {
      themeAttr: root.getAttribute('data-theme'),
      scheme: getComputedStyle(root).colorScheme,
      bg: cs.backgroundColor,
      text: cs.color,
      prefersDark: matchMedia('(prefers-color-scheme: dark)').matches,
    };
  })()`);
  console.log(label, JSON.stringify(info));
  return info;
}

async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  fs.writeFileSync(name, Buffer.from(r.data, 'base64'));
  console.log(`  → ${name} ${fs.statSync(name).size} B`);
}

// 深色
await js(`window.moocr.menuAction('theme-dark').catch(()=>{})`);
await js(`(() => { const b = [...document.querySelectorAll('.menu-title')].find(e => e.textContent === '视图'); b?.click(); return true; })()`);
await new Promise((r) => setTimeout(r, 200));
await js(`(() => { const b = [...document.querySelectorAll('.menu-item')].find(e => e.textContent.includes('主题 · 深色')); b?.click(); return !!b; })()`);
await new Promise((r) => setTimeout(r, 700));
await probe('dark   ');
await shot('docs/theme-dark.png');

// 浅色
await js(`(() => { const b = [...document.querySelectorAll('.menu-title')].find(e => e.textContent === '视图'); b?.click(); return true; })()`);
await new Promise((r) => setTimeout(r, 200));
await js(`(() => { const b = [...document.querySelectorAll('.menu-item')].find(e => e.textContent.includes('主题 · 浅色')); b?.click(); return !!b; })()`);
await new Promise((r) => setTimeout(r, 700));
await probe('light  ');
await shot('docs/theme-light.png');

// 浅色下打开菜单，确认菜单/勾选在浅底上可读
await js(`(() => { const b = [...document.querySelectorAll('.menu-title')].find(e => e.textContent === '视图'); b?.click(); return true; })()`);
await new Promise((r) => setTimeout(r, 300));
await shot('docs/theme-light-menu.png');

// 回到跟随系统
await js(`document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`);
await new Promise((r) => setTimeout(r, 150));
await js(`(() => { const b = [...document.querySelectorAll('.menu-title')].find(e => e.textContent === '视图'); b?.click(); return true; })()`);
await new Promise((r) => setTimeout(r, 200));
await js(`(() => { const b = [...document.querySelectorAll('.menu-item')].find(e => e.textContent.includes('主题 · 跟随系统')); b?.click(); return !!b; })()`);
await new Promise((r) => setTimeout(r, 700));
await probe('system ');
console.log('localStorage:', await js(`localStorage.getItem('moocr-theme')`));

ws.close();
process.exit(0);

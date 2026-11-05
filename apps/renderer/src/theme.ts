export type ThemeMode = 'system' | 'light' | 'dark';

const KEY = 'moocr-theme';

/** 读持久化的主题偏好，没存过或值不合法就跟随系统 */
export function readTheme(): ThemeMode {
  const v = localStorage.getItem(KEY);
  return v === 'light' || v === 'dark' ? v : 'system';
}

export function resolveTheme(mode: ThemeMode): 'light' | 'dark' {
  if (mode !== 'system') return mode;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/**
 * 把主题落到 DOM 上。'system' 时不设 data-theme，让 CSS 的 light-dark() 走
 * prefers-color-scheme；同时通知主进程改窗口按钮（标题栏按钮是系统画的，
 * CSS 管不到）。
 */
export function applyTheme(mode: ThemeMode): void {
  const root = document.documentElement;
  if (mode === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', mode);

  // color-scheme 由 CSS 负责（system 时是 light dark，自动跟随系统），
  // 这里只把结果告诉主进程，让它去改窗口按钮的颜色。
  void window.moocr?.setChromeTheme(resolveTheme(mode) === 'dark');
}

export function saveTheme(mode: ThemeMode): void {
  localStorage.setItem(KEY, mode);
}

import { useEffect, useRef, useState } from 'react';

export interface MenuEntry {
  kind?: 'item' | 'sep';
  label?: string;
  accel?: string;
  action?: string;
  /** 需要结果才能用的项（导出） */
  needsResult?: boolean;
  /** 当前选中项（主题） */
  checked?: boolean;
}

interface MenuGroup {
  id: string;
  label: string;
  items: MenuEntry[];
}

export type ThemeMode = 'system' | 'light' | 'dark';

const menuFor = (theme: ThemeMode): MenuGroup[] => [
  {
    id: 'file',
    label: '文件',
    items: [
      { label: '打开图片或 PDF…', accel: 'Ctrl+O', action: 'open' },
      { label: '截取屏幕区域…', accel: 'Ctrl+Shift+O', action: 'capture' },
      { kind: 'sep' },
      { label: '导出 Markdown', action: 'export-md', needsResult: true },
      { label: '导出 HTML', action: 'export-html', needsResult: true },
      { label: '导出 Word', action: 'export-docx', needsResult: true },
      { kind: 'sep' },
      { label: '清空列表', action: 'clear-list', needsResult: true },
      { label: '清空识别缓存', action: 'clear-cache' },
      { kind: 'sep' },
      { label: '退出', accel: 'Alt+F4', action: 'quit' },
    ],
  },
  {
    id: 'edit',
    label: '编辑',
    items: [
      { label: '撤销', accel: 'Ctrl+Z', action: 'edit-undo' },
      { label: '重做', accel: 'Ctrl+Shift+Z', action: 'edit-redo' },
      { kind: 'sep' },
      { label: '剪切', accel: 'Ctrl+X', action: 'edit-cut' },
      { label: '复制', accel: 'Ctrl+C', action: 'edit-copy' },
      { label: '粘贴', accel: 'Ctrl+V', action: 'edit-paste' },
      { label: '全选', accel: 'Ctrl+A', action: 'edit-selectall' },
    ],
  },
  {
    id: 'view',
    label: '视图',
    items: [
      { label: '重新加载', accel: 'Ctrl+R', action: 'reload' },
      { label: '开发者工具', accel: 'F12', action: 'devtools' },
      { kind: 'sep' },
      { label: '放大', accel: 'Ctrl+=', action: 'zoom-in' },
      { label: '缩小', accel: 'Ctrl+-', action: 'zoom-out' },
      { label: '实际大小', accel: 'Ctrl+0', action: 'zoom-reset' },
      { kind: 'sep' },
      { label: '全屏', accel: 'F11', action: 'fullscreen' },
      { kind: 'sep' },
      { label: '主题 · 跟随系统', action: 'theme-system', checked: theme === 'system' },
      { label: '主题 · 浅色', action: 'theme-light', checked: theme === 'light' },
      { label: '主题 · 深色', action: 'theme-dark', checked: theme === 'dark' },
    ],
  },
  {
    id: 'help',
    label: '帮助',
    items: [{ label: '关于墨客', action: 'about' }],
  },
];

export function MenuBar({
  onAction,
  hasResult,
  theme,
}: {
  onAction: (action: string) => void;
  hasResult: boolean;
  theme: ThemeMode;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const MENUS = menuFor(theme);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (barRef.current && !barRef.current.contains(e.target as Node)) setOpen(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(null);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const fire = (entry: MenuEntry) => {
    setOpen(null);
    if (entry.action && !(entry.needsResult && !hasResult)) onAction(entry.action);
  };

  return (
    <div className="titlebar" ref={barRef}>
      <div className="tb-brand">
        <span className="dot" />
        墨客
      </div>

      <nav className="menus">
        {MENUS.map((g) => (
          <div key={g.id} className={`menu-group${open === g.id ? ' open' : ''}`}>
            <button
              className="menu-title"
              onClick={() => setOpen((o) => (o === g.id ? null : g.id))}
              onMouseEnter={() => open && setOpen(g.id)}
            >
              {g.label}
            </button>
            {open === g.id && (
              <div className="menu-pop" role="menu">
                {g.items.map((it, i) =>
                  it.kind === 'sep' ? (
                    <div key={i} className="menu-sep" />
                  ) : (
                    <button
                      key={i}
                      className={`menu-item${it.checked ? ' checked' : ''}`}
                      role="menuitemradio"
                      aria-checked={it.checked}
                      disabled={it.needsResult && !hasResult}
                      onClick={() => fire(it)}
                    >
                      <span>
                        <span className="tick">{it.checked ? '✓' : ''}</span>
                        {it.label}
                      </span>
                      {it.accel && <span className="accel">{it.accel}</span>}
                    </button>
                  )
                )}
              </div>
            )}
          </div>
        ))}
      </nav>

      <div className="tb-drag" />
      <span className="tb-hint">Xiaomi-OCR-0 · 本地推理</span>
    </div>
  );
}

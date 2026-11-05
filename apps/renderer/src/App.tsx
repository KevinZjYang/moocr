import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MarkdownView } from './MarkdownView';
import { MenuBar, type ThemeMode } from './MenuBar';
import { renderPdf } from './pdf';
import { applyTheme, readTheme, saveTheme } from './theme';

interface PageTimings {
  wallMs: number;
  promptTokens: number | null;
  cachedTokens: number | null;
  predictedTokens: number | null;
  prefillTps: number | null;
  decodeTps: number | null;
}

interface Attempt {
  task: string;
  finishReason: string;
  chars: number;
  degenerated: boolean;
  wallMs: number;
}

interface PageResult {
  file: string;
  task: string;
  markdown: string;
  summary: { chars: number; lines: number; nonEmpty: number; headings: number; latexBlocks: number; inlineLatex: number; tables: number };
  timings: PageTimings;
  attempts: Attempt[];
  finishReason: string;
  degenerated: boolean;
  warnings: string[];
  json?: unknown;
}

interface Item {
  /** React key，也是识别时传给主进程的 label（必须唯一） */
  key: string;
  /** 原文件绝对路径（图片用于读图；PDF 页用于追溯来源） */
  path: string;
  /** 识别请求里的 label，result.file 会等于它 */
  label: string;
  name: string;
  pageNo?: number;
  dataUrl?: string;
  result?: PageResult;
  error?: string;
  status: 'idle' | 'loading' | 'running' | 'done' | 'error';
  /** 产出当前 result 时用的任务与预设，用来判断结果是否过期 */
  resultTask?: string;
  resultPreset?: string;
}

/** 结果不是用当前设置跑出来的 —— 界面要提示重跑 */
const isStale = (i: Item, task: string, preset: string): boolean =>
  i.status === 'done' && !!i.result && (i.resultTask !== task || i.resultPreset !== preset);

/** 待识别：没跑过、失败过、或结果过期 */
const isPending = (i: Item, task: string, preset: string): boolean =>
  i.status === 'idle' || i.status === 'error' || isStale(i, task, preset);

type ServerState = { state: string; preset?: string; message?: string; imageMaxTokens?: number };

const TASK_LABELS: Record<string, string> = {
  document: '整页文档',
  text: '纯文本',
  table: '表格',
  formula: '公式',
  kie: '关键信息',
};

const PRESET_HINTS: Record<string, string> = {
  fast: '1024 token · 印刷体轻页',
  standard: '2560 token · 默认',
  accurate: '6144 token · 手写/小字',
  extreme: '12288 token · 极密排',
};

const api = (window as unknown as { moocr: Record<string, any> }).moocr;

function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
}

function baseName(p: string): string {
  const seg = p.split(/[\\/]/);
  return seg[seg.length - 1] ?? p;
}

function stem(p: string): string {
  const n = baseName(p);
  const i = n.lastIndexOf('.');
  return i > 0 ? n.slice(0, i) : n;
}

export default function App(): JSX.Element {
  const [items, setItems] = useState<Item[]>([]);
  const [active, setActive] = useState(0);
  const [task, setTask] = useState('document');
  const [preset, setPreset] = useState('standard');
  const [parallel, setParallel] = useState(1);
  const [busy, setBusy] = useState(false);
  const [server, setServer] = useState<ServerState>({ state: 'idle' });
  const [caps, setCaps] = useState<{
    presets: { id: string; imageMaxTokens: number }[];
    tasks: string[];
    kieSchema: Record<string, unknown>;
    hasRuntime: boolean;
  } | null>(null);
  const [progress, setProgress] = useState<{ index: number; total: number; file: string; done?: boolean } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  const [schemaText, setSchemaText] = useState('');
  const [showSchema, setShowSchema] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const [theme, setTheme] = useState<ThemeMode>(readTheme);

  useEffect(() => {
    applyTheme(theme);
    saveTheme(theme);
  }, [theme]);

  // 跟随系统时，系统换主题要重算一次（窗口按钮颜色得手动同步）
  useEffect(() => {
    if (theme !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const on = () => applyTheme('system');
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [theme]);
  const dragRef = useRef(false);
  /** 新增项想让它成为当前选中项；等 items 更新后再定位，避免索引错位 */
  const pendingFocus = useRef<string | null>(null);

  useEffect(() => {
    void api.capabilities().then((c: typeof caps) => {
      setCaps(c);
      if (c?.kieSchema) setSchemaText(JSON.stringify(c.kieSchema, null, 2));
    });
    const offA = api.onServerState((s: ServerState) => setServer(s));
    const offB = api.onProgress((p: { index: number; total: number; file: string; phase: string }) => {
      // 主进程按完成顺序回传，用 index 只是定位，进度条按已完成张数走
      if (p.phase === 'done') setProgress({ index: p.index, total: p.total, file: p.file, done: true });
      else setProgress({ index: p.index, total: p.total, file: p.file, done: false });
    });
    const offC = api.onMenuOpen(() => void pickFiles());
    return () => {
      offA();
      offB();
      offC();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setItem = useCallback((key: string, patch: Partial<Item>) => {
    setItems((prev) => prev.map((i) => (i.key === key ? { ...i, ...patch } : i)));
  }, []);

  const addPaths = useCallback(
    async (paths: string[]) => {
      if (!paths.length) return;
      const images = paths.filter((p) => !/\.pdf$/i.test(p));
      const pdfs = paths.filter((p) => /\.pdf$/i.test(p));

      const fresh: Item[] = images.map((p) => ({
        key: p,
        path: p,
        label: p,
        name: baseName(p),
        status: 'idle',
      }));
      setItems((prev) => {
        const seen = new Set(prev.map((i) => i.key));
        return [...prev, ...fresh.filter((f) => !seen.has(f.key))];
      });

      for (const item of fresh) {
        const r = await api.readImage(item.path);
        if (r.ok) setItem(item.key, { dataUrl: r.dataUrl });
      }

      for (const p of pdfs) {
        setLoading(`解析 PDF：${baseName(p)}`);
        try {
          const r = await api.readPdf(p);
          if (!r.ok) {
            setNotice(`${baseName(p)}：${r.error}`);
            continue;
          }
          const pages = await renderPdf(r.data, {
            maxEdge: 1600,
            onPage: (n, total) => setLoading(`渲染 ${baseName(p)} 第 ${n}/${total} 页`),
          });
          const pageItems: Item[] = pages.map((pg) => ({
            key: `${p}#${pg.pageNo}`,
            path: p,
            label: `${baseName(p)} p${pg.pageNo}`,
            name: `${baseName(p)} · p${pg.pageNo}`,
            pageNo: pg.pageNo,
            dataUrl: pg.dataUrl,
            status: 'idle',
          }));
          setItems((prev) => {
            const seen = new Set(prev.map((i) => i.key));
            return [...prev, ...pageItems.filter((f) => !seen.has(f.key))];
          });
        } catch (e) {
          setNotice(`PDF 渲染失败：${(e as Error).message}`);
        } finally {
          setLoading(null);
        }
      }
    },
    [setItem]
  );

  // 主进程缓存了命令行文件，挂载完主动取一次（不取就丢了）
  useEffect(() => {
    void api.claimArgv().then((paths) => {
      if (paths.length > 0) void addPaths(paths);
    });
  }, [addPaths]);

  // 命令行参数 / 「用 moocr 打开」传来的路径
  useEffect(() => {
    const off = api.onOpenPaths((paths: string[]) => void addPaths(paths));
    return off;
  }, [addPaths]);

  const pickFiles = useCallback(async () => {
    const paths = await api.openFiles();
    await addPaths(paths);
  }, [addPaths]);

  const onDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      dragRef.current = false;
      const paths: string[] = [];
      for (const f of Array.from(e.dataTransfer.files)) {
        const p = api.pathForFile?.(f);
        if (p) paths.push(p);
      }
      if (paths.length === 0) {
        setNotice('拖拽拿不到文件路径，请用「打开文件」按钮');
        return;
      }
      await addPaths(paths);
    },
    [addPaths]
  );

  const run = useCallback(
    async (only?: Item[]) => {
      if (busy) return;
      // 无参时只跑待识别的；显式传入（截图后自动识别、单文件重跑）就照单执行
      const targets = (only ?? items.filter((i) => isPending(i, task, preset))).filter((i) => i.status !== 'running');
      if (targets.length === 0) return;

      let kieSchema: string | undefined;
      if (task === 'kie' && schemaText.trim()) {
        try {
          JSON.parse(schemaText);
          kieSchema = schemaText;
        } catch {
          setNotice('KIE schema 不是合法 JSON');
          setShowSchema(true);
          return;
        }
      }

      const targetKeys = new Set(targets.map((t) => t.key));
      /** 结果回来时按 label 找回对应的 item key，避免依赖数组下标 */
      const keyByLabel = new Map(targets.map((t) => [t.label, t.key]));

      setBusy(true);
      setNotice(null);
      setItems((prev) =>
        prev.map((i) =>
          targetKeys.has(i.key) ? { ...i, status: 'running' as const, error: undefined } : i
        )
      );

      try {
        const res = await api.identify({
          targets: targets.map((t) => ({
            label: t.label,
            path: t.pageNo ? undefined : t.path,
            imageUri: t.dataUrl,
          })),
          task,
          preset,
          parallel,
          kieSchema,
        });

        if (!res.ok) {
          setNotice(res.error);
          setItems((prev) =>
            prev.map((i) => (targetKeys.has(i.key) ? { ...i, status: 'error', error: res.error } : i))
          );
          return;
        }
        const byLabel = new Map<string, PageResult>();
        for (const r of res.results as PageResult[]) byLabel.set(r.file, r);
        setItems((prev) =>
          prev.map((i) => {
            const key = keyByLabel.get(i.label);
            if (!key || key !== i.key) return i;
            const r = byLabel.get(i.label);
            return r
              ? { ...i, result: r, status: 'done' as const, resultTask: task, resultPreset: preset, error: undefined }
              : i;
          })
        );
      } catch (err) {
        const msg = (err as Error).message;
        setNotice(msg);
        setItems((prev) =>
          prev.map((i) => (targetKeys.has(i.key) ? { ...i, status: 'error', error: msg } : i))
        );
      } finally {
        // 任何路径都要解除 busy，否则一次异常会让「识别」按钮永久失效。
        setBusy(false);
        setProgress(null);
      }
    },
    [busy, items, task, preset, parallel, schemaText]
  );

  // 截图完成：加入列表并立刻识别这一张
  useEffect(() => {
    const off = api.onCapture((c) => {
      void (async () => {
        const name = `截图 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`;
        const item: Item = { key: c.path, path: c.path, label: c.path, name, status: 'idle' };
        const r = await api.readImage(c.path);
        const withData: Item = r.ok ? { ...item, dataUrl: r.dataUrl } : item;
        setItems((prev) => (prev.some((i) => i.key === withData.key) ? prev : [...prev, withData]));
        pendingFocus.current = withData.key;
        if (withData.dataUrl) await run([withData]);
        else setNotice(`${name}：读取失败，可直接点识别重试`);
      })();
    });
    return off;
  }, [run]);

  useEffect(() => {
    return api.onNotice((n) => setNotice(n.text));
  }, []);

  useEffect(() => {
    if (!pendingFocus.current) return;
    const idx = items.findIndex((i) => i.key === pendingFocus.current);
    if (idx >= 0) {
      setActive(idx);
      pendingFocus.current = null;
    }
  }, [items]);

  const doneItems = useMemo(() => items.filter((i) => i.status === 'done' && i.result), [items]);
  const pendingCount = useMemo(() => items.filter((i) => isPending(i, task, preset)).length, [items, task, preset]);
  const current = items[active];
  const result = current?.result;
  const currentStale = current ? isStale(current, task, preset) : false;

  const removeItem = useCallback((key: string) => {
    setItems((prev) => {
      const next = prev.filter((i) => i.key !== key);
      setActive((a) => {
        const idx = prev.findIndex((i) => i.key === key);
        if (idx < 0) return a;
        // 删掉的是当前项或它前面的项，索引要跟着挪
        if (idx < a) return a - 1;
        if (idx === a) return Math.max(0, Math.min(a, next.length - 1));
        return a;
      });
      return next;
    });
  }, []);

  const clearAll = useCallback(() => {
    setItems((prev) => {
      if (prev.length > 0) setNotice(`已清空 ${prev.length} 项`);
      return [];
    });
    setActive(0);
    setProgress(null);
  }, []);

  const doExport = useCallback(
    async (format: 'md' | 'html' | 'docx') => {
      setExportOpen(false);
      const pages = doneItems.map((i) => ({ label: i.name, markdown: i.result!.markdown }));
      if (pages.length === 0) {
        setNotice('还没有识别结果可导出');
        return;
      }
      const defaultName =
        doneItems.length === 1 ? stem(doneItems[0].name) : `moocr-${doneItems.length}pages`;
      const r = await api.export({ format, pages, defaultName });
      if (r.ok) {
        setNotice(`已导出 ${r.path}`);
      } else if (!r.canceled) {
        setNotice(`导出失败：${r.error ?? '未知错误'}`);
      }
    },
    [doneItems]
  );

  /** 自绘菜单的动作分发：需要界面状态的自己处理，其余交给主进程 */
  const onMenuAction = useCallback(
    (action: string) => {
      switch (action) {
        case 'open':
          void pickFiles();
          break;
        case 'capture':
          void api.capture();
          break;
        case 'export-md':
          void doExport('md');
          break;
        case 'export-html':
          void doExport('html');
          break;
        case 'export-docx':
          void doExport('docx');
          break;
        case 'clear-list':
          clearAll();
          break;
        case 'theme-system':
        case 'theme-light':
        case 'theme-dark':
          setTheme(action.slice('theme-'.length) as ThemeMode);
          break;
        default:
          void api.menuAction(action);
      }
    },
    [pickFiles, doExport, clearAll]
  );

  const meta = useMemo(() => {
    if (!result) return null;
    const t = result.timings;
    // 缓存命中时 timings 是首次识别的，报出来会误导，只留字数
    if (result.cached) {
      return [`缓存命中`, `${result.summary.chars} 字`, result.summary.tables ? `${result.summary.tables} 表` : null].filter(
        Boolean
      ) as string[];
    }
    return [
      `总耗时 ${fmtMs(t.wallMs)}`,
      t.promptTokens !== null
        ? `输入 ${t.promptTokens} tok${t.cachedTokens ? `（缓存 ${t.cachedTokens}）` : ''}`
        : null,
      t.predictedTokens !== null ? `输出 ${t.predictedTokens} tok` : null,
      t.prefillTps !== null ? `prefill ${Math.round(t.prefillTps)} tok/s` : null,
      t.decodeTps !== null ? `decode ${Math.round(t.decodeTps)} tok/s` : null,
      `${result.summary.chars} 字`,
      result.summary.tables ? `${result.summary.tables} 表` : null,
      result.attempts.length > 1 ? `重试 ${result.attempts.length - 1} 次` : null,
    ].filter(Boolean) as string[];
  }, [result]);

  return (
    <div className="app">
      <MenuBar onAction={onMenuAction} hasResult={doneItems.length > 0} theme={theme} />

      <header className="toolbar">
        <div className="controls">
          <label>
            任务
            <select value={task} onChange={(e) => setTask(e.target.value)}>
              {(caps?.tasks ?? Object.keys(TASK_LABELS)).map((t) => (
                <option key={t} value={t}>
                  {TASK_LABELS[t] ?? t}
                </option>
              ))}
            </select>
          </label>

          <label>
            预设
            <select value={preset} onChange={(e) => setPreset(e.target.value)}>
              {(caps?.presets ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.id} — {PRESET_HINTS[p.id] ?? `${p.imageMaxTokens} token`}
                </option>
              ))}
            </select>
          </label>

          <label>
            并发
            <select
              value={parallel}
              onChange={(e) => setParallel(Number(e.target.value))}
              title="实测：短页并发无收益（固定开销主导），长输出/大页才有 1.6 倍左右"
            >
              <option value={1}>1 — 默认</option>
              <option value={2}>2 — 大页/长表格</option>
              <option value={4}>4 — 大批量大页，约 8G 显存</option>
            </select>
          </label>

          {task === 'kie' && (
            <button className="ghost" onClick={() => setShowSchema((v) => !v)}>
              {showSchema ? '收起 schema' : '字段 schema'}
            </button>
          )}

          <button
            className="primary"
            onClick={() => void run()}
            disabled={busy || items.length === 0 || pendingCount === 0}
            title={
              items.length === 0
                ? '还没有打开文件'
                : pendingCount === 0
                  ? '所有文件都是当前设置的结果'
                  : `只识别 ${pendingCount} 个待处理文件`
            }
          >
            {busy ? '识别中…' : pendingCount === 0 && items.length > 0 ? '已是最新' : items.length === 0 ? '识别' : `识别 ${pendingCount}`}
          </button>

          <button onClick={() => void pickFiles()} disabled={busy || !!loading}>
            打开文件
          </button>

          <button className="ghost" title="Ctrl+Shift+O" onClick={() => void api.capture()} disabled={!!loading}>
            截屏
          </button>

          <div className="dropdown">
            <button onClick={() => setExportOpen((v) => !v)} disabled={doneItems.length === 0}>
              导出 ▾
            </button>
            {exportOpen && (
              <div className="menu">
                <button onClick={() => void doExport('md')}>Markdown (.md)</button>
                <button onClick={() => void doExport('html')}>HTML (.html)</button>
                <button onClick={() => void doExport('docx')}>Word (.docx)</button>
              </div>
            )}
          </div>
        </div>

        <div className={`server ${server.state}`}>
          {server.state === 'idle' && '服务未启动'}
          {server.state === 'starting' && (server.message ?? '加载模型…')}
          {server.state === 'restarting' && '切换预设，重启服务…'}
          {server.state === 'ready' && `服务就绪 · ${server.preset}`}
        </div>
      </header>

      {caps && !caps.hasRuntime && (
        <div className="banner error">
          缺少模型权重：<code>resources/models/Xiaomi-OCR-0.Q4_K_M.gguf</code> 与 <code>Xiaomi-OCR-0.mmproj-bf16.gguf</code>。
          源码运行用 <code>npm run fetch</code> 下载，或<button
            className="inline-action"
            onClick={() => void api.openModelsDir().then((r) => setNotice(r.ok ? `已打开模型目录：${r.path}` : `打开失败：${r.error}`))}
          >
            打开模型目录
          </button>
          手动放入。
        </div>
      )}
      {notice && <div className="banner warn">{notice}</div>}

      {showSchema && task === 'kie' && (
        <div className="schema-panel">
          <div className="schema-head">
            <span>KIE 字段 schema（JSON，模型会照此结构输出）</span>
            <button className="ghost" onClick={() => setShowSchema(false)}>
              关闭
            </button>
          </div>
          <textarea
            value={schemaText}
            onChange={(e) => setSchemaText(e.target.value)}
            spellCheck={false}
            rows={10}
          />
        </div>
      )}

      <main
        onDragOver={(e) => {
          e.preventDefault();
          dragRef.current = true;
        }}
        onDrop={onDrop}
      >
        <aside className="files">
          {items.length === 0 && (
            <div className="empty">
              <p>拖入图片或 PDF，或点「打开文件」</p>
              <p className="hint">支持 png / jpg / webp / bmp / tiff / pdf</p>
            </div>
          )}
          {items.map((it, i) => {
            const stale = isStale(it, task, preset);
            return (
              <div
                key={it.key}
                className={`file ${i === active ? 'active' : ''} ${it.status}`}
                onClick={() => setActive(i)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setActive(i);
                  }
                }}
                role="button"
                tabIndex={0}
                title={it.path}
              >
                <span className="thumb">
                  {it.dataUrl ? <img src={it.dataUrl} alt="" /> : <span className="ph">{it.name.slice(0, 1)}</span>}
                </span>
                <span className="info">
                  <span className="name">{it.name}</span>
                  <span className={`status${stale ? ' stale' : ''}`}>
                    {it.status === 'running'
                      ? '识别中'
                      : it.error
                        ? '失败'
                        : it.status === 'done' && it.result
                          ? `${stale ? '需重跑 · ' : ''}${it.result.summary.chars} 字`
                          : '待识别'}
                  </span>
                </span>
                <span className="acts">
                  <button
                    title="重新识别这一页"
                    disabled={busy && it.status === 'running'}
                    onClick={(e) => {
                      e.stopPropagation();
                      void run([it]);
                    }}
                  >
                    ↻
                  </button>
                  <button
                    title="从列表移除"
                    onClick={(e) => {
                      e.stopPropagation();
                      removeItem(it.key);
                    }}
                  >
                    ×
                  </button>
                </span>
              </div>
            );
          })}
        </aside>

        <section className="preview">
          {current?.dataUrl ? (
            <img src={current.dataUrl} alt={current.name} />
          ) : (
            <div className="empty">{current ? '加载预览…' : '没有选中文件'}</div>
          )}
          {loading && <div className="progress">{loading}</div>}
          {progress && (
            <div className="progress">
              {progress.index + 1}/{progress.total} · {baseName(progress.file)}
            </div>
          )}
        </section>

        <section className="result">
          {!result && <div className="empty">{busy ? '识别中…' : '识别结果会显示在这里'}</div>}
          {result && (
            <>
              {currentStale && (
                <div className="banner warn">
                  这份结果用的是 {current?.resultPreset} / {TASK_LABELS[current?.resultTask ?? ''] ?? current?.resultTask}
                  ，与当前设置（{preset} / {TASK_LABELS[task]}）不同。
                  <button className="inline-action" onClick={() => current && void run([current])}>
                    按当前设置重跑
                  </button>
                </div>
              )}
              <div className="meta">{meta?.map((m) => <span key={m}>{m}</span>)}</div>
              {result.warnings.length > 0 && (
                <ul className="warnings">
                  {result.warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              )}
              {result.json !== undefined && (
                <div className="json-actions">
                  <button className="ghost" onClick={() => setShowRaw((v) => !v)}>
                    {showRaw ? '显示 JSON' : '显示原文'}
                  </button>
                  <button className="ghost" onClick={() => void navigator.clipboard.writeText(JSON.stringify(result.json, null, 2))}>
                    复制 JSON
                  </button>
                </div>
              )}
              <div className="md-scroll">
                {result.json !== undefined && !showRaw ? (
                  <pre className="json">{JSON.stringify(result.json, null, 2)}</pre>
                ) : (
                  <MarkdownView markdown={result.markdown} />
                )}
              </div>
            </>
          )}
        </section>
      </main>
    </div>
  );
}

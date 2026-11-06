/**
 * 运行时就绪向导 / 设置面板。
 *
 * 首次启动缺少权重时自动弹出；装好之后从「帮助 → 运行时与模型…」还能回来
 * 重新下载、导入离线文件或清理磁盘。
 */
import { useMemo } from 'react';

export interface RuntimeComponentView {
  id: 'llama' | 'model' | 'mmproj';
  label: string;
  present: boolean;
  path?: string;
  bytes?: number;
  expectedBytes?: number;
  source?: 'env' | 'user' | 'bundled' | 'legacy';
  note?: string;
}

export interface RuntimeStatusView {
  ready: boolean;
  components: RuntimeComponentView[];
  missing: string[];
  modelsDir: string;
  llamaBinDir: string;
  totalBytes: number;
  llamaVersion: string;
}

export interface RuntimeProgressView {
  phase: 'connecting' | 'downloading' | 'verifying' | 'extracting' | 'done' | 'paused' | 'error';
  componentId?: 'llama' | 'model' | 'mmproj';
  file?: string;
  received: number;
  total: number;
  bps: number;
  etaMs: number | null;
  overallReceived: number;
  overallTotal: number;
  message?: string;
}

const SOURCE_LABELS: Record<string, string> = {
  env: '环境变量',
  user: '用户目录',
  bundled: '随安装包',
  legacy: '旧版目录',
};

const PHASE_LABELS: Record<string, string> = {
  connecting: '连接中',
  downloading: '下载中',
  verifying: '校验中',
  extracting: '解压中',
  done: '完成',
  paused: '已暂停',
  error: '出错',
};

function fmtBytes(n: number | undefined): string {
  if (!n || n <= 0) return '—';
  if (n >= 1000 ** 3) return `${(n / 1000 ** 3).toFixed(2)} GB`;
  if (n >= 1000 ** 2) return `${(n / 1000 ** 2).toFixed(1)} MB`;
  return `${Math.round(n / 1000)} KB`;
}

function fmtEta(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `约 ${s} 秒`;
  return `约 ${Math.floor(s / 60)} 分 ${s % 60} 秒`;
}

export interface RuntimePanelProps {
  status: RuntimeStatusView | null;
  progress: RuntimeProgressView | null;
  starting: boolean;
  onStart: () => void;
  onPause: () => void;
  onImport: () => void;
  onOpenDir: () => void;
  onReset: (kind: 'models' | 'all') => void;
  onClose: () => void;
  onRetry: () => void;
}

export function RuntimePanel(props: RuntimePanelProps): JSX.Element {
  const { status, progress, starting, onStart, onPause, onImport, onOpenDir, onReset, onClose, onRetry } = props;

  const overall = useMemo(() => {
    if (!status) return { received: 0, total: 0 };
    const total = status.totalBytes;
    const received = status.components
      .filter((c) => c.id !== 'llama')
      .reduce((n, c) => n + (c.present ? c.expectedBytes ?? c.bytes ?? 0 : 0), 0);
    return { received, total };
  }, [status]);

  const active = progress && progress.phase !== 'done' ? progress : null;
  const pct = active && active.overallTotal > 0 ? Math.min(100, (active.overallReceived / active.overallTotal) * 100) : 0;
  const failed = progress?.phase === 'error';
  const paused = progress?.phase === 'paused';
  const running = Boolean(active) || starting;

  return (
    <div className="modal-scrim" role="dialog" aria-modal="true" aria-label="运行时与模型">
      <div className="modal runtime-panel">
        <header className="modal-head">
          <div>
            <h2>运行时与模型</h2>
            <p className="modal-sub">
              墨客需要 llama.cpp 推理后端和 Xiaomi-OCR-0 权重，全部在本机运行。
            </p>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </header>

        {status?.ready ? (
          <div className="banner ok">
            运行时就绪，可以开始识别。模型加载首次约 8–10 秒，之后常驻显存。
          </div>
        ) : (
          <div className="banner warn">
            还缺 {status?.missing.length ?? 3} 个文件。点「一键下载」后约 700 MB，支持断点续传。
          </div>
        )}

        <ul className="runtime-list">
          {(status?.components ?? []).map((c) => {
            const isActive = active?.componentId === c.id;
            const p = isActive && c.expectedBytes ? Math.min(100, (active!.received / c.expectedBytes) * 100) : 0;
            return (
              <li key={c.id} className={`runtime-row ${c.present ? 'present' : 'missing'}`}>
                <div className="runtime-row-main">
                  <span className={`dot ${c.present ? 'ok' : 'missing'}`} />
                  <div className="runtime-row-text">
                    <strong>{c.label}</strong>
                    <span className="muted">
                      {fmtBytes(c.expectedBytes)}
                      {c.present && c.source ? ` · 来自${SOURCE_LABELS[c.source] ?? c.source}` : ''}
                      {c.note ? ` · ${c.note}` : ''}
                    </span>
                  </div>
                  {isActive && <span className="runtime-pct">{p.toFixed(0)}%</span>}
                </div>
                {isActive && (
                  <div className="bar slim">
                    <span style={{ width: `${p}%` }} />
                  </div>
                )}
              </li>
            );
          })}
        </ul>

        {active && (
          <div className="runtime-progress">
            <div className="bar">
              <span style={{ width: `${pct}%` }} />
            </div>
            <div className="runtime-progress-meta">
              <span>
                {PHASE_LABELS[active.phase] ?? active.phase}
                {active.file ? ` · ${active.file}` : ''}
              </span>
              <span>
                {fmtBytes(active.overallReceived)} / {fmtBytes(active.overallTotal)}
                {active.phase === 'downloading' && active.bps > 0
                  ? ` · ${fmtBytes(active.bps)}/s · ${fmtEta(active.etaMs)}`
                  : ''}
              </span>
            </div>
          </div>
        )}

        {failed && <div className="banner error">{progress?.message ?? '下载失败'}。可重试，已下载部分会保留。</div>}
        {paused && <div className="banner warn">已暂停，下次继续会从断点续传。</div>}

        {!active && !starting && (
          <div className="runtime-summary muted">
            权重总大小 {fmtBytes(status?.totalBytes)}
            {overall.received > 0 ? `（已就位 ${fmtBytes(overall.received)}）` : ''} ·
            llama.cpp {status?.llamaVersion ?? 'b12110'}
            {status?.modelsDir ? ` · 模型目录 ${status.modelsDir}` : ''}
          </div>
        )}

        <footer className="modal-actions">
          {running ? (
            <button onClick={onPause} disabled={!active}>暂停</button>
          ) : status?.ready ? (
            <button className="primary" onClick={onClose}>开始使用</button>
          ) : (
            <button className="primary" onClick={failed || paused ? onRetry : onStart}>
              {failed ? '重试' : paused ? '继续下载' : '一键下载'}
            </button>
          )}
          <button className="ghost" onClick={onImport} disabled={running}>
            导入本地文件…
          </button>
          <button
            className="ghost"
            onClick={onOpenDir}
            title="把已下载的 .gguf 放进这个目录，再点「导入本地文件」"
          >
            打开模型目录
          </button>
          <span className="spacer" />
          {status && status.components.some((c) => c.source === 'user') && !running && (
            <button className="ghost danger" onClick={() => onReset('models')}>
              删除已下载权重
            </button>
          )}
        </footer>

        <p className="modal-foot muted">
          模型 Xiaomi-OCR-0（Apache-2.0）· 推理 llama.cpp（MIT）· 全程离线，不上传任何图片。
        </p>
      </div>
    </div>
  );
}

# M6 · 安装包与运行时下载

0.1.0 发的是 `dir` 压缩包，权重不在包里：用户装完看到「缺少运行时资产 … 请先执行 bash scripts/m0-fetch.sh」，而 `bash` 是给源码开发者用的。0.2.0 把这条链路补完：**装完即用，第一次启动在应用内下载权重**。

## 1. 资产放在哪

安装目录在 `Program Files` 下，只读；权重 700 MB，也不该塞进安装包。所以拆成两类：

| 资产 | 位置 | 谁写 |
|---|---|---|
| llama.cpp Vulkan 二进制（约 36 MB 压缩 / 85 MB 解压） | `<安装目录>/resources/runtime/llama/bin/` | 安装包 |
| 模型权重（529 MB + 207 MB） | `%APPDATA%/moocr/runtime/models/` | 应用内下载 / 导入 |
| sidecar pid 记录 | `%APPDATA%/moocr/state/` | 运行时 |
| 下载与探活日志 | `%APPDATA%/moocr/logs/runtime.log` | 运行时 |

解压后不再有 `resources/resources/...` 这种双层路径：打包时 `extraResources` 直接把 `resources/llama/bin` 映射到 `runtime/llama/bin`。

### 解析顺序

按**组件**解析，不要求 llama 与权重来自同一处（旧版用户可能只缺权重）：

1. `MOOCR_RUNTIME_DIR`（调试/便携用，子目录仍是 `llama/bin`、`models`）
2. `%APPDATA%/moocr/runtime`（应用内下载）
3. 应用内置：打包版 `<resourcesPath>/runtime`，开发版仓库 `resources/`
4. 0.1.0 旧落点：`<resourcesPath>/resources/models`、`<resourcesPath>/models`（只读探测）

启动时只 `stat` 比大小，不算 sha256——700 MB 全量哈希会让每次启动多几秒。哈希只在下载完成、手动导入、或用户点「重新校验」时算。

## 2. 清单是唯一事实源

`packages/runtime/runtime-manifest.json`：

```json
{
  "schemaVersion": 1,
  "llama": {
    "version": "b12110",
    "archives": {
      "win32-x64": { "url": "https://github.com/.../llama-b12110-bin-win-vulkan-x64.zip",
                     "mirrors": [], "bytes": 37661146, "sha256": "9732a5e4..." }
    }
  },
  "models": [
    { "id": "model", "file": "Xiaomi-OCR-0.Q4_K_M.gguf", "bytes": 529297664,
      "sha256": "1e497ff0...", "url": "https://huggingface.co/...", "mirrors": ["https://hf-mirror.com/..."] }
  ],
  "license": { "name": "Apache-2.0", "url": "https://huggingface.co/xiaomi-research/Xiaomi-OCR-0" },
  "totalBytes": 736644288
}
```

- `npm run fetch`（开发者）与应用内下载读同一份清单，不会出现「脚本能下、应用找不到」。
- 换模型：把新 gguf 放进 `resources/models/`，跑 `npm run runtime:manifest` 重算大小与 sha256。
- `npm run runtime:manifest -- --check` 在 CI/发版前比对，清单漂移直接失败。
- `npm run verify:assets` 校验清单结构、URL、总大小、当前平台归档和 `llama-server.exe` 是否存在。

## 3. 下载器

`packages/runtime/src/download.ts`：

- 写 `<dest>.part`，用 `Range: bytes=N-` 续传；服务器返回 200（不支持 Range）则从头写。
- 每个 URL 2 次尝试，失败换镜像；整轮再重试，最多 3 轮。GitHub 直连失败时 `mirrors` 兜底。
- 30 秒没有新字节就中断，避免半死连接挂住 UI。
- 完成后先比字节数、再算 sha256，通过才 `fsync` + 原子改名；不通过删掉 `.part` 重下。
- 预检磁盘：`statfs` 要求剩余空间 ≥ 本次总量 + 200 MB。
- 暂停是 `AbortController`：保留 `.part`，下次「继续」从断点接上。

界面进度包含单文件与总体两层（`received/total`、`overallReceived/overallTotal`），速度与 ETA 由 500 ms 滑动窗口估算。安装器是单例，重复点「下载」不会并发两份。

## 4. 首次启动流程

1. 主进程启动，`RuntimeService` 解析组件 → `capabilities.runtime`。
2. `ready=false` 时渲染进程自动打开「运行时就绪向导」，同时保留一条顶部横幅。
3. 点「一键下载」→ `runtime-start` → 下载 → 校验 → 解压 → `llama-server --version` 探活。
4. 状态变 `ready` → 主进程后台 `ensureServer('standard', 1)` 预热，用户点「识别」时模型已加载。
5. 关掉向导后横幅变成「运行时未就绪」，识别按钮禁用；「帮助 → 运行时与模型…」可随时回来。

也可以「导入本地文件」：选两个 gguf，按文件名或大小匹配清单项，校验 sha256 后复制到 `runtime/models`。适合内网机器或已有权重的用户。

「删除已下载权重」只删 `runtime/models` 与 `.part`；「全部重置」额外删 `runtime/llama` 与下载缓存。

失败时写 `%APPDATA%/moocr/logs/runtime.log`，向导里显示原始错误（断网、磁盘不足、代理拦截、sha 不符）。

## 5. 打包

`package.json`：

- `directories.buildResources = "assets"`，图标 `assets/icon.ico`（16–256 多尺寸，`node scripts/make-icon.mjs` 生成）。
- `extraResources` 只带 `resources/llama/bin → runtime/llama/bin`，不带权重。
- `win.target = nsis x64`，产物 `release/moocr-0.2.0-setup-x64.exe`。
- NSIS：非一键安装、可选目录、当前用户安装（不需要管理员）、桌面与开始菜单快捷方式 `墨客 moocr`、卸载保留用户数据。

体积：安装包约 100–130 MB（Electron + llama 二进制），装完约 400 MB；权重下载后另占 702 MB。

## 6. 代码位置

| 文件 | 职责 |
|---|---|
| `packages/runtime/src/paths.ts` | 组件候选顺序、按大小判定 present、`RuntimeStatus` |
| `packages/runtime/src/verify.ts` | sha256、文件校验、`llama-server` 探活 |
| `packages/runtime/src/download.ts` | 断点续传、镜像、超时、校验、原子落盘 |
| `packages/runtime/src/archive.ts` | zip 解压（Windows `tar -xf`，回退 `unzip`） |
| `packages/runtime/src/installer.ts` | 单例安装器、暂停/继续、导入、重置、`.runtime.json` |
| `apps/desktop/src/runtime-service.ts` | 把 Electron 路径接到上面这层，暴露给 IPC |
| `apps/renderer/src/RuntimePanel.tsx` | 向导 UI |

IPC：`runtime-status` / `runtime-start` / `runtime-pause` / `runtime-import` / `runtime-reset` / `runtime-open-dir`，事件 `runtime-progress`、`runtime-state`。

## 7. 已知限制

- 只做了 Windows x64 的 NSIS；macOS 仍缺 Vulkan 后端，Linux 只有源码路径。
- 没有自动更新；升级安装包不会动 `%APPDATA%/moocr/runtime`，已下载权重可复用。
- 安装包未签名，SmartScreen 会拦一次。
- 下载没有代理设置界面，继承系统代理；企业代理需要用户自行配置环境变量。
- 校验失败只重试，不做分段纠错；大文件在极差网络下可能反复重下。

## 这一版变了什么

0.1.0 发的是免安装目录压缩包：装完还缺权重，得自己开终端跑 `bash scripts/m0-fetch.sh`，路径还指到了 `resources/resources/models`。0.2.0 把这段补完——**下载 setup、双击安装、第一次启动点一下下载，之后就能用**。

- **真正的安装包**：`moocr-0.2.0-setup-x64.exe`（NSIS，当前用户安装，不需要管理员），带开始菜单/桌面快捷方式 `墨客 moocr`，卸载时保留已下载的权重。
- **应用内下载权重**：首次启动自动弹出「运行时就绪向导」，一键下载 529 MB + 207 MB，支持断点续传、镜像回退（Hugging Face 直连失败自动换 hf-mirror）、sha256 校验、暂停/继续。下完自动预热模型。
- **开箱即用**：llama.cpp Vulkan 运行时打进安装包；权重落在 `%APPDATA%\moocr\runtime\models`，不再往 `Program Files` 写，也不再出现「缺少运行时资产 … 请先执行 bash」。
- **可以导入本地权重**：已经有 gguf 的机器在向导里选文件即可，按文件名/大小匹配并校验。
- **有图标了**：橙色扫描框图标，不再是 Electron 默认图标。
- 顶部横幅与「帮助 → 运行时与模型…」随时显示组件状态，缺什么、下载到哪一步、失败原因都能看到；日志在 `%APPDATA%\moocr\logs\runtime.log`。

## 安装

1. 下载 `moocr-0.2.0-setup-x64.exe`，双击。
2. 首次启动 → 「运行时就绪向导」→ 一键下载（约 700 MB）。
3. 状态变绿后，拖图片/PDF 进去即可识别。

已有 0.1.0 的用户：旧版放在安装目录里的权重会被自动识别（只读探测），不必重下；升级后路径不再是 `resources/resources`。

## 系统要求

- Windows x64
- **支持 Vulkan 的显卡**（Intel Arc / AMD / NVIDIA）。没有 Vulkan 驱动的机器跑不起来，CPU 后端未打包。
- 显存：Q4_K_M 约 4 GB 起；并发 4 时约 8 GB
- 内存：8 GB 以上
- 磁盘：安装约 400 MB + 权重 702 MB

## 功能（与 0.1.0 相同）

整页 Markdown、表格 → HTML（保留合并单元格）、公式 → LaTeX（DOCX 里是 Word 原生公式）、KIE、PDF 逐页、Markdown/HTML/DOCX 导出、框选截图、深浅色主题。

## 已知问题

- 安装包未签名，Windows SmartScreen 会拦一下，选「更多信息 → 仍要运行」。
- 首次下载 700 MB 取决于网络；国内直连 Hugging Face 慢时会自动走镜像。
- 首次识别仍要 8–10 秒加载模型（向导完成后会后台预热，通常可省掉）。
- 跨页表格不会自动合并；韩语有模型级缺陷；不输出字符坐标。
- 没有自动更新；新版安装包覆盖安装即可，权重与缓存保留。

## 从源码运行

```bash
npm install
npm run fetch     # 读同一份 runtime-manifest.json 下载运行时与权重
npm start
```

打包：`npm run pack`（NSIS）、`npm run pack:dir`（免安装目录）。详见 [docs/M6-RUNTIME.md](https://github.com/KevinZjYang/moocr/blob/main/docs/M6-RUNTIME.md)。

## 这是什么

moocr（墨客）是一个本地 OCR 桌面应用，跑 Xiaomi-OCR-0（0.87B）在 llama.cpp + Vulkan 上。整页文档、表格、公式、关键信息抽取都在本机完成，不联网、不传图。

这一版在 Intel Arc A770 上验证：整页 A4 约 3–30 秒（取决于排版密度），decode 约 160 tok/s。

## 先装模型

安装包**不含模型权重**（700 MB）。首次启动会提示缺文件，点「打开模型目录」，把下面两个文件放进去即可：

- [Xiaomi-OCR-0.Q4_K_M.gguf](https://huggingface.co/prithivMLmods/Xiaomi-OCR-0-GGUF/resolve/main/Xiaomi-OCR-0.Q4_K_M.gguf)（529 MB）
- [Xiaomi-OCR-0.mmproj-bf16.gguf](https://huggingface.co/prithivMLmods/Xiaomi-OCR-0-GGUF/resolve/main/Xiaomi-OCR-0.mmproj-bf16.gguf)（207 MB）

目录位置：`<安装目录>/resources/resources/models/`。

## 系统要求

- Windows x64
- **支持 Vulkan 的显卡**。没有 Vulkan 驱动的机器跑不起来，CPU 后端已从包里裁掉以减小体积。
- 显存：Q4_K_M 约 4 GB 起；并发 4 时约 8 GB
- 内存：8 GB 以上

## 这一版能做什么

| 能力 | 状态 |
|---|---|
| 整页文档 → Markdown（保持阅读顺序） | 可用，OmniDocBench v1.6 官方 96.83 |
| 表格 → HTML（保留合并单元格） | 可用，合并单元格实测正确 |
| 公式 → LaTeX | 可用 |
| 关键信息抽取（自定义 JSON schema） | 可用，收据类 6/6 字段正确 |
| PDF 逐页识别 | 可用 |
| 导出 Markdown / HTML / DOCX | 可用，**DOCX 里公式是 Word 原生公式对象** |
| 框选截图识别（`Ctrl+Shift+O`，全局） | 可用 |
| 浅色 / 深色主题 | 可用 |
| 手写体 | 精度明显低于印刷体（实测 74–85%） |
| 韩语 | **有模型级缺陷**（머리글→매리类 这类替换），不建议依赖 |
| 字符坐标 / 原文对照高亮 | 不支持，模型不输出 bbox |

## 已知问题

- 安装包未签名，Windows SmartScreen 会拦一下，选「更多信息 → 仍要运行」
- 跨页表格会断成两张，不会自动合并
- 首次识别要等 8–10 秒加载模型

## 从源码运行

```bash
npm install
npm run fetch     # 下载 llama.cpp 与模型
npm start
```

详见 [README](https://github.com/KevinZjYang/moocr#readme)。

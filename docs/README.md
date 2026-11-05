# 文档索引

moocr 的每个里程碑都留了实测记录。这里不是营销材料，是「当时为什么这么决定」的证据 —— 包含测得的数据、踩过的坑、被砍掉的功能以及砍掉的理由。

按时间顺序读：

| 文档 | 内容 | 关键结论 |
|---|---|---|
| [CAPABILITY.md](CAPABILITY.md) | **M0 能力测绘**。成本模型、准确率、退化扫描、nonce 测试，A/B/C/D 四级能力判定 | prefill 随像素超线性增长（≈950 tok/MP，幂次 1.8–2.2）；印刷页低保真反而更准；韩语是模型级缺陷 |
| [M1.md](M1.md) | **核心管线 + CLI**。prompt 集、退化守卫、结果聚合、回归脚本 | 为什么删掉 `--keep-server`（跨进程复用会静默降精度） |
| [M2.md](M2.md) | **Electron 桌面壳**。三栏界面、IPC 契约、预设切换 | KV 缓存会让 `prompt_tokens` 失真；`ELECTRON_RUN_AS_NODE` 会让 Electron 退化成纯 Node |
| [M3.md](M3.md) | **PDF / 导出 / KIE**。pdfjs 拆页、Markdown → HTML/DOCX、JSON 抽取 | KIE 不认 JSON Schema 元语言，只认扁平示例对象 |
| [M4.md](M4.md) | **截图 / 并发 / 缓存 / 打包**。全局热键、框选遮罩、结果缓存、sidecar 自愈 | 并发只对 prefill 密集型大页有效（1.59×），短页反而更慢 |

## 数据文件

- `capability.json` —— 机器可读的能力矩阵（prompts、预设、分级、退化策略）
- `CAPABILITY-RAW.md` / `capability-raw.json` —— M0 首轮原始测量，未做口径修正
- `batch2/` —— 模型原始输出样本，`packages/postprocess` 的测试输入

## 复现

```bash
npm run fetch          # 拉取运行时与权重
npm test               # 三个包的纯逻辑测试
npm run ocr -- fixtures --out out --parallel 4
npm run regress        # 与 M0 基线对比，Δ < -3 分标红
```

`docs/hi-*.txt`、`out/`、`release/` 是本地产物，不入库。

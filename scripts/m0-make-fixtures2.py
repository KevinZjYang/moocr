#!/usr/bin/env python3
"""Second batch of M0 fixtures: merged-cell table, dense two-column CJK page,
mixed EN/CH document, larger Korean render (to rule out font/AA artifacts)."""
import os
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
OUT = os.path.join(ROOT, "fixtures", "synth")
os.makedirs(OUT, exist_ok=True)

FONTS = {
    "zh": r"C:\Windows\Fonts\msyh.ttc",
    "ja": r"C:\Windows\Fonts\msgothic.ttc",
    "ko": r"C:\Windows\Fonts\malgun.ttf",
    "latin": r"C:\Windows\Fonts\arial.ttf",
}


def font(kind, size):
    p = FONTS[kind]
    if p.endswith(".ttc"):
        return ImageFont.truetype(p, size, index=0)
    return ImageFont.truetype(p, size)


def wrap(d, text, fnt, max_w):
    lines, cur = [], ""
    for ch in text:
        t = cur + ch
        if d.textlength(t, font=fnt) > max_w and cur:
            lines.append(cur)
            cur = ch
        else:
            cur = t
    if cur:
        lines.append(cur)
    return lines


# ---------------------------------------------------------------- 1. merged table
# GT: OTSL with <lcel> (continuation of a horizontal merge) and <ucel> (vertical merge)
# row0: "季度" (spans down 2 rows) | "产品线" (spans right 2 cols) | "营收"
# row1: <ucel>                 | "硬件" | "软件"                  | "100"
# row2: "Q1"                   | "52"   | "48"                    | "100"
cell_w = [150, 170, 170, 150]
row_h = 70
pad = 12
W = sum(cell_w) + 2 * pad
H = row_h * 3 + 2 * pad
img = Image.new("RGB", (W, H), "white")
d = ImageDraw.Draw(img)
fnt = font("zh", 28)
d.rectangle([pad // 2, pad // 2, W - pad // 2, H - pad // 2], outline="black", width=3)
# grid lines
x0, y0 = pad, pad
for cw in cell_w[:-1]:
    x0 += cw
    d.line([(x0, pad), (x0, H - pad)], fill="black", width=2)
for r in (1, 2):
    d.line([(pad, pad + r * row_h), (W - pad, pad + r * row_h)], fill="black", width=2)


def center(cx, cy, text):
    tw = d.textlength(text, font=fnt)
    d.text((cx - tw / 2, cy - 18), text, font=fnt, fill="black")


# merged spans: erase the internal lines that would otherwise split them
d.rectangle([pad + 2, pad + 2, pad + cell_w[0] - 2, pad + 2 * row_h - 2], fill="white")
d.rectangle([pad + cell_w[0] + 2, pad + 2, pad + cell_w[0] + cell_w[1] + cell_w[2] - 2, pad + row_h - 2], fill="white")
d.rectangle([pad + 2, pad + 2, pad + cell_w[0] - 2, pad + 2 * row_h - 2], outline="black", width=2)
d.rectangle([pad + cell_w[0], pad, pad + cell_w[0] + cell_w[1] + cell_w[2], pad + row_h], outline="black", width=2)
d.rectangle([pad + cell_w[0], pad + row_h, pad + cell_w[0] + cell_w[1], pad + 2 * row_h], outline="black", width=2)
d.rectangle([pad + cell_w[0] + cell_w[1], pad + row_h, pad + cell_w[0] + cell_w[1] + cell_w[2], pad + 2 * row_h], outline="black", width=2)

center(pad + cell_w[0] / 2, pad + row_h, "季度")
center(pad + cell_w[0] + (cell_w[1] + cell_w[2]) / 2, pad + row_h / 2, "产品线")
center(pad + cell_w[0] + cell_w[1] + cell_w[2] + cell_w[3] / 2, pad + row_h / 2, "营收")
center(pad + cell_w[0] + cell_w[1] / 2, pad + row_h * 1.5, "硬件")
center(pad + cell_w[0] + cell_w[1] + cell_w[2] / 2, pad + row_h * 1.5, "软件")
center(pad + cell_w[0] + cell_w[1] + cell_w[2] + cell_w[3] / 2, pad + row_h * 1.5, "100")
center(pad + cell_w[0] / 2, pad + row_h * 2.5, "Q1")
center(pad + cell_w[0] + cell_w[1] / 2, pad + row_h * 2.5, "52")
center(pad + cell_w[0] + cell_w[1] + cell_w[2] / 2, pad + row_h * 2.5, "48")
center(pad + cell_w[0] + cell_w[1] + cell_w[2] + cell_w[3] / 2, pad + row_h * 2.5, "100")
img.save(os.path.join(OUT, "table-merged.png"))
print(f"  table-merged.png  {W}x{H}")

# ---------------------------------------------------------------- 2. dense 2-col CJK
body = (
    "线性注意力机制将标准注意力的二次复杂度降为线性，其核心在于用状态递推替代显式的键值缓存。"
    "在每一时刻，模型维护一个固定大小的状态矩阵，通过增量更新避免了对历史序列的重复计算。"
    "然而这种替换带来了数值稳定性问题，因为状态矩阵在长时间累积后容易出现幅度爆炸或衰减。"
    "为解决这一问题，研究者引入了门控机制与归一化策略，使状态更新具备可控的遗忘能力。"
    "本文提出的分块并行算法进一步将递推过程组织为若干块，块内使用矩阵乘法以获得张量核心加速。"
)
size = 26
fnt = font("zh", size)
lh = int(size * 1.8)
col_w = 620
margin = 70
gap = 60
W = margin * 2 + col_w * 2 + gap
lines = wrap(ImageDraw.Draw(Image.new("RGB", (10, 10))), body, fnt, col_w - 20)
half = (len(lines) + 1) // 2
H = margin * 2 + lh * half + 20
img = Image.new("RGB", (W, H), "white")
d = ImageDraw.Draw(img)
for ci, chunk in enumerate((lines[:half], lines[half:])):
    x = margin + ci * (col_w + gap)
    for li, ln in enumerate(chunk):
        d.text((x, margin + li * lh), ln, font=fnt, fill="black")
img.save(os.path.join(OUT, "zh-two-col.png"))
print(f"  zh-two-col.png  {W}x{H}  {len(lines)} lines / 2 cols")

# ---------------------------------------------------------------- 3. mixed EN/CH
fnt_a = font("latin", 28)
fnt_z = font("zh", 28)
lines = [
    ("混合排版测试 Mixed Layout Test", "zh"),
    ("1. 引言 Introduction", "zh"),
    ("本文提出一种 In-Context Learning 方法，用于 few-shot 场景。", "zh"),
    ("2. 方法 Method", "zh"),
    ("We compute attention as softmax(QK^T/sqrt(d))V where d is the head dim.", "latin"),
    ("3. 结果 Results", "zh"),
    ("在 OmniDocBench 上达到 96.83 分，较 baseline 提升 4.2 个点。", "zh"),
]
W = 1100
lh = 52
H = 80 + lh * len(lines)
img = Image.new("RGB", (W, H), "white")
d = ImageDraw.Draw(img)
for i, (ln, kind) in enumerate(lines):
    d.text((60, 40 + i * lh), ln, font=fnt_z if kind == "zh" else fnt_a, fill="black")
img.save(os.path.join(OUT, "mix-en-zh.png"))
print(f"  mix-en-zh.png  {W}x{H}  {len(lines)} lines")

# ---------------------------------------------------------------- 4. large Korean
fnt = font("ko", 44)
text = (
    "문서 이미지에서 본문의 모든 정보를 추출하고 머리글과 바닥글을 무시한 채 "
    "마크다운 형식으로 표현하십시오. 표는 OTSL 형식으로, 수식은 LaTeX 형식으로 표현하십시오. "
    "읽기 순서에 따라 구문 분석을 구성하십시오. 이것은 한국어 OCR 정확도를 확인하기 위한 테스트 문서입니다."
)
d0 = ImageDraw.Draw(Image.new("RGB", (10, 10)))
lines = wrap(d0, text, fnt, 1400)
W = 1520
H = 120 + int(44 * 1.9) * len(lines)
img = Image.new("RGB", (W, H), "white")
d = ImageDraw.Draw(img)
for i, ln in enumerate(lines):
    d.text((60, 60 + i * int(44 * 1.9)), ln, font=fnt, fill="black")
img.save(os.path.join(OUT, "ko-large.png"))
print(f"  ko-large.png  {W}x{H}  {len(lines)} lines")

print("done ->", OUT)

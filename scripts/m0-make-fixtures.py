#!/usr/bin/env python3
"""Generate synthetic M0 fixtures: multilingual, vertical CJK, table, formula.

Uses only Pillow + Windows system fonts. No network.
Outputs PNGs into fixtures/synth/.
"""
import os
import sys
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
OUT = os.path.join(ROOT, "fixtures", "synth")
os.makedirs(OUT, exist_ok=True)

FONTS = {
    "zh": r"C:\Windows\Fonts\msyh.ttc",
    "ja": r"C:\Windows\Fonts\msgothic.ttc",
    "ko": r"C:\Windows\Fonts\malgun.ttf",
    "ru": r"C:\Windows\Fonts\arial.ttf",
    "latin": r"C:\Windows\Fonts\arial.ttf",
}


def font(kind, size):
    path = FONTS[kind]
    return ImageFont.truetype(path, size, index=0) if path.endswith(".ttc") else ImageFont.truetype(path, size)


def canvas(w, h):
    img = Image.new("RGB", (w, h), "white")
    return img, ImageDraw.Draw(img)


def wrap_lines(draw, text, fnt, max_w):
    lines, cur = [], ""
    for ch in text:
        trial = cur + ch
        if draw.textlength(trial, font=fnt) > max_w and cur:
            lines.append(cur)
            cur = ch
        else:
            cur = trial
    if cur:
        lines.append(cur)
    return lines


def paragraph(kind, text, name, size=34, width=1100):
    fnt = font(kind, size)
    img, d = canvas(width, 200)
    lines = wrap_lines(d, text, fnt, width - 120)
    lh = int(size * 1.75)
    h = 100 + lh * len(lines)
    img = Image.new("RGB", (width, h), "white")
    d = ImageDraw.Draw(img)
    y = 50
    for ln in lines:
        d.text((60, y), ln, font=fnt, fill="black")
        y += lh
    path = os.path.join(OUT, name)
    img.save(path)
    print(f"  {name}  {img.size[0]}x{img.size[1]}  {len(lines)} lines")


# ---- 1..3  multilingual paragraphs -----------------------------------------
paragraph(
    "ja",
    "文書画像から本文の情報をすべて抽出し、ヘッダーとフッターを無視して、"
    "マークダウン形式で表現してください。表はOTSL形式で表現し、数式はLaTeX形式で表現してください。"
    "読み順に従って解析を整理してください。これは日本語のOCR精度を確認するためのテスト文書です。",
    "ja-paragraph.png",
)

paragraph(
    "ko",
    "문서 이미지에서 본문의 모든 정보를 추출하고 머리글과 바닥글을 무시한 채 "
    "마크다운 형식으로 표현하십시오. 표는 OTSL 형식으로, 수식은 LaTeX 형식으로 표현하십시오. "
    "읽기 순서에 따라 구문 분석을 구성하십시오. 이것은 한국어 OCR 정확도를 확인하기 위한 테스트 문서입니다.",
    "ko-paragraph.png",
)

paragraph(
    "ru",
    "Извлеките всю информацию из основного текста документа и представьте её в формате Markdown, "
    "игнорируя колонтитулы. Таблицы следует выражать в формате OTSL, формулы — в формате LaTeX, "
    "а разбор должен быть организован в порядке чтения. Это тестовый документ для проверки точности "
    "распознавания русского текста.",
    "ru-paragraph.png",
)

# ---- 4  vertical Chinese ---------------------------------------------------
vertical_text = "白日依山尽黄河入海流欲穷千里目更上一层楼"
size = 44
fnt = font("zh", size)
cols = 8
col_h = 12
gap = 28
w = 120 + cols * (size + gap)
h = 120 + col_h * int(size * 1.15)
img = Image.new("RGB", (w, h), "white")
d = ImageDraw.Draw(img)
chars = [c for c in vertical_text if c.strip()]
i = 0
for c in range(cols):
    x = w - 70 - c * (size + gap)
    for r in range(col_h):
        if i >= len(chars):
            break
        d.text((x, 60 + r * int(size * 1.12)), chars[i], font=fnt, fill="black")
        i += 1
img.save(os.path.join(OUT, "zh-vertical.png"))
print(f"  zh-vertical.png  {w}x{h}  {cols} cols x {col_h} rows")

# ---- 5  bordered table -----------------------------------------------------
rows = [
    ["项目", "数量", "单价", "金额"],
    ["笔记本电脑", "2", "5999.00", "11998.00"],
    ["显示器", "3", "1499.00", "4497.00"],
    ["机械键盘", "5", "399.00", "1995.00"],
    ["合计", "", "", "18490.00"],
]
cell_w = [260, 140, 200, 220]
row_h = 66
pad = 14
W = sum(cell_w) + 2 * pad
H = row_h * len(rows) + 2 * pad
img = Image.new("RGB", (W, H), "white")
d = ImageDraw.Draw(img)
fnt = font("zh", 30)
d.rectangle([pad // 2, pad // 2, W - pad // 2, H - pad // 2], outline="black", width=3)
y = pad
for ri, row in enumerate(rows):
    x = pad
    for ci, cell in enumerate(row):
        d.rectangle([x, y, x + cell_w[ci], y + row_h], outline="black", width=2)
        if cell:
            tw = d.textlength(cell, font=fnt)
            d.text((x + (cell_w[ci] - tw) / 2, y + (row_h - 34) / 2), cell, font=fnt, fill="black")
        x += cell_w[ci]
    y += row_h
img.save(os.path.join(OUT, "table-simple.png"))
print(f"  table-simple.png  {W}x{H}  {len(rows)}x{len(cell_w)}")

# ---- 6  formulas -----------------------------------------------------------
lines = [
    "E = mc^2",
    "∫_0^∞ e^{-x^2} dx = √π / 2",
    "f(x) = (1/√(2πσ^2)) exp(-(x-μ)^2 / (2σ^2))",
    "∑_{i=1}^{n} i = n(n+1)/2",
]
fnt = font("latin", 48)
W, H = 1000, 90 * len(lines) + 80
img = Image.new("RGB", (W, H), "white")
d = ImageDraw.Draw(img)
for i, ln in enumerate(lines):
    d.text((60, 40 + i * 90), ln, font=fnt, fill="black")
img.save(os.path.join(OUT, "formula-simple.png"))
print(f"  formula-simple.png  {W}x{H}  {len(lines)} formulas")

print("done ->", OUT)

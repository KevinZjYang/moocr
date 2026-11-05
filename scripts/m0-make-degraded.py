#!/usr/bin/env python3
"""Degraded-scan fixtures: blur, low contrast, low resolution, photo skew.
Goal: does uncertain vision input trigger repetition loops?"""
import os
from PIL import Image, ImageDraw, ImageFont, ImageFilter, ImageEnhance

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
OUT = os.path.join(ROOT, "fixtures", "degraded")
os.makedirs(OUT, exist_ok=True)

text = (
    "本文提出一种基于分块并行的线性注意力实现，使长序列训练可以在消费级显卡上完成。"
    "实验表明该方法在保持精度的同时将显存占用降低了约百分之四十。"
)

fnt = ImageFont.truetype(r"C:\Windows\Fonts\msyh.ttc", 32, index=0)
W, H = 1200, 260
img = Image.new("RGB", (W, H), "white")
d = ImageDraw.Draw(img)
lines, cur = [], ""
for ch in text:
    t = cur + ch
    if d.textlength(t, font=fnt) > W - 120 and cur:
        lines.append(cur); cur = ch
    else:
        cur = t
lines.append(cur)
for i, ln in enumerate(lines):
    d.text((60, 60 + i * 56), ln, font=fnt, fill="black")

with open(os.path.join(OUT, "para.gt.txt"), "w", encoding="utf-8") as f:
    f.write("\n".join(lines))

variants = {
    "clean": img,
    "blur2": img.filter(ImageFilter.GaussianBlur(2)),
    "blur4": img.filter(ImageFilter.GaussianBlur(4)),
    "lowcontrast": ImageEnhance.Contrast(img).enhance(0.25),
    "lowres": img.resize((W // 4, H // 4), Image.LANCZOS).resize((W, H), Image.BILINEAR),
    "noisy": None,
}
import random
random.seed(7)
noisy = img.copy()
px = noisy.load()
for y in range(H):
    for x in range(W):
        r, g, b = px[x, y]
        n = random.randint(-45, 45)
        px[x, y] = (max(0, min(255, r + n)), max(0, min(255, g + n)), max(0, min(255, b + n)))
variants["noisy"] = noisy

for name, im in variants.items():
    p = os.path.join(OUT, f"para-{name}.png")
    im.save(p)
    print(f"  {p}")
print("done")

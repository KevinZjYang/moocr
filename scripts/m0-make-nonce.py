#!/usr/bin/env python3
"""Nonce fixture: random CJK + digits, impossible to guess from language priors.
Used to separate true vision OCR accuracy from text-prior guessing."""
import os, random
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
OUT = os.path.join(ROOT, "fixtures", "synth")
os.makedirs(OUT, exist_ok=True)

random.seed(20261105)

# 300 common CJK chars, sampled randomly -> no linguistic structure
pool = [chr(c) for c in range(0x4E00, 0x4E00 + 3000)]
text = "".join(random.choice(pool) for _ in range(180))
text += " " + " ".join(str(random.randint(100000, 999999)) for _ in range(6))
text += " " + "".join(random.choice("ABCDEFGHJKLMNPQRSTUVWXYZ") for _ in range(24))

fnt = ImageFont.truetype(r"C:\Windows\Fonts\msyh.ttc", 30, index=0)
W = 1400
d0 = ImageDraw.Draw(Image.new("RGB", (10, 10)))
lines, cur = [], ""
for ch in text:
    if ch == "\n":
        lines.append(cur); cur = ""; continue
    t = cur + ch
    if d0.textlength(t, font=fnt) > W - 120 and cur:
        lines.append(cur); cur = ch
    else:
        cur = t
if cur:
    lines.append(cur)

lh = 54
H = 100 + lh * len(lines)
img = Image.new("RGB", (W, H), "white")
d = ImageDraw.Draw(img)
for i, ln in enumerate(lines):
    d.text((60, 50 + i * lh), ln, font=fnt, fill="black")
img.save(os.path.join(OUT, "nonce-cjk.png"))
with open(os.path.join(ROOT, "fixtures", "synth", "nonce-cjk.gt.txt"), "w", encoding="utf-8") as f:
    f.write("\n".join(lines))
print(f"  nonce-cjk.png {W}x{H} {len(lines)} lines {len(text)} chars")

# nonce table: random numbers, no semantics
rows = [["".join(random.choice("ABCDEFGH") for _ in range(3)) for _ in range(4)] for _ in range(5)]
cell_w = [200, 200, 200, 200]
row_h = 64
pad = 12
W2 = sum(cell_w) + 2 * pad
H2 = row_h * len(rows) + 2 * pad
img = Image.new("RGB", (W2, H2), "white")
d = ImageDraw.Draw(img)
f2 = ImageFont.truetype(r"C:\Windows\Fonts\arial.ttf", 30)
d.rectangle([pad // 2, pad // 2, W2 - pad // 2, H2 - pad // 2], outline="black", width=3)
y = pad
for row in rows:
    x = pad
    for ci, cell in enumerate(row):
        d.rectangle([x, y, x + cell_w[ci], y + row_h], outline="black", width=2)
        tw = d.textlength(cell, font=f2)
        d.text((x + (cell_w[ci] - tw) / 2, y + (row_h - 34) / 2), cell, font=f2, fill="black")
        x += cell_w[ci]
    y += row_h
img.save(os.path.join(OUT, "nonce-table.png"))
print(f"  nonce-table.png {W2}x{H2}  GT:", " | ".join(" ".join(r) for r in rows))

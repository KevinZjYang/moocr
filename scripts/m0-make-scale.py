#!/usr/bin/env python3
"""Downscale/upscale the dense-equations page to sweep image-token budgets."""
import os
from PIL import Image

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SRC = os.path.join(ROOT, "fixtures", "dense-equations.jpg")
OUT = os.path.join(ROOT, "fixtures", "scale")
os.makedirs(OUT, exist_ok=True)

im = Image.open(SRC).convert("RGB")
print("source", im.size, f"{im.size[0]*im.size[1]/1e6:.2f} MP")

for tag, scale in [("s50", 0.5), ("s75", 0.75), ("s100", 1.0), ("s150", 1.5), ("s200", 2.0)]:
    w = int(im.size[0] * scale)
    h = int(im.size[1] * scale)
    out = im.resize((w, h), Image.LANCZOS)
    p = os.path.join(OUT, f"dense-{tag}.jpg")
    out.save(p, quality=95)
    print(f"  {tag}: {w}x{h}  {w*h/1e6:.2f} MP")
print("done ->", OUT)

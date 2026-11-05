#!/usr/bin/env python3
"""把几张 synth 图片合成一个多页 PDF，用于 M3 的 PDF 逐页识别测试。

只用 Pillow（已随 DSH bundled python 提供）。
"""
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SYNTH = ROOT / "fixtures" / "synth"
OUT = SYNTH / "sample-3p.pdf"

SOURCES = [
    SYNTH / "mix-en-zh.png",
    SYNTH / "table-merged.png",
    SYNTH / "formula-simple.png",
]


def main() -> None:
    pages = []
    for p in SOURCES:
        if not p.exists():
            raise SystemExit(f"missing fixture: {p}")
        img = Image.open(p).convert("RGB")
        # 统一到 A4 比例的画布，避免 pdf 页面尺寸跳动
        pages.append(img)
        print(f"{p.name} {img.width}x{img.height}")

    first, rest = pages[0], pages[1:]
    first.save(OUT, "PDF", save_all=True, append_images=rest, resolution=150.0)
    print(f"wrote {OUT} ({OUT.stat().st_size} bytes, {len(pages)} pages)")


if __name__ == "__main__":
    main()

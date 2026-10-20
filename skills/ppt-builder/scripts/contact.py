"""把 render.sh 输出的逐页 PNG 拼成一张缩略图总览（每行 4 页）。
用法：python contact.py <逐页PNG所在目录> [输出文件，默认 contact.png]"""
import glob
import os
import sys

from PIL import Image

src = sys.argv[1] if len(sys.argv) > 1 else "render"
out = sys.argv[2] if len(sys.argv) > 2 else "contact.png"
files = sorted(glob.glob(os.path.join(src, "page-*.png")))
if not files:
    sys.exit(f"{src} 中没有 page-*.png")
cols = 4
ims = [Image.open(f).convert("RGB") for f in files]
w, h = ims[0].size
tw, th = w // 2, h // 2
rows = (len(ims) + cols - 1) // cols
sheet = Image.new("RGB", (cols * (tw + 12) + 12, rows * (th + 12) + 12), "#9CA3AF")
for i, im in enumerate(ims):
    sheet.paste(im.resize((tw, th)), (12 + (i % cols) * (tw + 12), 12 + (i // cols) * (th + 12)))
sheet.save(out)

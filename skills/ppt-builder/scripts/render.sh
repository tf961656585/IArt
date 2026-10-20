#!/bin/bash
# 把 pptx 渲染成逐页 PNG + 一张缩略图总览，用于看图质检。
# 用法：bash render.sh 演示.pptx [输出目录，默认 render]
# 产出：<输出目录>/page-01.png …（逐页，约 1067×600）和 <输出目录>/contact.png（总览）
# 依赖：LibreOffice（soffice）、poppler-utils（pdftoppm）、Pillow
set -e
PPTX="${1:?用法：bash render.sh 演示.pptx [输出目录]}"
OUT="${2:-render}"
HERE="$(cd "$(dirname "$0")" && pwd)"
SOFFICE="$(command -v soffice || command -v libreoffice || true)"
if [ -z "$SOFFICE" ]; then echo "未找到 LibreOffice（soffice），无法渲染。请运行 python check_env.py 查看安装方法。" >&2; exit 2; fi
if ! command -v pdftoppm >/dev/null; then echo "未找到 pdftoppm（poppler-utils），无法渲染。" >&2; exit 2; fi
rm -rf "$OUT" && mkdir -p "$OUT"
"$SOFFICE" --headless --convert-to pdf --outdir "$OUT" "$PPTX" >/dev/null 2>&1
PDF="$OUT/$(basename "${PPTX%.*}").pdf"
[ -f "$PDF" ] || { echo "LibreOffice 转换失败：$PPTX" >&2; exit 3; }
pdftoppm -r 80 -png "$PDF" "$OUT/page"
python3 "$HERE/contact.py" "$OUT" "$OUT/contact.png"
echo "已渲染 $(ls "$OUT"/page-*.png | wc -l) 页 → $OUT/page-*.png；总览 → $OUT/contact.png"

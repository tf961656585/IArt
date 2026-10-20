"""检查 ppt-builder 技能的运行环境。

用法：python check_env.py [--no-render-probe]
必需：Python 3.8+、python-pptx、Pillow。可选（用于渲染看图质检）：LibreOffice、pdftoppm、中文字体。

除了"字体装没装"，本脚本还会做一次**真实渲染探针**：让 LibreOffice 把一句中文转成 PDF 再栅格化，
数一下有没有真的画出笔画。原因：macOS 上系统字体（PingFang / Heiti 都是 .ttc 集合）常常不被
LibreOffice 的 headless 导出认到——fc-list 看着有中文，渲染出来却是一排豆腐块，只看 fc-list 会漏判。
"""
import argparse
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ok = True
ap = argparse.ArgumentParser(add_help=True)
ap.add_argument("--no-render-probe", action="store_true", help="跳过真实渲染探针（更快）")
args = ap.parse_args()


def line(status, name, msg=""):
    print(f"[{status}] {name}" + (f"：{msg}" if msg else ""))


if sys.version_info < (3, 8):
    ok = False
    line("缺失", "Python 3.8+", f"当前 {sys.version.split()[0]}")
else:
    line("OK", "Python", sys.version.split()[0])

try:
    import pptx
    line("OK", "python-pptx", pptx.__version__)
except ImportError:
    ok = False
    line("缺失", "python-pptx", "安装：pip install python-pptx")

try:
    import PIL
    line("OK", "Pillow", PIL.__version__)
except ImportError:
    ok = False
    line("缺失", "Pillow", "安装：pip install pillow")

render_ok = True
so = shutil.which("soffice") or shutil.which("libreoffice")
if so:
    line("OK", "LibreOffice（可选）", so)
else:
    render_ok = False
    line("可选缺失", "LibreOffice", "用于把 pptx 渲染成图片做看图质检。"
         "Ubuntu/Debian：sudo apt install libreoffice-impress；macOS：brew install --cask libreoffice；"
         "Windows：从 libreoffice.org 下载安装")
if shutil.which("pdftoppm"):
    line("OK", "pdftoppm（可选）")
else:
    render_ok = False
    line("可选缺失", "pdftoppm", "Ubuntu/Debian：sudo apt install poppler-utils；macOS：brew install poppler")

if shutil.which("fc-list"):
    try:
        zh = subprocess.run(["fc-list", ":lang=zh"], capture_output=True, text=True, timeout=10).stdout.strip()
    except Exception:
        zh = ""
    if zh:
        line("OK", "系统中文字体（可选）", f"{len(zh.splitlines())} 个")
    else:
        line("可选缺失", "系统中文字体", "渲染时中文会显示成方块。Ubuntu/Debian：sudo apt install fonts-noto-cjk")

# ---- 真实渲染探针：中文到底能不能画出来 ----
if so and shutil.which("pdftoppm") and not args.no_render_probe:
    try:
        from PIL import Image

        with tempfile.TemporaryDirectory() as td:
            src = Path(td) / "probe.txt"
            src.write_text("中文字体检测\n", encoding="utf-8")
            subprocess.run([so, "--headless", "--convert-to", "pdf", "--outdir", td, str(src)],
                           capture_output=True, timeout=120)
            pdf = Path(td) / "probe.pdf"
            if not pdf.exists():
                line("警告", "渲染探针", "LibreOffice 没能把探针文本转成 PDF")
            else:
                subprocess.run(["pdftoppm", "-r", "100", "-png", str(pdf), str(Path(td) / "probe")],
                               capture_output=True, timeout=120)
                pngs = sorted(Path(td).glob("probe*.png"))
                if not pngs:
                    line("警告", "渲染探针", "pdftoppm 没有产出图片")
                else:
                    im = Image.open(pngs[0]).convert("L")
                    px = im.load()
                    w, h = im.size
                    dark = sum(1 for y in range(0, min(h, 300)) for x in range(0, w, 2) if px[x, y] < 200)
                    if dark > 20:
                        line("OK", "中文渲染探针", f"检测到 {dark} 个笔画像素")
                    else:
                        line("警告", "中文渲染探针", "LibreOffice 渲染不出中文（豆腐块/空白），看图质检会失真")
                        print("      修法（macOS 实测有效）：把任意一个中文 TTF 复制进 LibreOffice 自带字体目录，"
                              "再重开一次渲染：")
                        print('        cp "/Users/你/Library/Fonts/NotoSansSC[wght].ttf" '
                              '"/Applications/LibreOffice.app/Contents/Resources/fonts/truetype/NotoSansSC.ttf"')
                        print("      原因：系统里的 PingFang/Heiti 是 .ttc 集合，headless 导出常常认不到；"
                              "fc-list 能看到不等于渲染能用。")
    except Exception as e:      # 探针失败不该让整个检查失败
        line("警告", "渲染探针", f"跑不起来（{type(e).__name__}: {e}），跳过")

print()
if not ok:
    print("结论：缺少必需依赖，请先安装后再生成 PPT。")
    sys.exit(1)
print("结论：可以生成 PPT。" + ("也可以渲染看图质检（bash scripts/render.sh 演示.pptx）。" if render_ok
                          else "无法渲染看图，交付报告中请注明\"未做渲染检查\"。"))

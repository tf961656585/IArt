# -*- coding: utf-8 -*-
"""
pptdeck.py —— ppt-builder 技能的组件库（基于 python-pptx + Pillow）

原则：模型决定"放什么"，本库决定"怎么放"。
- 你只需调用函数、填写内容和少量枚举选项（主题、关系类型、警示等级等）。
- 坐标、尺寸、内边距、对齐、行距、字号全部由本库计算，不对外开放。
- 内容超出限制时抛出 DeckError，格式为：
      第N页 | 组件 | 问题 | 建议修复方式
  本库绝不会偷偷缩小字号。请按建议删减文字、拆页或换组件后重新运行。

最小示例：
    from pptdeck import *
    deck = Deck(title="设备管理台改版说明", source="产品需求文档 v2")
    deck.cover(title="设备管理台改版说明", subtitle="面向一线运维", author="张三", date="2026年10月")
    deck.points(["看懂改版的三个主要变化", "知道迁移时要注意什么"])
    deck.slide("旧版三步操作在新版里合成了一步", [Evidence(placeholder="新旧流程对比图")],
               source="§2.1", notes="讲解要点……")
    deck.summary(["改版变化……", "迁移注意……"], source="§1–§5")
    deck.save("汇报.pptx")

图片：deck.image() 本地图片 / deck.illustration() 插图（AI 生成）/ deck.mood() 氛围图（AI 生成）。
本库不调用任何生图 API：save() 会写出 image_requests.json（含完整 prompt 和目标文件名），
由调用方用自己的生图能力生成到指定文件名后重新运行；缺图时显示占位框并在质检中报错。

依赖：pip install python-pptx pillow
"""
from __future__ import annotations

import functools
import hashlib
import json
import os
import unicodedata
from dataclasses import dataclass, field
from typing import List, Literal, Optional, Sequence, Tuple

from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.dml import MSO_LINE_DASH_STYLE
from pptx.enum.shapes import MSO_CONNECTOR, MSO_SHAPE
from pptx.enum.text import MSO_ANCHOR, MSO_AUTO_SIZE, PP_ALIGN
from pptx.oxml.ns import qn
from pptx.parts.image import Image as _PptxImage
from pptx.util import Pt

__all__ = [
    "Deck", "DeckError", "ImageRef",
    "Evidence", "Callout", "Definition", "Bullets", "Steps", "Step",
    "Compare", "Example", "Question", "Alert", "Table",
]

# =====================================================================
# 一、设计常量（系统决定，模型不要修改）
# =====================================================================
SLIDE_W, SLIDE_H = 960, 540                 # 16:9，单位 pt
X0, X1 = 48, 912                            # 左右边距 48pt
CONTENT_W = X1 - X0                         # 864
GUTTER = 16
COLS = 12
COL_W = (CONTENT_W - GUTTER * (COLS - 1)) / COLS
TITLE_Y, TITLE_H = 24, 84                   # 标题区：最多 2 行，底部对齐
BODY_Y0, BODY_Y1 = 140, 476                 # 内容区高 336
BODY_H = BODY_Y1 - BODY_Y0
FOOT_Y, FOOT_H = 492, 28                    # 出处条
GAP = 24                                    # 组件之间的间距
SPACING = (8, 16, 24, 32, 48, 64)           # 间距只取这些值

# 字号只有 4 档：标题 32 / 正文 24 / 辅助 18 / 出处 14（出处是唯一低于 18 的例外）
SIZE_TITLE, SIZE_BODY, SIZE_SMALL, SIZE_FOOT = 32, 24, 18, 14
LINE = 1.3                                  # 固定行距倍数（按字号的固定磅值）
FONT = "Microsoft YaHei"                    # PowerPoint 中文字体；缺失时系统自动回退

THEMES = {
    "深蓝": dict(primary="1F3A5F", accent="0B6E69"),
    "墨绿": dict(primary="1D5446", accent="2B5C8A"),
    "石墨": dict(primary="2D3748", accent="22609E"),
}
TEXT, GRAY, LINE_GRAY, LIGHT, WHITE = "1F2937", "5B6472", "D5DAE1", "F1F4F8", "FFFFFF"

# 设计令牌：一份 deck 的全部视觉决定。theme= 可以传内置主题名，也可以传这里的任意子集。
DEFAULT_TOKENS = dict(
    primary="1F3A5F",      # 主色（顶部色条、序号圆点、强调）
    accent="0B6E69",       # 强调色（来源补充说明等）
    bg="FFFFFF",           # 页面底色（深色课件改这里）
    text=TEXT,             # 正文色
    gray=GRAY,             # 辅助文字色
    line=LINE_GRAY,        # 分隔线 / 描边色
    font=FONT,             # 字体（PowerPoint 缺失时系统回退）
    chrome=True,           # 是否画页面骨架（顶部色条 + 页脚线 + 页码）
    scale=1.0,             # 全局字号倍率（0.85~1.15 之间）
    title_size=SIZE_TITLE, body_size=SIZE_BODY, small_size=SIZE_SMALL, foot_size=SIZE_FOOT,
)
TOKEN_KEYS = tuple(DEFAULT_TOKENS)


def _build_tokens(theme, extra=None):
    """把 theme（内置主题名 / 令牌 dict）与额外关键字合并校验成完整令牌。"""
    t = dict(DEFAULT_TOKENS)
    if isinstance(theme, str):
        if theme not in THEMES:
            names = " / ".join(THEMES)
            raise DeckError(f"第0页 | 演示文稿 | theme=「{theme}」不合法 | 只能是：{names}，或传一份设计令牌 dict")
        t.update(THEMES[theme])
    elif isinstance(theme, dict):
        t.update({k: v for k, v in theme.items() if v is not None})
    elif theme is not None:
        raise DeckError("第0页 | 演示文稿 | theme 类型不对 | 传内置主题名（深蓝/墨绿/石墨），或一份设计令牌 dict")
    if extra:
        t.update({k: v for k, v in extra.items() if v is not None})
    unknown = [k for k in t if k not in DEFAULT_TOKENS]
    if unknown:
        raise DeckError(f"第0页 | 演示文稿 | 设计令牌里有未知字段 {unknown} | 可用字段：{list(DEFAULT_TOKENS)}")
    for k in ("primary", "accent", "bg", "text", "gray", "line"):
        v = str(t[k]).lstrip("#").upper()
        if len(v) != 6 or any(ch not in "0123456789ABCDEF" for ch in v):
            raise DeckError(f"第0页 | 演示文稿 | 令牌 {k}=「{t[k]}」不是6位十六进制色值 | 例如 primary=\"1F3A5F\"")
        t[k] = v
    for k in ("primary", "accent"):
        if contrast(t[k], WHITE) < 4.5:
            raise DeckError(f"第0页 | 演示文稿 | 令牌 {k}=「{t[k]}」与白色对比度不足 4.5:1 | 换更深的颜色，或改用深色底 + 浅色文字方案")
    try:
        scale = float(t["scale"])
    except (TypeError, ValueError):
        raise DeckError("第0页 | 演示文稿 | scale 不是数字 | 填 0.85~1.15 之间的倍率") from None
    if not 0.7 <= scale <= 1.3:
        raise DeckError(f"第0页 | 演示文稿 | scale={scale} 超出范围 | 只能 0.7~1.3；版面容量有上限，放大字号会导致大量页面放不下")
    t["sizes"] = {k: round(float(t[f"{k}_size"]) * scale, 1) for k in ("title", "body", "small", "foot")}
    return t


def _size(ctx, role="body"):
    """取当前 deck 的字号；没有 ctx 时退回默认档（供 measure(w) 单独调用时使用）。"""
    return ctx.sizes[role] if ctx is not None else DEFAULT_SIZES[role]


DEFAULT_SIZES = {"title": SIZE_TITLE, "body": SIZE_BODY, "small": SIZE_SMALL, "foot": SIZE_FOOT}

# 警示色：只允许警示框组件使用
ALERT = {
    "提示": dict(bg="1F5FBF", fg="FFFFFF", word="提示"),
    "注意": dict(bg="FFD400", fg="111111", word="注意"),
    "警告": dict(bg="F28C28", fg="111111", word="警告"),
    "危险": dict(bg="C00000", fg="FFFFFF", word="危险"),
}

EMPTY_REASONS = ("为了安全", "保证安全", "确保安全", "注意安全", "为了质量",
                 "保证质量", "确保质量", "提高质量", "防止出错", "更规范")


class DeckError(Exception):
    """排版或内容超出约束。消息格式：第N页 | 组件 | 问题 | 建议修复方式"""


class _PageAbort(Exception):
    """本页校验没过：记录错误后跳过这一页，让其余页继续校验——错误一次性给全。"""


def _page_method(fn):
    """页级守卫：一页里出的任何问题都记录到 deck.errors 并跳过该页，不打断后面的页。

    这样一次运行就能拿到全部页面的问题，而不是修一个跑一次。
    """
    @functools.wraps(fn)
    def wrapper(self, *args, **kwargs):
        try:
            return fn(self, *args, **kwargs)
        except _PageAbort:
            pass
        except DeckError as e:                     # 构造参数类错误（如 image= 直接写了路径）
            if str(e) not in self.errors:
                self.errors.append(str(e))
        except Exception as e:                     # 兜底：不吞，如实记成组件库内部错误
            msg = (f"第{self._page_no()}页 | 内部错误 | {type(e).__name__}: {e} | "
                   "这是组件库的问题，请把这条报给技能维护者")
            if msg not in self.errors:
                self.errors.append(msg)
        return None
    return wrapper


# =====================================================================
# 二、工具函数：颜色、对比度、文字测量
# =====================================================================
def _rgb(h: str) -> RGBColor:
    return RGBColor.from_string(h)


def _lum(h: str) -> float:
    def ch(c):
        c = c / 255
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
    r, g, b = (int(h[i:i + 2], 16) for i in (0, 2, 4))
    return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b)


def contrast(a: str, b: str) -> float:
    """WCAG 对比度。"""
    la, lb = sorted((_lum(a), _lum(b)), reverse=True)
    return (la + 0.05) / (lb + 0.05)


def _tint(h: str, t: float) -> str:
    """把颜色与白色混合，t 为原色占比。"""
    r, g, b = (int(h[i:i + 2], 16) for i in (0, 2, 4))
    return "%02X%02X%02X" % tuple(round(255 - (255 - c) * t) for c in (r, g, b))


def _char_w(c: str) -> float:
    """单字符宽度（单位：em）。中文/全角按 1em，拉丁字母约 0.55em。偏保守。"""
    if c == " ":
        return 0.32
    if unicodedata.east_asian_width(c) in ("W", "F", "A"):
        return 1.0
    if c.isupper():
        return 0.68
    if c.isdigit() or c.islower():
        return 0.58
    if c in ".,:;'!|il":
        return 0.32
    return 0.62


def text_width(s: str, size: float) -> float:
    return sum(_char_w(c) for c in s) * size


_NO_LINE_START = set("，。、；：！？）」』》〉”’,.;:!?)%")


def wrap(s: str, size: float, width: float) -> List[str]:
    """按估算宽度折行（中文逐字可断，英文单词尽量不拆，避头标点）。"""
    width = width * 0.95  # 保守系数，给真实字体留余量
    tokens, buf = [], ""
    for c in s:
        if c.isascii() and c.isalnum():
            buf += c
        else:
            if buf:
                tokens.append(buf)
                buf = ""
            tokens.append(c)
    if buf:
        tokens.append(buf)
    lines, cur, cur_w = [], [], 0.0
    for t in tokens:
        tw = text_width(t, size)
        if cur and cur_w + tw > width:
            if t in _NO_LINE_START and len(cur) > 1:
                carry = cur.pop()
                lines.append("".join(cur))
                cur, cur_w = [carry], text_width(carry, size)
            else:
                lines.append("".join(cur))
                cur, cur_w = [], 0.0
            if t == " ":
                continue
        if tw > width:  # 超长单词按字符拆
            for c in t:
                cw = text_width(c, size)
                if cur and cur_w + cw > width:
                    lines.append("".join(cur))
                    cur, cur_w = [], 0.0
                cur.append(c)
                cur_w += cw
            continue
        cur.append(t)
        cur_w += tw
    if cur:
        lines.append("".join(cur))
    return lines or [""]


def _n(s: str) -> int:
    """字数：汉字、字母、数字、标点各算 1。"""
    return len(s.strip())


# =====================================================================
# 三、原子容器：带文字的盒子（内边距、对齐、行距由角色决定）
# =====================================================================
def _roles_for(sizes):
    return {
    #  role       size        bold   color     align   anchor  pad
    "title":   (sizes["title"], True,  "TEXT",   "L", "B", 0),
    "display": (sizes["title"], True,  "WHITE",  "L", "T", 0),
    "body":    (sizes["body"],  False, "TEXT",   "L", "T", 0),
    "strong":  (sizes["body"],  True,  "TEXT",   "L", "T", 0),
    "card":    (sizes["body"],  False, "TEXT",   "L", "M", 16),
    "head":    (sizes["body"],  True,  "WHITE",  "C", "M", 16),
    "small":   (sizes["small"], False, "GRAY",   "L", "T", 0),
    "label":   (sizes["small"], False, "TEXT",   "L", "M", 8),
    "tag":     (sizes["small"], True,  "WHITE",  "C", "M", 8),
    "badge":   (sizes["small"], True,  "WHITE",  "C", "M", 0),
    "foot":    (sizes["foot"],  False, "GRAY",   "L", "M", 0),
    }


ROLES = _roles_for(DEFAULT_SIZES)   # 兼容默认档；Deck 会按自己的令牌重建一份
BADGE = 32  # 序号圆点直径


def _line_h(size: float) -> float:
    return round(size * LINE, 1)


def box_height(paras: Sequence[str], role: str, width: float, para_gap: float = 0) -> Tuple[float, int]:
    """计算原子容器所需高度，返回 (高度, 总行数)。"""
    size, _, _, _, _, pad = ROLES[role]
    inner = width - 2 * pad
    n = sum(len(wrap(p, size, inner)) for p in paras)
    h = n * _line_h(size) + para_gap * max(0, len(paras) - 1) + 2 * pad + 4
    return h, n


class _Ctx:
    """渲染上下文：当前页码、主题色、报错。"""

    def __init__(self, deck: "Deck", page: int):
        self.deck, self.page = deck, page
        self.c = deck.colors
        self.tokens = deck.tokens
        self.roles = deck.roles
        self.sizes = deck.sizes
        self.font = deck.tokens["font"]

    def err(self, comp: str, problem: str, fix: str):
        msg = f"第{self.page}页 | {comp} | {problem} | {fix}"
        if msg not in self.deck.errors:
            self.deck.errors.append(msg)
        raise _PageAbort(msg)


def _set_run(run, size, bold, color, font=None):
    f = run.font
    f.size = Pt(size)
    f.bold = bold
    f.color.rgb = _rgb(color)
    f.name = font or FONT
    rPr = run._r.get_or_add_rPr()
    for tag in ("a:ea", "a:cs"):
        el = rPr.find(qn(tag))
        if el is None:
            el = rPr.makeelement(qn(tag), {})
            rPr.append(el)
        el.set("typeface", font or FONT)


def _nostyle(shp):
    st = shp._element.find(qn("p:style"))
    if st is not None:
        shp._element.remove(st)


def _shape(slide, kind, x, y, w, h, fill=None, line=None, dash=False, line_w=1.0):
    shp = slide.shapes.add_shape(kind, Pt(x), Pt(y), Pt(w), Pt(h))
    st = shp._element.find(qn("p:style"))   # 去掉默认主题样式（会带来阴影和默认文字色）
    if st is not None:
        shp._element.remove(st)
    if fill:
        shp.fill.solid()
        shp.fill.fore_color.rgb = _rgb(fill)
    else:
        shp.fill.background()
    if line:
        shp.line.color.rgb = _rgb(line)
        shp.line.width = Pt(line_w)
        if dash:
            shp.line.dash_style = MSO_LINE_DASH_STYLE.DASH
    else:
        shp.line.fill.background()
    shp.shadow.inherit = False
    return shp


def _text(slide, ctx: _Ctx, x, y, w, h, paras: Sequence[str], role: str,
          fill=None, line=None, color=None, para_gap=0, kind=MSO_SHAPE.RECTANGLE, bold=None):
    """原子容器。所有文字都经过这里，保证内边距/对齐/行距统一。"""
    size, rbold, rcolor, align, anchor, pad = ctx.roles[role]
    col = color or {"TEXT": ctx.tokens["text"], "WHITE": WHITE, "GRAY": ctx.tokens["gray"]}[rcolor]
    shp = _shape(slide, kind, x, y, w, h, fill=fill, line=line)
    tf = shp.text_frame
    tf.word_wrap = True
    tf.auto_size = MSO_AUTO_SIZE.NONE
    tf.margin_left = tf.margin_right = Pt(pad)
    tf.margin_top = tf.margin_bottom = Pt(pad if anchor != "M" else 0)
    tf.vertical_anchor = {"T": MSO_ANCHOR.TOP, "M": MSO_ANCHOR.MIDDLE, "B": MSO_ANCHOR.BOTTOM}[anchor]
    for i, ptxt in enumerate(paras):
        p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        p.alignment = {"L": PP_ALIGN.LEFT, "C": PP_ALIGN.CENTER}[align]
        p.line_spacing = Pt(_line_h(size))
        p.space_before = Pt(para_gap if i else 0)
        p.space_after = Pt(0)
        r = p.add_run()
        r.text = ptxt
        _set_run(r, size, rbold if bold is None else bold, col, font=ctx.font)
    return shp


def _badge(slide, ctx, x, y, label: str, fill=None):
    return _text(slide, ctx, x, y, BADGE, BADGE, [label], "badge",
                 fill=fill or ctx.c["primary"], kind=MSO_SHAPE.OVAL)


def _lead(paragraph, text: str, color: str):
    """在段首插入一个加粗彩色引导词（如"示例　"），字号与该段一致。"""
    r0 = paragraph.runs[0]
    r = paragraph.add_run()
    r.text = text
    _set_run(r, r0.font.size.pt, True, color, r0.font.name)
    paragraph._p.remove(r._r)
    paragraph._p.insert(paragraph._p.index(r0._r), r._r)


def _hline(slide, x1, y, x2, color=LINE_GRAY, w=1.0):
    ln = slide.shapes.add_connector(MSO_CONNECTOR.STRAIGHT, Pt(x1), Pt(y), Pt(x2), Pt(y))
    _nostyle(ln)
    ln.line.color.rgb = _rgb(color)
    ln.line.width = Pt(w)
    return ln


def _check_text(ctx, comp, field_name, s, max_chars, allow_empty=False):
    if s is None or not str(s).strip():
        if allow_empty:
            return
        ctx.err(comp, f"{field_name}为空", f"请填写{field_name}")
    s = str(s)
    if "\n" in s:
        ctx.err(comp, f"{field_name}中含手动换行", "删除换行符，换行由组件库自动计算；需要分条请用列表参数")
    if _n(s) > max_chars:
        ctx.err(comp, f"{field_name}「{s[:12]}…」共{_n(s)}字，超过上限{max_chars}字",
                f"删减到{max_chars}字以内，或拆成两页/两条")


# =====================================================================
# 三点五、图片：三类图片 + 生图请求（本库不调用任何生图 API）
# =====================================================================
KIND_LOCAL, KIND_ILLU, KIND_MOOD = "本地图片", "插图", "氛围图"
RATIOS = {"16:9": 16 / 9, "4:3": 4 / 3, "1:1": 1.0, "3:4": 3 / 4}
RATIO_PX = {"16:9": "1600x900", "4:3": "1600x1200", "1:1": "1200x1200", "3:4": "1200x1600"}
IMG_RADIUS = 8          # 圆角（pt），所有内容图统一
MIN_PX_PER_PT = 1.5     # 分辨率下限：每 pt 至少 1.5 像素
MAX_CROP = 0.25         # 裁掉超过 25% 时警告
MAX_DECOR = 3           # 内容页（互动页）氛围图上限
OUT_SCALE = 2           # 处理后图片：每 pt 2 像素
THEME_DESC = {
    "深蓝": ("深海军蓝与青绿", "deep navy blue and teal"),
    "墨绿": ("墨绿与钢蓝", "deep forest green and steel blue"),
    "石墨": ("石墨灰与湛蓝", "graphite gray and medium blue"),
}


@dataclass
class ImageRef:
    """图片引用。请用 deck.image() / deck.illustration() / deck.mood() 创建，不要手动构造。"""
    kind: str
    id: str
    path: str
    ratio: str
    subject: str = ""
    prompt: str = ""
    negative: str = ""
    source: str = ""

    def exists(self) -> bool:
        return bool(self.path) and os.path.isfile(self.path)

    def tag(self) -> str:
        if self.kind == KIND_LOCAL:
            return f"本地图片 {self.source}" if self.source else "本地图片"
        if self.kind == KIND_ILLU:
            return "插图（AI生成，仅辅助理解）"
        return ""


_LIN = [((c / 255) / 12.92 if c / 255 <= 0.04045 else (((c / 255) + 0.055) / 1.055) ** 2.4) for c in range(256)]


def _max_lum(im) -> float:
    """图片中最亮像素的相对亮度（先缩到 ≤200px 宽，保守地取最大值）。"""
    t = im.copy()
    t.thumbnail((200, 200))
    best = 0.0
    for r, g, b in t.getdata():
        L = 0.2126 * _LIN[r] + 0.7152 * _LIN[g] + 0.0722 * _LIN[b]
        if L > best:
            best = L
    return best


def _process_image(deck, ref: ImageRef, box_w: float, box_h: float, page: int,
                   mode: str, rounded: bool = True, border: bool = True, overlay: Optional[str] = None,
                   pad: str = "FFFFFF"):
    """把源图处理成恰好等于框比例的图片（不拉伸）。
    mode="fit"：等比缩放放进框内，四周留白（本地图片，不裁切内容）；
    mode="crop"：等比缩放后居中裁切（AI 图）。
    overlay：叠加主题色遮罩，自动加深直到白字对比度 ≥4.5:1。
    返回 (处理后路径, 内容在框内的相对矩形 (x0, y0, w, h))。"""
    from PIL import Image, ImageDraw
    im = Image.open(ref.path).convert("RGB")
    sw, sh = im.size
    sr, br = sw / sh, box_w / box_h
    S = OUT_SCALE
    W, H = max(1, round(box_w * S)), max(1, round(box_h * S))
    if mode == "fit":
        if sr > br:
            dw, dh = box_w, box_w / sr
        else:
            dw, dh = box_h * sr, box_h
        ppp = sw / dw
        canvas = Image.new("RGB", (W, H), "#" + pad.lstrip("#"))
        rs = im.resize((max(1, round(dw * S)), max(1, round(dh * S))), Image.LANCZOS)
        ox, oy = (W - rs.size[0]) // 2, (H - rs.size[1]) // 2
        canvas.paste(rs, (ox, oy))
        rect = (ox / W, oy / H, rs.size[0] / W, rs.size[1] / H)
    else:
        frac = 1 - min(sr / br, br / sr)
        if frac > MAX_CROP:
            deck._img_issue("warn", page, ref, f"源图比例与框相差大，裁掉约{frac:.0%}",
                            f"按 ratio=\"{ref.ratio}\" 重新生成图片（建议尺寸 {RATIO_PX.get(ref.ratio, '')}）")
        if sr > br:
            cw, ch = sh * br, sh
        else:
            cw, ch = sw, sw / br
        x0, y0 = (sw - cw) / 2, (sh - ch) / 2
        im = im.crop((round(x0), round(y0), round(x0 + cw), round(y0 + ch)))
        ppp = cw / box_w
        canvas = im.resize((W, H), Image.LANCZOS)
        rect = (0.0, 0.0, 1.0, 1.0)
    if ppp < MIN_PX_PER_PT:
        deck._img_issue("warn", page, ref, f"分辨率不足（每pt约{ppp:.1f}像素，要求≥{MIN_PX_PER_PT}）",
                        f"换更清晰的图，或按 {RATIO_PX.get(ref.ratio, '更高')} 重新生成")
    if overlay:
        solid = Image.new("RGB", canvas.size, "#" + overlay)
        lim = 1.05 / 4.6 - 0.05   # 白字对比度 ≥4.6 时允许的最大亮度（留余量）
        for a in (0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 1.0):
            out = Image.blend(canvas, solid, a)
            if _max_lum(out) <= lim:
                break
        canvas = out
    canvas = canvas.convert("RGBA")
    if rounded:
        mask = Image.new("L", canvas.size, 0)
        ImageDraw.Draw(mask).rounded_rectangle([0, 0, W - 1, H - 1], radius=IMG_RADIUS * S, fill=255)
        canvas.putalpha(mask)
    if border:
        ImageDraw.Draw(canvas).rounded_rectangle([0, 0, W - 1, H - 1], radius=IMG_RADIUS * S if rounded else 0,
                                                 outline="#" + LINE_GRAY, width=S)
    out_dir = os.path.join(deck.image_dir, "_processed")
    os.makedirs(out_dir, exist_ok=True)
    out = os.path.join(out_dir, f"{ref.id}_{W}x{H}{'_o' if overlay else ''}.png")
    canvas.save(out)   # 同名覆盖；save() 时清理本次没用到的旧文件
    deck._processed.add(os.path.abspath(out))
    return out, rect


def _img_placeholder(slide, ctx, ref: Optional[ImageRef], x, y, w, h, text: str = ""):
    """图片缺失时的干净占位框（显示请求编号），同时记入质检。"""
    if ref is not None:
        if ref.kind == KIND_LOCAL:
            paras = [f"缺少图片（{ref.id}）", f"请放到：{os.path.basename(ref.path)}"]
            ctx.deck._img_issue("error", ctx.page, ref, "本地图片文件不存在",
                                f"把图片保存为 {ref.path}，或改用 illustration 让 AI 生成")
        else:
            paras = [f"待生成{ref.kind}  {ref.id}", ref.subject[:20] + ("…" if len(ref.subject) > 20 else "")]
            ctx.deck._img_issue("error", ctx.page, ref, "图片尚未生成",
                                f"按 image_requests.json 生成并保存为 {ref.path}，然后重新运行")
    else:
        paras = [f"【图片占位】{text}"]
    shp = _text(slide, ctx, x, y, w, h, paras, "label", fill=LIGHT, line=GRAY, color=GRAY,
                kind=MSO_SHAPE.ROUNDED_RECTANGLE)
    shp.line.dash_style = MSO_LINE_DASH_STYLE.DASH
    shp.adjustments[0] = min(0.5, IMG_RADIUS / max(1, min(w, h)))
    for p in shp.text_frame.paragraphs:
        p.alignment = PP_ALIGN.CENTER
    return shp


def _place_image(slide, ctx, ref: Optional[ImageRef], x, y, w, h, mode, rounded=True, border=True,
                 overlay=None, text="", pad="FFFFFF"):
    """放置图片（存在则处理后插入，不存在则画占位框）。返回内容相对矩形或 None。"""
    if ref is not None and ref.exists():
        ctx.deck._use(ref, ctx.page)
        path, rect = _process_image(ctx.deck, ref, w, h, ctx.page, mode, rounded, border, overlay, pad)
        slide.shapes.add_picture(path, Pt(x), Pt(y), Pt(w), Pt(h))
        return rect
    if ref is not None:
        ctx.deck._use(ref, ctx.page)
    _img_placeholder(slide, ctx, ref, x, y, w, h, text)
    return None


# =====================================================================
# 四、内容组件（Block）：放进 deck.slide(...) 的 blocks 列表
# =====================================================================
class Block:
    name = "组件"
    wide = False   # True：两个组件时优先上下排列
    flex = False   # True：可伸缩，占满剩余空间（如图片）

    def validate(self, ctx: _Ctx, w: float) -> None: ...
    def measure(self, w: float, ctx=None) -> float: return 0
    def render(self, slide, ctx: _Ctx, x, y, w, h) -> None: ...
    def texts(self) -> List[str]: return []

    def _fit(self, ctx, w, h_avail):
        need = self.measure(w, ctx)
        if need > h_avail + 0.5:
            ctx.err(self.name, f"内容高度需要约{need:.0f}pt，可用{h_avail:.0f}pt（放不下）",
                    "删减文字、减少条目，或把内容拆到下一页；不要缩小字号")
        return need


@dataclass
class Callout:
    """图片标注：text 为标注文字（≤16字）；x、y 为被标注部位在图片中的相对位置（0~1，左上角为 0,0）。"""
    text: str
    x: float
    y: float


@dataclass
class Evidence(Block):
    """一页里"断言 + 证据"的证据部分：用一张图支撑标题里的结论。

    image: 必须是 deck.image(...)（本地图片）或 deck.illustration(...)（插图）的返回值；
           还没有图时用 placeholder 写明应放什么图。尺寸、位置、裁切全部由系统决定。
    callouts: 标注，≤4 个，每个 ≤16 字；x、y 是被标注部位在图片里的相对位置（0~1）。
              部位必须可信时再用：本地图片可以标，AI 插图的部位不保证准确。
    caption: 图注，可选。标注+图注总字数 ≤40。图片下方会自动加来源标签（本地图片 / 插图）。
    """
    image: Optional[ImageRef] = None
    placeholder: str = ""
    callouts: List[Callout] = field(default_factory=list)
    caption: str = ""
    name = "断言+证据"
    flex = True
    LABEL_W = 176

    def texts(self):
        return [c.text for c in self.callouts] + [self.caption, self.placeholder]

    def validate(self, ctx, w):
        if isinstance(self.image, str):
            ctx.err(self.name, f"image 直接写了路径「{self.image}」",
                    "本地图片用 image=deck.image(路径, source=...)；AI 插图用 image=deck.illustration(画面描述)")
        if self.image is not None and not isinstance(self.image, ImageRef):
            ctx.err(self.name, f"image 类型不对：{self.image!r}", "用 deck.image(...) 或 deck.illustration(...) 的返回值")
        if not self.image and not self.placeholder:
            ctx.err(self.name, "既没有图片也没有占位说明", "提供 image=deck.image(...)/deck.illustration(...)，或用 placeholder 写明应放的图")
        if self.image and self.image.kind == KIND_MOOD:
            ctx.err(self.name, "氛围图不能作为证据", "证据用本地图片 deck.image() 或插图 deck.illustration()；氛围图只用于封面/章节页/互动页 decor")
        if len(self.callouts) > 4:
            ctx.err(self.name, f"标注{len(self.callouts)}个，超过4个", "只保留最关键的4个标注，其余放讲者备注")
        for c in self.callouts:
            _check_text(ctx, self.name, "标注", c.text, 16)
            if not (0 <= c.x <= 1 and 0 <= c.y <= 1):
                ctx.err(self.name, f"标注「{c.text}」位置超出0~1", "x、y 填被标注部位在图中的相对位置，0~1之间")
        _check_text(ctx, self.name, "图注", self.caption, 40, allow_empty=True)
        total = sum(_n(c.text) for c in self.callouts) + _n(self.caption)
        if total > 40:
            ctx.err(self.name, f"标注与图注共{total}字，超过40字", "删减文字，详细解释写进讲者备注")
        ncol = sum(1 for side in self._sides() if side)
        if self.callouts and w - ncol * (self.LABEL_W + 32) < 160:
            ctx.err(self.name, "区域太窄，放不下图片和标注", "让该组件独占一页，或去掉另一个组件")

    def _sides(self):
        """标注按位置分到左右两侧：被标注点在图片左半边的放左侧，否则放右侧，避免引线穿过图片。"""
        left = [c for c in self.callouts if c.x < 0.5]
        right = [c for c in self.callouts if c.x >= 0.5]
        return left, right

    def _caption_text(self):
        tag = self.image.tag() if self.image else ""
        return "｜".join(t for t in (tag, self.caption) if t)

    def measure(self, w, ctx=None):
        t = self._caption_text()
        cap = box_height([t], "small", w)[0] + 8 if t else 0
        return 160 + cap

    def _place_labels(self, slide, ctx, items, lx, iy, ih, ix, iw, side):
        if not items:
            return
        items = sorted(items, key=lambda c: c.y)
        hs = [box_height([c.text], "label", self.LABEL_W)[0] for c in items]
        ys = []
        for k, (c, hh) in enumerate(zip(items, hs)):   # 标签中心尽量与被标注点同高，且互不重叠
            cy = iy + c.y * ih - hh / 2
            if ys:
                cy = max(cy, ys[-1] + hs[k - 1] + 8)
            ys.append(max(iy, cy))
        bottom = max(iy + ih, iy + sum(hs) + 8 * (len(hs) - 1))
        over = ys[-1] + hs[-1] - bottom
        if over > 0:
            ys = [v - over for v in ys]
        for c, hh, ly in zip(items, hs, ys):
            ax, ay = ix + c.x * iw, iy + c.y * ih
            ex = lx if side == "R" else lx + self.LABEL_W
            ln = slide.shapes.add_connector(MSO_CONNECTOR.STRAIGHT, Pt(ax), Pt(ay), Pt(ex), Pt(ly + hh / 2))
            _nostyle(ln)
            ln.line.color.rgb = _rgb(ctx.c["primary"])
            ln.line.width = Pt(1.25)
            _shape(slide, MSO_SHAPE.OVAL, ax - 4, ay - 4, 8, 8, fill=ctx.c["primary"])
            _text(slide, ctx, lx, ly, self.LABEL_W, hh, [c.text], "label", fill=WHITE, line=ctx.c["primary"])

    def render(self, slide, ctx, x, y, w, h):
        left, right = self._sides()
        ncol = (1 if left else 0) + (1 if right else 0)
        side_w = self.LABEL_W + 32
        cap_t = self._caption_text()
        cap_h = box_height([cap_t], "small", w)[0] if cap_t else 0
        area_w = w - ncol * side_w
        area_h = h - (cap_h + 8 if cap_t else 0)
        ratio = RATIOS[self.image.ratio] if self.image else 4 / 3
        iw = min(area_w, area_h * ratio)
        ih = iw / ratio
        group_w = iw + ncol * side_w
        gx = x + (w - group_w) / 2
        ix = gx + (side_w if left else 0)
        iy = y + (area_h - ih) / 2 if not self.callouts else y
        mode = "fit" if (self.image and self.image.kind == KIND_LOCAL) else "crop"
        rect = _place_image(slide, ctx, self.image, ix, iy, iw, ih, mode, text=self.placeholder)
        if cap_t:
            cap = _text(slide, ctx, x, iy + ih + 8, w, cap_h, [cap_t], "small")
            cap.text_frame.paragraphs[0].alignment = PP_ALIGN.CENTER
        # 标注坐标相对于"图片内容"，本地图片留白时按实际内容区换算
        rx, ry, rw, rh = rect if rect else (0, 0, 1, 1)
        cx, cy, cw2, ch2 = ix + rx * iw, iy + ry * ih, rw * iw, rh * ih
        self._place_labels(slide, ctx, left, gx, cy, ch2, cx, cw2, "L")
        self._place_labels(slide, ctx, right, ix + iw + 32, cy, ch2, cx, cw2, "R")


@dataclass
class Definition(Block):
    """概念定义卡片。term ≤12字；definition ≤60字（写完整短语）；note 为补充说明（≤40字，可选）。"""
    term: str
    definition: str
    note: str = ""
    name = "概念定义"

    def texts(self):
        return [self.term, self.definition, self.note]

    def validate(self, ctx, w):
        _check_text(ctx, self.name, "术语", self.term, 12)
        _check_text(ctx, self.name, "定义", self.definition, 60)
        _check_text(ctx, self.name, "补充说明", self.note, 40, allow_empty=True)

    def _parts(self, w):
        inner = w - 8
        lab = box_height(["概念"], "small", inner)[0]
        card = box_height([self.term, self.definition], "card", inner, para_gap=8)[0]
        note = box_height([self.note], "small", w)[0] + 16 if self.note else 0
        return lab, card, note

    def measure(self, w, ctx=None):
        lab, card, note = self._parts(w)
        return lab + 8 + card + note

    def render(self, slide, ctx, x, y, w, h):
        lab, card, note = self._parts(w)
        _text(slide, ctx, x, y, w, lab, ["概念"], "small")
        cy = y + lab + 8
        _shape(slide, MSO_SHAPE.RECTANGLE, x, cy, 8, card, fill=ctx.c["primary"])
        shp = _text(slide, ctx, x + 8, cy, w - 8, card, [self.term, self.definition], "card",
                    fill=LIGHT, para_gap=8)
        r = shp.text_frame.paragraphs[0].runs[0]
        _set_run(r, ctx.sizes["body"], True, ctx.c["primary"], ctx.font)
        if self.note:
            _text(slide, ctx, x, cy + card + 16, w, note - 16, [self.note], "small")


@dataclass
class Bullets(Block):
    """要点列表（不是默认选项，能画成图时优先用 Evidence）。

    items: 2–5 条，每条 ≤20 字，且必须单行放得下。
    relation: 条目关系，"并列" / "顺序" / "递进" / "因果"。
    """
    items: List[str]
    relation: Literal["并列", "顺序", "递进", "因果"] = "并列"
    name = "要点列表"

    def texts(self):
        return list(self.items)

    def validate(self, ctx, w):
        if self.relation not in ("并列", "顺序", "递进", "因果"):
            ctx.err(self.name, f"relation=「{self.relation}」不合法", "只能是：并列 / 顺序 / 递进 / 因果")
        if not 2 <= len(self.items) <= 5:
            ctx.err(self.name, f"条目{len(self.items)}条，要求2–5条", "超过5条请拆页；只有1条请改用断言标题或概念定义")
        for it in self.items:
            _check_text(ctx, self.name, "条目", it, 20)
            if len(wrap(it, _size(ctx, "body"), w - BADGE - 16)) > 1:
                ctx.err(self.name, f"条目「{it[:10]}…」在当前宽度放不下一行",
                        "缩短该条，或让列表独占整页宽度（去掉并排的另一个组件）")

    def _arrow(self):
        return self.relation in ("递进", "因果")

    def measure(self, w, ctx=None):
        row = max(BADGE, _line_h(_size(ctx, "body")))
        gap = 24 if self._arrow() else 16
        return len(self.items) * row + (len(self.items) - 1) * gap

    def render(self, slide, ctx, x, y, w, h):
        row = max(BADGE, _line_h(_size(ctx, "body")))
        gap = 24 if self._arrow() else 16
        for i, it in enumerate(self.items):
            ry = y + i * (row + gap)
            if self.relation == "并列":
                _shape(slide, MSO_SHAPE.RECTANGLE, x + 12, ry + row / 2 - 4, 8, 8, fill=ctx.c["primary"])
            else:
                _badge(slide, ctx, x, ry + (row - BADGE) / 2, str(i + 1))
            t = _text(slide, ctx, x + BADGE + 16, ry, w - BADGE - 16, row, [it], "body")
            t.text_frame.vertical_anchor = MSO_ANCHOR.MIDDLE
            if self._arrow() and i < len(self.items) - 1:
                _shape(slide, MSO_SHAPE.DOWN_ARROW, x + BADGE / 2 - 6, ry + row + 4, 12, 16, fill=GRAY)


@dataclass
class Step:
    """一个操作步骤。action：做什么（动词开头，≤12字）；key_points：要点 0–2 条（每条≤20字）；
    reason：为什么（写出具体后果，≤30字，禁止"为了安全""保证质量"这类空话）。"""
    action: str
    key_points: List[str] = field(default_factory=list)
    reason: str = ""


@dataclass
class Steps(Block):
    """步骤流程（操作步骤、工序、流程）。每页 3–6 步；整项流程超过 9 步请拆成两个。"""
    steps: List[Step]
    name = "步骤流程"
    wide = True

    def texts(self):
        out = []
        for s in self.steps:
            out += [s.action, s.reason] + list(s.key_points)
        return out

    def validate(self, ctx, w):
        if not 3 <= len(self.steps) <= 6:
            ctx.err(self.name, f"本页{len(self.steps)}步，要求3–6步", "超过6步请拆成两页（第2页标题加\"（续）\"）；少于3步改用要点列表")
        for i, s in enumerate(self.steps, 1):
            _check_text(ctx, self.name, f"第{i}步动作", s.action, 12)
            if len(s.key_points) > 2:
                ctx.err(self.name, f"第{i}步要点{len(s.key_points)}条，超过2条", "只保留成败关键的2条")
            for k in s.key_points:
                _check_text(ctx, self.name, f"第{i}步要点", k, 20)
            _check_text(ctx, self.name, f"第{i}步理由", s.reason, 30, allow_empty=True)
            r = s.reason.strip("。，. ")
            if r and (r in EMPTY_REASONS or len(r) <= 4):
                ctx.err(self.name, f"第{i}步理由「{s.reason}」太空泛", "写出具体后果，例如\"防止带电部件误触导致触电\"")

    def _cols(self, w):
        aw = round(w * 0.32)
        return aw, w - BADGE - 16 - aw - 24

    def _detail(self, s):
        out = [f"要点：{k}" for k in s.key_points]
        if s.reason:
            out.append(f"理由：{s.reason}")
        return out

    def _row_h(self, s, w):
        aw, dw = self._cols(w)
        a = box_height([s.action], "strong", aw)[0]
        d = box_height(self._detail(s), "small", dw)[0] if self._detail(s) else 0
        return max(BADGE, a, d)

    def measure(self, w, ctx=None):
        return sum(self._row_h(s, w) for s in self.steps) + 17 * (len(self.steps) - 1)

    def render(self, slide, ctx, x, y, w, h):
        aw, dw = self._cols(w)
        cy = y
        for i, s in enumerate(self.steps, 1):
            rh = self._row_h(s, w)
            _badge(slide, ctx, x, cy, str(i))
            _text(slide, ctx, x + BADGE + 16, cy, aw, rh, [s.action], "strong")
            det = self._detail(s)
            if det:
                _text(slide, ctx, x + BADGE + 16 + aw + 24, cy + 3, dw, rh, det, "small")
            cy += rh
            if i < len(self.steps):
                _hline(slide, x + BADGE + 16, cy + 8, x + w)
                cy += 17


@dataclass
class Compare(Block):
    """对比。headers：2–3 个对比对象；rows：[(维度名, [各列内容…]), …]，2–5 个维度，每格 ≤15 字。
    marks：可选，如 ["✓", "✗"]，正误对比时必须提供（不能只靠颜色区分）。"""
    headers: List[str]
    rows: List[Tuple[str, List[str]]]
    marks: Optional[List[str]] = None
    name = "对比"
    wide = True

    def texts(self):
        out = list(self.headers)
        for d, cells in self.rows:
            out += [d] + list(cells)
        return out

    def validate(self, ctx, w):
        if not 2 <= len(self.headers) <= 3:
            ctx.err(self.name, f"对比对象{len(self.headers)}个，要求2–3个", "超过3个请改用表格")
        if not 2 <= len(self.rows) <= 5:
            ctx.err(self.name, f"对比维度{len(self.rows)}个，要求2–5个", "删减维度或拆页")
        for h in self.headers:
            _check_text(ctx, self.name, "对比对象", h, 10)
        if self.marks and len(self.marks) != len(self.headers):
            ctx.err(self.name, "marks 数量与 headers 不一致", "每个对比对象给一个标记，如 [\"✓\", \"✗\"]")
        for d, cells in self.rows:
            _check_text(ctx, self.name, "维度名", d, 6)
            if len(cells) != len(self.headers):
                ctx.err(self.name, f"维度「{d}」有{len(cells)}格，应为{len(self.headers)}格", "每个维度必须逐列填写，不能空缺")
            for c in cells:
                _check_text(ctx, self.name, f"「{d}」单元格", c, 15)

    def _geom(self, w):
        dw = 128
        cw = (w - dw - 8 * len(self.headers)) / len(self.headers)
        return dw, cw

    def _row_hs(self, w):
        dw, cw = self._geom(w)
        heads = [(f"{m} " if self.marks else "") + h for h, m in zip(self.headers, self.marks or [""] * 9)]
        hh = max(box_height([t], "head", cw)[0] for t in heads)
        rhs = [max([box_height([d], "label", dw)[0]] + [box_height([c], "card", cw)[0] for c in cells])
               for d, cells in self.rows]
        return heads, hh, rhs

    def measure(self, w, ctx=None):
        _, hh, rhs = self._row_hs(w)
        return hh + sum(rhs) + 8 * len(rhs)

    def render(self, slide, ctx, x, y, w, h):
        dw, cw = self._geom(w)
        heads, hh, rhs = self._row_hs(w)
        fills = [ctx.c["primary"], GRAY, ctx.c["accent"]]
        for j, t in enumerate(heads):
            _text(slide, ctx, x + dw + 8 + j * (cw + 8), y, cw, hh, [t], "head", fill=fills[j])
        cy = y + hh + 8
        for (d, cells), rh in zip(self.rows, rhs):
            _text(slide, ctx, x, cy, dw, rh, [d], "label", bold=True)
            for j, c in enumerate(cells):
                _text(slide, ctx, x + dw + 8 + j * (cw + 8), cy, cw, rh, [c], "card", fill=LIGHT)
            cy += rh + 8


@dataclass
class Example(Block):
    """示例讲解：把一道题或一个任务的分步做法讲清楚。problem ≤80字；steps ≤5 步、每步 ≤30字、不能跳步；answer ≤30字。
    blank_from：可选，从第几步起留空，请听众现场补全（完整步骤自动写入讲者备注）。"""
    problem: str
    steps: List[str]
    answer: str
    blank_from: Optional[int] = None
    name = "示例讲解"
    wide = True

    def texts(self):
        return [self.problem, self.answer] + list(self.steps)

    def validate(self, ctx, w):
        _check_text(ctx, self.name, "题干", self.problem, 80)
        if not 1 <= len(self.steps) <= 5:
            ctx.err(self.name, f"步骤{len(self.steps)}步，每页最多5步", "拆成两页（第2页标题加\"（续）\"）")
        for i, s in enumerate(self.steps, 1):
            _check_text(ctx, self.name, f"第{i}步", s, 30)
        _check_text(ctx, self.name, "答案", self.answer, 30)
        if self.blank_from is not None and not 1 <= self.blank_from <= len(self.steps):
            ctx.err(self.name, "blank_from 超出步骤范围", f"填 1–{len(self.steps)} 之间的步骤序号，或不填")

    def _shown(self):
        out = []
        for i, s in enumerate(self.steps, 1):
            out.append("________（请补全）" if self.blank_from and i >= self.blank_from else s)
        return out

    def _parts(self, w):
        pb = box_height([f"示例　{self.problem}"], "card", w)[0]
        sh = [box_height([s], "body", w - BADGE - 16)[0] for s in self._shown()]
        ans = box_height([f"结论：{self.answer}"], "card", w)[0]
        return pb, sh, ans

    def measure(self, w, ctx=None):
        pb, sh, ans = self._parts(w)
        return pb + 16 + sum(max(BADGE, s) for s in sh) + 8 * (len(sh) - 1) + 16 + ans

    def render(self, slide, ctx, x, y, w, h):
        pb, sh, ans = self._parts(w)
        shp = _text(slide, ctx, x, y, w, pb, [self.problem], "card", fill=LIGHT)
        _lead(shp.text_frame.paragraphs[0], "示例　", ctx.c["primary"])
        cy = y + pb + 16
        for i, (s, hh) in enumerate(zip(self._shown(), sh), 1):
            rh = max(BADGE, hh)
            _badge(slide, ctx, x, cy, str(i))
            t = _text(slide, ctx, x + BADGE + 16, cy, w - BADGE - 16, rh, [s], "body")
            t.text_frame.vertical_anchor = MSO_ANCHOR.MIDDLE
            cy += rh + 8
        cy += 8
        a = _text(slide, ctx, x, cy, w, ans, [f"结论：{self.answer}"], "card",
                  fill=_tint(ctx.c["accent"], 0.12), line=ctx.c["accent"])
        _set_run(a.text_frame.paragraphs[0].runs[0], _size(ctx, "body"), True, ctx.tokens["text"], ctx.font)


@dataclass
class Question(Block):
    """现场提问（投票、思考题、互动问答）。
    kind: "选择" / "判断" / "简答"；options：选择题 2–4 个（每个≤20字），判断题自动为 正确/错误。
    answer、explanation 必填（解析≤60字）。
    答案与解析会自动生成在下一页，并写入讲者备注。"""
    question: str
    kind: Literal["选择", "判断", "简答"]
    answer: str
    explanation: str
    options: List[str] = field(default_factory=list)
    name = "互动问题"

    def texts(self):
        return [self.question, self.answer, self.explanation] + list(self.options)

    def _opts(self):
        return ["正确", "错误"] if self.kind == "判断" and not self.options else self.options

    def validate(self, ctx, w):
        if self.kind not in ("选择", "判断", "简答"):
            ctx.err(self.name, f"kind=「{self.kind}」不合法", "只能是：选择 / 判断 / 简答")
        _check_text(ctx, self.name, "题干", self.question, 60)
        _check_text(ctx, self.name, "答案", self.answer, 30)
        _check_text(ctx, self.name, "解析", self.explanation, 60)
        if self.kind == "选择" and not 2 <= len(self.options) <= 4:
            ctx.err(self.name, f"选择题选项{len(self.options)}个，要求2–4个", "调整选项数量")
        if self.kind == "简答" and self.options:
            ctx.err(self.name, "简答题不应有选项", "去掉 options，或改为选择题")
        for o in self._opts():
            _check_text(ctx, self.name, "选项", o, 20)

    def _parts(self, w):
        q = box_height([self.question], "card", w)[0]
        ow = (w - 16) / 2 if len(self._opts()) >= 3 else w
        oh = [box_height([o], "card", ow - BADGE - 8)[0] for o in self._opts()]
        return q, ow, oh

    def measure(self, w, ctx=None):
        q, ow, oh = self._parts(w)
        tag = 32 + 8
        if not oh:
            return tag + q + 16 + _line_h(_size(ctx, "small"))
        if len(oh) >= 3:
            rows = [max(oh[i:i + 2]) for i in range(0, len(oh), 2)]
        else:
            rows = oh
        return tag + q + 16 + sum(rows) + 8 * (len(rows) - 1)

    def render(self, slide, ctx, x, y, w, h):
        q, ow, oh = self._parts(w)
        _text(slide, ctx, x, y, 112, 32, [f"{self.kind}题"], "tag", fill=ctx.c["accent"])
        cy = y + 40
        _text(slide, ctx, x, cy, w, q, [self.question], "card", fill=LIGHT)
        cy += q + 16
        opts = self._opts()
        if not opts:
            _text(slide, ctx, x, cy, w, _line_h(SIZE_SMALL), ["请先想一想，答案见下一页"], "small")
            return
        two = len(opts) >= 3
        rows = [max(oh[i:i + 2]) for i in range(0, len(oh), 2)] if two else oh
        for i, o in enumerate(opts):
            r, cidx = (i // 2, i % 2) if two else (i, 0)
            oy = cy + sum(rows[:r]) + 8 * r
            ox = x + cidx * (ow + 16)
            rh = rows[r]
            _shape(slide, MSO_SHAPE.RECTANGLE, ox, oy, ow, rh, line=LINE_GRAY)
            _badge(slide, ctx, ox + 8, oy + (rh - BADGE) / 2, "ABCD"[i] if self.kind != "判断" else "✓✗"[i])
            _text(slide, ctx, ox + BADGE + 8, oy, ow - BADGE - 8, rh, [o], "card")


@dataclass
class Alert(Block):
    """警示框（风险提示、注意事项、易错点）。level："提示" / "注意" / "警告" / "危险"（严重程度递增）。
    subject（提示什么）、impact（会造成什么后果）、action（怎么避免）三段必填，每段 ≤25 字。
    警示色只在本组件出现，配色由等级决定。"""
    level: Literal["提示", "注意", "警告", "危险"]
    subject: str
    impact: str
    action: str
    name = "警示框"

    def texts(self):
        return [self.subject, self.impact, self.action]

    def validate(self, ctx, w):
        if self.level not in ALERT:
            ctx.err(self.name, f"level=「{self.level}」不合法", "只能是：提示 / 注意 / 警告 / 危险")
        for k, v in (("提示内容", self.subject), ("可能后果", self.impact), ("怎么避免", self.action)):
            _check_text(ctx, self.name, k, v, 25)

    LAB_W = 112
    PANEL_W = 120   # 宽版：左侧信号词色块宽度

    def _wide(self, w):
        return w >= 600

    def _tw(self, w):
        return w - self.LAB_W - 48 - (self.PANEL_W if self._wide(w) else 0)

    def _rows(self, w):
        return [box_height([t], "body", self._tw(w))[0] for t in self.texts()]

    def measure(self, w, ctx=None):
        body = sum(self._rows(w)) + 8 * 2 + 32
        return body if self._wide(w) else 48 + body

    def render(self, slide, ctx, x, y, w, h):
        s = ALERT[self.level]
        total = self.measure(w, ctx)
        _shape(slide, MSO_SHAPE.RECTANGLE, x, y, w, total, fill=WHITE, line=s["bg"], line_w=2)
        if self._wide(w):
            hd = _text(slide, ctx, x, y, self.PANEL_W, total, ["⚠", s["word"]], "head",
                       fill=s["bg"], color=s["fg"])
            bx, cy = x + self.PANEL_W, y + 16
        else:
            hd = _text(slide, ctx, x, y, w, 48, [f"⚠  {s['word']}"], "card", fill=s["bg"], color=s["fg"])
            _set_run(hd.text_frame.paragraphs[0].runs[0], SIZE_BODY, True, s["fg"])
            bx, cy = x, y + 48 + 16
        for lab, t, rh in zip(("提示内容", "可能后果", "怎么避免"), self.texts(), self._rows(w)):
            lb = _text(slide, ctx, bx + 16, cy, self.LAB_W, _line_h(SIZE_BODY), [lab], "small",
                       bold=True, color=TEXT)
            lb.text_frame.vertical_anchor = MSO_ANCHOR.MIDDLE
            _text(slide, ctx, bx + 16 + self.LAB_W + 16, cy, self._tw(w), rh, [t], "body")
            cy += rh + 8


@dataclass
class Table(Block):
    """表格（参数表、规格表、对照表）。headers ≤5 列；rows ≤6 行；每格 ≤12 字；不支持合并单元格。"""
    headers: List[str]
    rows: List[List[str]]
    name = "表格"
    wide = True

    def texts(self):
        return list(self.headers) + [c for r in self.rows for c in r]

    def validate(self, ctx, w):
        if not 2 <= len(self.headers) <= 5:
            ctx.err(self.name, f"{len(self.headers)}列，要求2–5列", "拆成两张表，或改用图表")
        if not 1 <= len(self.rows) <= 6:
            ctx.err(self.name, f"{len(self.rows)}行，最多6行", "拆成两页（第2页标题加\"（续）\"）")
        for t in self.headers:
            _check_text(ctx, self.name, "表头", t, 12)
        for r in self.rows:
            if len(r) != len(self.headers):
                ctx.err(self.name, f"某行有{len(r)}格，应为{len(self.headers)}格", "每行格数必须与表头一致；不支持合并单元格，空格请填\"—\"")
            for c in r:
                _check_text(ctx, self.name, "单元格", c, 12)

    def _hs(self, w):
        cw = w / len(self.headers)
        out = []
        for r in [self.headers] + self.rows:
            out.append(max(box_height([c], "label", cw)[0] for c in r) + 8)
        return out

    def measure(self, w, ctx=None):
        return sum(self._hs(w))

    def render(self, slide, ctx, x, y, w, h):
        hs = self._hs(w)
        nr, nc = len(self.rows) + 1, len(self.headers)
        gf = slide.shapes.add_table(nr, nc, Pt(x), Pt(y), Pt(w), Pt(sum(hs)))
        tbl = gf.table
        tblPr = tbl._tbl.tblPr
        for attr in ("bandRow", "firstRow"):
            tblPr.set(attr, "0")
        style = tblPr.find(qn("a:tableStyleId"))
        if style is not None:
            style.text = "{5940675A-B579-460E-94D1-54222C63F5DA}"  # 无样式、细网格
        for j in range(nc):
            tbl.columns[j].width = Pt(w / nc)
        for i, row in enumerate([self.headers] + self.rows):
            tbl.rows[i].height = Pt(hs[i])
            for j, val in enumerate(row):
                cell = tbl.cell(i, j)
                cell.margin_left = cell.margin_right = Pt(8)
                cell.margin_top = cell.margin_bottom = Pt(4)
                cell.vertical_anchor = MSO_ANCHOR.MIDDLE
                cell.fill.solid()
                cell.fill.fore_color.rgb = _rgb(ctx.c["primary"] if i == 0 else (WHITE if i % 2 else LIGHT))
                p = cell.text_frame.paragraphs[0]
                p.line_spacing = Pt(_line_h(_size(ctx, "small")))
                r = p.add_run()
                r.text = val
                _set_run(r, _size(ctx, "small"), i == 0, WHITE if i == 0 else ctx.tokens["text"], ctx.font)


# =====================================================================
# 五、Deck：整份演示文稿
# =====================================================================
@dataclass
class _SlideRec:
    page: int
    kind: str
    title: str
    source: str = ""
    source_note: str = ""
    notes: str = ""
    blocks: List[Block] = field(default_factory=list)
    extra_texts: List[str] = field(default_factory=list)
    auto: bool = False


class Deck:
    """整份演示文稿。按顺序调用 cover / points / section / slide / summary，最后 save()。

    title: 演示文稿所属的项目、课程或文档名（显示在封面）；source: 每页来源标注的前缀
    （文档名、版本、出处等，可留空）；theme: "深蓝" / "墨绿" / "石墨"。
    """

    def __init__(self, title: str, source: str = "", theme="深蓝",
                 image_dir: str = "images", **tokens):
        self.tokens = _build_tokens(theme, tokens)
        self.title, self.source = title, source
        self.theme = theme if isinstance(theme, str) else "自定义令牌"
        self.colors = {"primary": self.tokens["primary"], "accent": self.tokens["accent"]}
        self.sizes = self.tokens["sizes"]
        self.roles = _roles_for(self.sizes)
        self.prs = Presentation()
        self.prs.slide_width, self.prs.slide_height = Pt(SLIDE_W), Pt(SLIDE_H)
        self.recs: List[_SlideRec] = []
        self._quiz_no = 0
        self.image_dir = image_dir          # AI 图片都放这里；本地图片可以放任意位置
        self.images: dict = {}              # id -> ImageRef（三类图片）
        self.image_pages: dict = {}         # id -> [页码]
        self.img_errors: List[str] = []
        self.img_warnings: List[str] = []
        self.errors: List[str] = []         # 排版/内容错误：一次收集齐，save() 统一报
        self.failed_pages: List[int] = []   # 校验没过、未渲染的页
        self.n_decor = 0
        self._processed = set()

    # ---------- 内部：页面骨架 ----------
    def _new(self):
        s = self.prs.slides.add_slide(self.prs.slide_layouts[6])
        if self.tokens["bg"] != WHITE:
            s.background.fill.solid()
            s.background.fill.fore_color.rgb = _rgb(self.tokens["bg"])
        return s, _Ctx(self, len(self.prs.slides))

    def _page_no(self):
        return len(self.prs.slides) + 1

    def _check_title(self, ctx, title, comp="页面标题"):
        _check_text(ctx, comp, "标题", title, 32)
        if len(wrap(title, _size(ctx, "title"), CONTENT_W)) > 2:
            ctx.err(comp, f"标题「{title[:10]}…」超过2行", "精简成一句结论（≤2行），多出的信息拆到下一页；不要缩小字号")
        for t in self.recs:
            if t.title == title:
                ctx.err(comp, f"标题与第{t.page}页重复", "每页标题必须唯一，写出这一页独有的结论")

    def _frame(self, slide, ctx, title, source, source_note):
        if self.tokens["chrome"]:
            _shape(slide, MSO_SHAPE.RECTANGLE, 0, 0, SLIDE_W, 8, fill=ctx.c["primary"])
            _hline(slide, X0, FOOT_Y - 4, X1)
        _text(slide, ctx, X0, TITLE_Y, CONTENT_W, TITLE_H, [title], "title")
        src = "　".join(t for t in (str(self.source or ""), str(source or "")) if t.strip())
        if src:
            src = f"来源：{src}"
        if source_note:
            src = (src + "　" if src else "") + f"【{source_note}】"
        if src and self.tokens["chrome"]:
            _text(slide, ctx, X0, FOOT_Y, CONTENT_W - 64, FOOT_H, [src], "foot",
                  color=ctx.c["accent"] if source_note else None)
        if self.tokens["chrome"]:
            n = _text(slide, ctx, X1 - 64, FOOT_Y, 64, FOOT_H, [str(ctx.page)], "foot")
            n.text_frame.paragraphs[0].alignment = PP_ALIGN.RIGHT

    def _notes(self, slide, notes):
        if notes:
            slide.notes_slide.notes_text_frame.text = notes

    def _validate_blocks(self, ctx, pairs):
        """逐个组件校验：每个组件的错误独立收集（而不是只报第一个），最后判定本页是否失败。"""
        before = len(self.errors)
        for comp, w in pairs:
            try:
                comp.validate(ctx, w)
            except _PageAbort:
                continue
        if len(self.errors) > before:
            raise _PageAbort()

    def _check_source(self, ctx, comp, source, source_note=""):
        _check_text(ctx, comp, "来源标注", source, 60, allow_empty=True)
        _check_text(ctx, comp, "来源补充说明", source_note, 20, allow_empty=True)

    def _rows(self, slide, ctx, items, y, w, x=X0, fill=LIGHT):
        cy = y
        for i, it in enumerate(items, 1):
            hh = max(BADGE + 16, box_height([it], "card", w - BADGE - 24)[0])
            _shape(slide, MSO_SHAPE.RECTANGLE, x, cy, w, hh, fill=fill)
            _badge(slide, ctx, x + 12, cy + (hh - BADGE) / 2, str(i))
            _text(slide, ctx, x + BADGE + 24, cy, w - BADGE - 24, hh, [it], "card")
            cy += hh + 16
        return cy

    def _rows_h(self, items, w):
        return sum(max(BADGE + 16, box_height([it], "card", w - BADGE - 24)[0]) for it in items) + 16 * (len(items) - 1)

    # ---------- 图片：三类图片的创建（只登记，不调用任何生图 API） ----------
    def _img_issue(self, level, page, ref, problem, fix):
        msg = f"第{page}页 | 图片 {ref.id}（{ref.kind}） | {problem} | {fix}"
        bucket = self.img_errors if level == "error" else self.img_warnings
        if msg not in bucket:
            bucket.append(msg)

    def _use(self, ref, page):
        pages = self.image_pages.setdefault(ref.id, [])
        if page not in pages:
            pages.append(page)

    def _img_err(self, problem, fix):
        raise DeckError(f"第{self._page_no()}页 | 图片 | {problem} | {fix}")

    def _check_ratio(self, ratio):
        if ratio not in RATIOS:
            self._img_err(f"ratio=「{ratio}」不合法", "只能是：16:9 / 4:3 / 1:1 / 3:4")

    def _check_subject(self, subject, kind):
        if not isinstance(subject, str) or not 4 <= _n(subject) <= 60 or "\n" in subject:
            self._img_err(f"{kind}主题「{str(subject)[:12]}」长度不合适", "用一句话（4–60字）描述画面内容：主体 + 场景 + 动作")

    def image(self, path: str, source: str = "", ratio: Optional[str] = None) -> ImageRef:
        """本地图片：调用方提供的图片文件（照片、截图、图表、既有素材）。
        系统等比放入框内（不裁切、不重绘），填了 source 就在图下标注来源。
        可以在 Evidence 里加 callouts 标注，但只在部位可信时标。"""
        if not path:
            self._img_err("图片缺少文件路径", "填写图片文件路径")
        if source and _n(str(source)) > 40:
            self._img_err(f"图片来源标注「{str(source)[:12]}…」共{_n(str(source))}字，超过上限40字",
                          "精简来源标注（页码 / 编号 / 文档名），详细出处写进讲者备注")
        if ratio is None:
            ratio = "4:3"
            if os.path.isfile(path):
                from PIL import Image
                with Image.open(path) as im:
                    r = im.size[0] / im.size[1]
                import math
                ratio = min(RATIOS, key=lambda k: abs(math.log(RATIOS[k] / r)))
        self._check_ratio(ratio)
        rid = "img_" + hashlib.sha1(os.path.abspath(path).encode()).hexdigest()[:6]
        ref = ImageRef(KIND_LOCAL, rid, path, ratio, subject=os.path.basename(path), source=str(source or ""))
        self.images[rid] = ref
        return ref

    def _prompt(self, kind, subject, ratio):
        cn, en = THEME_DESC[self.theme]
        no_text_cn = "画面中不得出现任何文字、汉字、字母、数字、标志、水印、签名"
        no_text_en = "no text, no letters, no Chinese characters, no numbers, no logos, no watermark"
        if kind == KIND_ILLU:
            style = (f"扁平矢量插画风格，主色调为{cn}，辅以浅灰与白色，干净的浅色纯色背景，"
                     f"主体居中、轮廓清晰、细节适中，适合投屏展示；{no_text_cn}。")
            neg_cn = ("不要画图表、公式、刻度、读数等需要准确的数据内容，不要做结构标注；"
                      "只表现概念或场景")
            en_s = (f"Flat vector illustration, limited palette of {en} with light gray and white, "
                    f"clean plain light background, centered subject, clear shapes, screen projection friendly. "
                    f"{no_text_en}, no charts, no data visualizations, no formulas, no scales, no labels.")
            negative = ("text, letters, numbers, watermark, logo, charts, data visualizations, formulas, "
                        "scales, labels, photorealistic, cluttered background")
        else:
            style = (f"扁平矢量插画风格，主色调为{cn}，低细节、低对比、柔和留白，作为背景装饰使用，"
                     f"主体偏向画面一侧，大面积简洁背景，{no_text_cn}。")
            neg_cn = "不要人物特写、不要高对比细碎纹理、不要任何需要准确的数据内容"
            en_s = (f"Flat vector illustration, low detail, low contrast, soft and calm, limited palette of {en}, "
                    f"large empty background area for text overlay, subject off to one side. {no_text_en}.")
            negative = "text, letters, numbers, watermark, logo, high contrast clutter, busy texture, photorealistic faces"
        prompt = f"{subject}。{style}禁止：{neg_cn}。画幅比例 {ratio}（建议 {RATIO_PX[ratio]} 像素）。\n{en_s}"
        return prompt, negative

    def _request(self, kind, prefix, subject, ratio):
        self._check_ratio(ratio)
        self._check_subject(subject, kind)
        rid = prefix + hashlib.sha1(f"{kind}|{subject}|{ratio}|{self.theme}".encode()).hexdigest()[:6]
        prompt, negative = self._prompt(kind, subject, ratio)
        ref = ImageRef(kind, rid, os.path.join(self.image_dir, rid + ".png"), ratio, subject, prompt, negative)
        self.images[rid] = ref
        return ref

    def illustration(self, subject: str, ratio: Literal["16:9", "4:3", "1:1", "3:4"] = "4:3") -> ImageRef:
        """插图（AI 生成）：表现概念或场景，帮助理解；图下自动标注「插图（AI生成）」。
        subject 只写画面内容，不写风格（风格、禁止项由系统拼接）。
        需要准确的内容（数据、图表、结构标注、文字）不要用插图——改用本地图片 deck.image() 或组件。"""
        return self._request(KIND_ILLU, "ill_", subject, ratio)

    def mood(self, subject: str, ratio: Literal["16:9", "4:3", "1:1", "3:4"] = "3:4") -> ImageRef:
        """氛围图（AI 生成）：只用于封面 cover(image=)、章节页 section(image=)、互动页 slide(decor=)。
        系统负责裁切和遮罩（保证文字对比度 ≥4.5:1）。默认竖版 3:4 最合适。"""
        return self._request(KIND_MOOD, "mood_", subject, ratio)

    def image_request(self, kind: Literal["插图", "氛围图"], subject: str,
                      ratio: Literal["16:9", "4:3", "1:1", "3:4"] = "4:3") -> ImageRef:
        """通用入口：等同于 illustration() / mood()。"""
        if kind == KIND_ILLU:
            return self.illustration(subject, ratio)
        if kind == KIND_MOOD:
            return self.mood(subject, ratio)
        self._img_err(f"kind=「{kind}」不能生成", "AI 只能生成 插图 / 氛围图；本地图片用 deck.image(路径, source=...)")

    def _need_mood(self, image, comp):
        if image is None:
            return
        if not isinstance(image, ImageRef):
            self._img_err(f"{comp} 的 image 必须用 deck.mood(...) 创建", "改为 image=deck.mood(\"画面描述\")")
        if image.kind != KIND_MOOD:
            self._img_err(f"{comp} 只能用氛围图，传入的是{image.kind}", "改用 deck.mood(...)；本地图片/插图请放到内容页 Evidence 里")

    def requests(self) -> List[dict]:
        """全部 AI 生图请求（插图+氛围图），即 image_requests.json 的内容。"""
        out = []
        for ref in self.images.values():
            if ref.kind == KIND_LOCAL:
                continue
            out.append(dict(id=ref.id, kind=ref.kind, ratio=ref.ratio, size=RATIO_PX[ref.ratio],
                            filename=ref.path, abs_filename=os.path.abspath(ref.path), status="已就绪" if ref.exists() else "待生成",
                            pages=self.image_pages.get(ref.id, []), subject=ref.subject,
                            prompt=ref.prompt, negative=ref.negative))
        return out

    # ---------- 1. 封面 ----------
    @_page_method
    def cover(self, title: str, subtitle: str = "", author: str = "", date: str = "", notes: str = "",
              image: Optional[ImageRef] = None) -> None:
        """封面。title ≤20字；subtitle ≤24字（可选）；author + date 合计 ≤30字；
        image：可选氛围图 deck.mood(...)，系统放在右侧图片栏。"""
        page = self._page_no()
        ctx = _Ctx(self, page)
        _check_text(ctx, "封面", "标题", title, 20)
        _check_text(ctx, "封面", "副标题", subtitle, 24, allow_empty=True)
        meta = "　".join(t for t in (author, date) if t)
        _check_text(ctx, "封面", "讲者/日期", meta, 30, allow_empty=True)
        self._need_mood(image, "封面")
        slide, ctx = self._new()
        c = ctx.c
        if image is not None:
            self._cover_image(slide, ctx, title, subtitle, meta, image)
            self._notes(slide, notes)
            self.recs.append(_SlideRec(page, "封面", title, notes=notes, extra_texts=[subtitle]))
            return
        _shape(slide, MSO_SHAPE.RECTANGLE, 0, 0, SLIDE_W, 360, fill=c["primary"])
        _shape(slide, MSO_SHAPE.RECTANGLE, X0, 120, 64, 8, fill=WHITE)
        _text(slide, ctx, X0, 144, 640, 24, [self.title], "small", color=WHITE)
        th = box_height([title], "display", 640)[0]
        _text(slide, ctx, X0, 176, 640, th, [title], "display")
        if subtitle:
            _text(slide, ctx, X0, 176 + th + 16, 640, _line_h(_size(ctx, "body")) + 4, [subtitle], "body", color=WHITE)
        if meta:
            _text(slide, ctx, X0, 392, CONTENT_W, 28, [meta], "small", color=TEXT)
        if self.source:
            _text(slide, ctx, X0, 428, CONTENT_W, 24, [f"来源：{self.source}"], "small")
        self._notes(slide, notes)
        self.recs.append(_SlideRec(page, "封面", title, notes=notes, extra_texts=[subtitle]))

    def _cover_image(self, slide, ctx, title, subtitle, meta, image):
        """带氛围图的封面：左侧主题色文字区（6/10 宽），右侧整幅图片。"""
        c = ctx.c
        pw = 576
        _shape(slide, MSO_SHAPE.RECTANGLE, 0, 0, pw, SLIDE_H, fill=c["primary"])
        _place_image(slide, ctx, image, pw, 0, SLIDE_W - pw, SLIDE_H, "crop", rounded=False, border=False)
        tw = pw - X0 - 48
        _shape(slide, MSO_SHAPE.RECTANGLE, X0, 120, 64, 8, fill=WHITE)
        _text(slide, ctx, X0, 144, tw, 24, [self.title], "small", color=WHITE)
        th = box_height([title], "display", tw)[0]
        _text(slide, ctx, X0, 176, tw, th, [title], "display")
        y = 176 + th + 16
        if subtitle:
            sh = box_height([subtitle], "body", tw)[0]
            _text(slide, ctx, X0, y, tw, sh, [subtitle], "body", color=WHITE)
        _shape(slide, MSO_SHAPE.RECTANGLE, X0, 400, tw, 1, fill=WHITE)
        if meta:
            _text(slide, ctx, X0, 412, tw, 28, [meta], "small", color=WHITE)
        if self.source:
            _text(slide, ctx, X0, 444, tw, 24, [f"来源：{self.source}"], "small", color=WHITE)

    # ---------- 2. 学习目标 ----------
    @_page_method
    def points(self, items: Sequence[str], source: str = "",
               title: str = "要点", notes: str = "") -> None:
        """整页编号条目：目标、议程、要点清单、结论清单。1–6 条，每条 ≤30 字。"""
        page = self._page_no()
        ctx = _Ctx(self, page)
        comp = "要点页"
        if not 1 <= len(items) <= 6:
            ctx.err(comp, f"{len(items)}条，要求1–6条", "超过6条请拆成两页，或改用要点列表组件")
        for it in items:
            _check_text(ctx, comp, "条目", it, 30)
        self._check_source(ctx, comp, source)
        self._check_title(ctx, title, comp)
        if self._rows_h(items, CONTENT_W) > BODY_H:
            ctx.err(comp, "内容放不下", "缩短每条内容")
        slide, ctx = self._new()
        self._frame(slide, ctx, title, source, "")
        self._rows(slide, ctx, list(items), BODY_Y0, CONTENT_W)
        self._notes(slide, notes)
        self.recs.append(_SlideRec(page, comp, title, source, notes=notes, extra_texts=list(items)))

    # ---------- 3. 章节过渡 ----------
    @_page_method
    def section(self, sections: Sequence[str], current: int, notes: str = "",
                image: Optional[ImageRef] = None) -> None:
        """章节过渡/内容导览。sections：2–8 节名称（每个≤12字）；current：当前节序号（从1开始）；
        image：可选氛围图 deck.mood(...)，系统铺满左侧色块并加主题色遮罩保证白字可读。"""
        page = self._page_no()
        ctx = _Ctx(self, page)
        comp = "章节过渡"
        if not 2 <= len(sections) <= 8:
            ctx.err(comp, f"{len(sections)}节，要求2–8节", "合并或拆分章节")
        for s in sections:
            _check_text(ctx, comp, "节名", s, 12)
        if not 1 <= current <= len(sections):
            ctx.err(comp, f"current={current} 超出范围", f"填 1–{len(sections)}")
        title = f"第{current}部分　{sections[current - 1]}"
        for t in self.recs:
            if t.title == title:
                ctx.err(comp, f"与第{t.page}页重复", "同一节只放一次过渡页")
        self._need_mood(image, "章节过渡")
        slide, ctx = self._new()
        c = ctx.c
        _shape(slide, MSO_SHAPE.RECTANGLE, 0, 0, 368, SLIDE_H, fill=c["primary"])
        if image is not None:
            if image.exists():
                _place_image(slide, ctx, image, 0, 0, 368, SLIDE_H, "crop", rounded=False, border=False,
                             overlay=c["primary"])
            else:   # 缺图：保留纯色面板（文字仍可读），只在底部提示并记入质检
                self._use(image, ctx.page)
                self._img_issue("error", ctx.page, image, "图片尚未生成",
                                f"按 image_requests.json 生成并保存为 {image.path}，然后重新运行")
                _text(slide, ctx, X0, 476, 288, 24, [f"待生成氛围图 {image.id}"], "small", color=WHITE)
        _text(slide, ctx, X0, 200, 288, 28, [f"第 {current} 部分"], "small", color=WHITE)
        th = box_height([sections[current - 1]], "display", 288)[0]
        _text(slide, ctx, X0, 236, 288, th, [sections[current - 1]], "display")
        x, w = 432, X1 - 432
        rh = 48
        y0 = (SLIDE_H - (len(sections) * rh + (len(sections) - 1) * 8)) / 2
        for i, s in enumerate(sections, 1):
            y = y0 + (i - 1) * (rh + 8)
            cur = i == current
            if cur:
                _shape(slide, MSO_SHAPE.RECTANGLE, x, y, w, rh, fill=_tint(c["accent"], 0.12))
                _shape(slide, MSO_SHAPE.RECTANGLE, x, y, 8, rh, fill=c["accent"])
            _badge(slide, ctx, x + 24, y + 8, str(i), fill=c["accent"] if cur else GRAY)
            t = _text(slide, ctx, x + 24 + BADGE + 16, y, w - 88, rh,
                      [s + ("　◀ 当前" if cur else "")], "body", color=TEXT if cur else GRAY, bold=cur)
            t.text_frame.vertical_anchor = MSO_ANCHOR.MIDDLE
        self._notes(slide, notes)
        self.recs.append(_SlideRec(page, comp, title, notes=notes))

    # ---------- 4–12. 内容页 ----------
    @_page_method
    def slide(self, title: str, blocks: Sequence[Block], source: str = "",
              source_note: str = "", notes: str = "",
              layout: Literal["自动", "左右", "上下"] = "自动",
              decor: Optional[ImageRef] = None) -> None:
        """内容页 = 一句结论标题 + 1–2 个内容组件。

        title: 完整的一句结论（≤32字、≤2行），用 Evidence 时它就是标题的"断言"。
        blocks: 1–2 个组件：Evidence / Definition / Bullets / Steps / Compare / Example / Question / Alert / Table。
        source: 本页内容的来源（页码 / 章节号 / 文档名），可选。
        source_note: 来源标注的补充说明（如 "含补充资料"），页脚显示为【…】，并计入质检报告。
        notes: 讲者备注（强烈建议填写完整讲解）。
        layout: 两个组件时的排列，默认自动（宽组件和警示框自动上下排）。
        decor: 可选氛围图 deck.mood(...)，只允许用于"只有一个互动问题"的页，系统放在右侧窄栏。
        """
        page = self._page_no()
        ctx = _Ctx(self, page)
        blocks = list(blocks)
        if not 1 <= len(blocks) <= 2:
            ctx.err("页面", f"内容组件{len(blocks)}个，每页要求1–2个", "拆成多页，每页只讲一个结论")
        for b in blocks:
            if not isinstance(b, Block):
                ctx.err("页面", f"不认识的组件：{b!r}", "只能使用本库提供的组件类")
        names = [b.name for b in blocks]
        for uniq in ("概念定义", "警示框", "互动问题"):
            if names.count(uniq) > 1:
                ctx.err(uniq, f"一页出现{names.count(uniq)}个{uniq}", f"每页最多1个{uniq}，其余拆页")
        if layout not in ("自动", "左右", "上下"):
            ctx.err("页面", f"layout=「{layout}」不合法", "只能是：自动 / 左右 / 上下")
        self._check_title(ctx, title)
        self._check_source(ctx, "来源标注", source, source_note)
        # ---- 图片数量与氛围图规则 ----
        imgs = [b for b in blocks if isinstance(b, Evidence)]
        if len(imgs) == 2 and layout == "上下":
            ctx.err("图片", "两张图上下排列", "两张图只能左右对比排列，去掉 layout=\"上下\"")
        decor_w = 3 * COL_W + 2 * GUTTER
        if decor is not None:
            if not isinstance(decor, ImageRef) or decor.kind != KIND_MOOD:
                ctx.err("图片", "decor 只能是氛围图", "改为 decor=deck.mood(\"画面描述\")，本地图片/插图请用 Evidence")
            if not (len(blocks) == 1 and isinstance(blocks[0], Question)):
                ctx.err("图片", "内容页加了氛围图 decor", "氛围图只能放在封面、章节页，或只有一个互动问题的页面；讲内容的页面不要放装饰图")
            if self.n_decor >= MAX_DECOR:
                ctx.err("图片", f"互动页氛围图已用{self.n_decor}次，上限{MAX_DECOR}", "去掉这页的 decor，装饰图太多会分散注意力")
            if imgs:
                ctx.err("图片", "同一页既有证据图又有氛围图", "每页最多1张图（左右对比页2张），去掉 decor")
        main_w = CONTENT_W - decor_w - GAP if decor is not None else CONTENT_W

        # ---- 版式计算 ----
        places = []
        if len(blocks) == 1:
            b = blocks[0]
            self._validate_blocks(ctx, [(b, main_w)])
            h = BODY_H if b.flex else b._fit(ctx, main_w, BODY_H)
            places.append((b, X0, BODY_Y0, main_w, h))
        else:
            mode = layout
            if mode == "自动":
                mode = "上下" if any(b.wide or isinstance(b, Alert) for b in blocks) else "左右"
            if mode == "上下":
                if isinstance(blocks[0], Alert):
                    blocks = blocks[::-1]  # 警示框放下方
                self._validate_blocks(ctx, [(b, CONTENT_W) for b in blocks])
                hs = [None if b.flex else b.measure(CONTENT_W, ctx) for b in blocks]
                fixed = sum(h for h in hs if h is not None)
                flex_min = sum(b.measure(CONTENT_W, ctx) for b, h in zip(blocks, hs) if h is None)
                if fixed + flex_min + GAP > BODY_H + 0.5:
                    ctx.err("页面", f"两个组件上下排列需要约{fixed + flex_min + GAP:.0f}pt，可用{BODY_H}pt",
                            "拆成两页，或删减文字；不要缩小字号")
                hs = [h if h is not None else BODY_H - GAP - fixed for h in hs]
                y = BODY_Y0
                for b, h in zip(blocks, hs):
                    places.append((b, X0, y, CONTENT_W, h))
                    y += h + GAP
            else:
                w = 6 * COL_W + 5 * GUTTER
                self._validate_blocks(ctx, [(b, w) for b in blocks])
                for i, b in enumerate(blocks):
                    h = BODY_H if b.flex else b._fit(ctx, w, BODY_H)
                    places.append((b, X0 + i * (w + GUTTER), BODY_Y0, w, h))

        slide, ctx = self._new()
        self._frame(slide, ctx, title, source, source_note)
        for b, x, y, w, h in places:
            b.render(slide, ctx, x, y, w, h)
        if decor is not None:
            self.n_decor += 1
            _place_image(slide, ctx, decor, X1 - decor_w, BODY_Y0, decor_w, BODY_H, "crop", border=False)
        quiz = next((b for b in blocks if isinstance(b, Question)), None)
        ex = next((b for b in blocks if isinstance(b, Example)), None)
        full_notes = notes
        if ex and ex.blank_from:
            full_notes += "\n【完整步骤】" + "；".join(ex.steps)
        if quiz:
            full_notes += f"\n【答案】{quiz.answer}\n【解析】{quiz.explanation}"
        self._notes(slide, full_notes.strip())
        kind = "+".join(names)
        self.recs.append(_SlideRec(page, kind, title, source, source_note, notes, blocks))
        if quiz:
            self._answer_slide(quiz, source, source_note)

    def _answer_slide(self, q: Question, source, source_note):
        self._quiz_no += 1
        title = f"问题{self._quiz_no}　参考答案"
        slide, ctx = self._new()
        self._frame(slide, ctx, title, source, source_note)
        w = CONTENT_W
        qh = box_height([q.question], "small", w)[0]
        _text(slide, ctx, X0, BODY_Y0, w, qh, [q.question], "small")
        y = BODY_Y0 + qh + 16
        ah = box_height([f"答案：{q.answer}"], "card", w)[0]
        a = _text(slide, ctx, X0, y, w, ah, [f"答案：{q.answer}"], "card",
                  fill=_tint(ctx.c["accent"], 0.12), line=ctx.c["accent"])
        _set_run(a.text_frame.paragraphs[0].runs[0], _size(ctx, "body"), True, ctx.tokens["text"], ctx.font)
        y += ah + 24
        eh = box_height([q.explanation], "body", w)[0]
        _text(slide, ctx, X0, y, w, _line_h(SIZE_SMALL), ["解析"], "small", bold=True, color=ctx.c["primary"])
        _text(slide, ctx, X0, y + _line_h(SIZE_SMALL) + 8, w, eh, [q.explanation], "body")
        self.recs.append(_SlideRec(ctx.page, "问题答案", title, source, source_note, auto=True,
                                   extra_texts=[q.answer, q.explanation]))

    # ---------- 13. 小结 ----------
    @_page_method
    def summary(self, points: Sequence[str], source: str = "", prompt: str = "",
                title: str = "小结", notes: str = "") -> None:
        """小结。points：1–6 条（每条 ≤25字）；prompt：可选的"一句话总结"提问（≤30字）。"""
        page = self._page_no()
        ctx = _Ctx(self, page)
        comp = "小结"
        if not 1 <= len(points) <= 6:
            ctx.err(comp, f"{len(points)}条，要求1–6条", "超过6条请精简或拆页")
        for p_ in points:
            _check_text(ctx, comp, "小结条目", p_, 25)
        _check_text(ctx, comp, "提问", prompt, 30, allow_empty=True)
        self._check_source(ctx, comp, source)
        self._check_title(ctx, title, comp)
        ph = box_height([prompt], "card", CONTENT_W)[0] + GAP if prompt else 0
        if self._rows_h(points, CONTENT_W) + ph > BODY_H:
            ctx.err(comp, "小结内容放不下", "缩短条目或去掉提问")
        slide, ctx = self._new()
        self._frame(slide, ctx, title, source, "")
        y = self._rows(slide, ctx, list(points), BODY_Y0, CONTENT_W)
        if prompt:
            hh = ph - GAP
            _text(slide, ctx, X0, y + 8, CONTENT_W, hh, [f"想一想：{prompt}"], "card",
                      fill=_tint(ctx.c["accent"], 0.12), line=ctx.c["accent"])
        self._notes(slide, notes)
        self.recs.append(_SlideRec(page, comp, title, source, notes=notes, extra_texts=list(points) + [prompt]))

    # ---------- 质检 ----------
    def check(self) -> dict:
        """整份演示文稿质检。返回 {"errors": [...], "warnings": [...], "source_notes": [...]}。"""
        E, W, N = [], [], []
        titles = {}
        for r in self.recs:
            if not r.title:          # 整页图页没有标题，不参与"标题唯一"判定
                continue
            if r.title in titles:
                E.append(f"第{r.page}页 | 页面标题 | 与第{titles[r.title]}页重复 | 改写成本页独有的结论")
            titles[r.title] = r.page
        content = [r for r in self.recs if r.kind not in ("封面", "章节过渡")]
        if not content:
            E.append("全局 | 内容页 | 只有封面，没有内容页 | 至少加一页内容页（slide / points）")
        for r in content:
            if not r.notes and not r.auto:
                W.append(f"第{r.page}页 | 讲者备注 | 未填写 | 在 notes 中写完整讲解")
        bullets = sum(1 for r in content if any(isinstance(b, Bullets) for b in r.blocks))
        if content and bullets / len(content) > 0.3:
            W.append(f"全局 | 要点列表 | 要点列表页占{bullets}/{len(content)}，超过30% | 能画图/流程的改用 Evidence/Steps/Compare")
        for r in self.recs:
            if r.source_note:
                N.append(f"第{r.page}页：【{r.source_note}】（{r.title}）")
        for e in self.errors:            # 页级守卫收集到的排版/内容错误
            if e not in E:
                E.append(e)
        E += self.img_errors
        W += self.img_warnings
        for ref in self.images.values():
            if ref.id not in self.image_pages:
                W.append(f"全局 | 图片 {ref.id}（{ref.kind}） | 创建了但没有放到任何页面 | 删除这次创建，或把它放进 Evidence/cover/section")
        return {"errors": E, "warnings": W, "source_notes": N}

    def report(self) -> str:
        res = self.check()
        lines = [f"===== 质检报告：{self.title}（共{len(self.prs.slides)}页）=====",
                 "组件层/布局层：逐页校验，错误一次性收集（本次运行会把所有页的问题都列出来，不用修一个跑一次）",
                 f"整体结论：{'通过' if not res['errors'] else '未通过，需修复'}", ""]
        if self.failed_pages:
            lines.append(f"校验未通过、已跳过渲染的页：{sorted(set(self.failed_pages))}")
            lines.append("")
        for key, name in (("errors", "必须修复"), ("warnings", "建议修复"),
                          ("source_notes", "来源标注清单")):
            lines.append(f"【{name}】{len(res[key])}项")
            lines += [f"  - {x}" for x in res[key]] or ["  （无）"]
        lines.append("")
        reqs = self.requests()
        todo = [r for r in reqs if r["status"] == "待生成"]
        n_local = sum(1 for r in self.images.values() if r.kind == KIND_LOCAL)
        lines.append(f"【图片】本地图片{n_local}张；"
                     f"AI 生图请求{len(reqs)}个，其中待生成{len(todo)}个（见 image_requests.json）")
        lines += [f"  - {r['id']}（{r['kind']} {r['ratio']}，第{','.join(map(str, r['pages']))}页）→ {r['filename']}" for r in todo]
        lines.append("")
        lines.append("内容层仍需人工核对：每页文字与来源是否一致、有没有事实或数值错误、标题串读是否成逻辑。")
        lines.append("图片视觉层仍需看图核对：图中有无乱码文字、内容是否与事实矛盾、图片是否清晰完整。")
        return "\n".join(lines)

    def _cleanup_processed(self):
        """删除 images/_processed 中本次构建没有用到的旧文件，避免越积越多。"""
        d = os.path.join(self.image_dir, "_processed")
        if not os.path.isdir(d):
            return
        for f in os.listdir(d):
            p = os.path.abspath(os.path.join(d, f))
            if f.endswith(".png") and p not in self._processed:
                try:
                    os.remove(p)
                except OSError:
                    pass

    # ---------- 整页图页型：把设计好的整页画面装进 pptx ----------
    def _as_ref(self, image) -> ImageRef:
        """整页图页型的入参：deck.image(...) 的返回值，或本地图片路径字符串。"""
        if isinstance(image, ImageRef):
            return image
        if isinstance(image, str) and image.strip():
            return self.image(image)
        self._img_err("整页图的 image 参数不对",
                      "传 deck.image(\"assets/xxx.png\") 的返回值，或直接传本地图片路径字符串")

    @_page_method
    def image_page(self, image, caption: str = "", page_no: bool = True, fit: str = "contain",
                   notes: str = "") -> None:
        """整页图片页：一张整页画面铺满画布——不画标题、不画顶部色条与页脚线。

        image：deck.image(...) 或本地图片路径；fit="contain" 等比铺满（四周留白用主题底色填）
        / "cover" 铺满整页（超出画布的部分裁掉）；caption ≤40字，压在底部；
        page_no=True 时右下角保留页码。用于「设计已定，把整页图装进 pptx」。
        """
        page = self._page_no()
        ctx = _Ctx(self, page)
        if fit not in ("contain", "cover"):
            ctx.err("整页图", f"fit=「{fit}」不合法", "只能是 contain（等比铺满，留白）或 cover（铺满，裁边）")
        if caption:
            _check_text(ctx, "整页图", "图注", caption, 40)
        ref = self._as_ref(image)
        slide, ctx = self._new()
        _place_image(slide, ctx, ref, 0, 0, SLIDE_W, SLIDE_H,
                     "fit" if fit == "contain" else "crop",
                     rounded=False, border=False, pad=self.tokens["bg"])
        if caption:
            ch = _line_h(_size(ctx, "small")) + 14
            _shape(slide, MSO_SHAPE.RECTANGLE, 0, SLIDE_H - ch, SLIDE_W, ch, fill=self.tokens["bg"])
            cap_w = CONTENT_W - (80 if page_no else 0)      # 给右下角页码让位，避免文字压字
            cap = _text(slide, ctx, X0, SLIDE_H - ch, cap_w, ch, [caption], "small")
            cap.text_frame.vertical_anchor = MSO_ANCHOR.MIDDLE
        if page_no:
            n = _text(slide, ctx, X1 - 64, SLIDE_H - 30, 64, 24, [str(ctx.page)], "foot")
            n.text_frame.paragraphs[0].alignment = PP_ALIGN.RIGHT
        self._notes(slide, notes)
        self.recs.append(_SlideRec(page, "整页图", "", notes=notes, extra_texts=[caption]))

    @_page_method
    def hero(self, image, title: str, subtitle: str = "", position: str = "left",
             page_no: bool = False, notes: str = "") -> None:
        """主视觉页：整页图打底 + 一块主色面板压着标题（标题仍是这一页的结论）。

        position="left" 左侧竖条 / "bottom" 底部横条；image：deck.image(...) 或本地图片路径；
        title ≤32字（同一份 deck 内唯一）；subtitle ≤30字。
        """
        page = self._page_no()
        ctx = _Ctx(self, page)
        if position not in ("left", "bottom"):
            ctx.err("主视觉页", f"position=「{position}」不合法", "只能是 left 或 bottom")
        self._check_title(ctx, title)
        _check_text(ctx, "主视觉页", "副标题", subtitle, 30, allow_empty=True)
        ref = self._as_ref(image)
        slide, ctx = self._new()
        _place_image(slide, ctx, ref, 0, 0, SLIDE_W, SLIDE_H, "crop",
                     rounded=False, border=False)
        c = ctx.c
        if position == "left":
            pw = 400
            _shape(slide, MSO_SHAPE.RECTANGLE, 0, 0, pw, SLIDE_H, fill=c["primary"])
            _text(slide, ctx, X0, 150, pw - X0 - 40, 170, [title], "display")
            if subtitle:
                _text(slide, ctx, X0, 330, pw - X0 - 40, 80, [subtitle], "small", color=WHITE)
        else:
            ph = 176
            _shape(slide, MSO_SHAPE.RECTANGLE, 0, SLIDE_H - ph, SLIDE_W, ph, fill=c["primary"])
            t = _text(slide, ctx, X0, SLIDE_H - ph + 32, CONTENT_W, 72, [title], "display")
            t.text_frame.paragraphs[0].alignment = PP_ALIGN.CENTER
            if subtitle:
                s2 = _text(slide, ctx, X0, SLIDE_H - ph + 108, CONTENT_W, 40, [subtitle], "small", color=WHITE)
                s2.text_frame.paragraphs[0].alignment = PP_ALIGN.CENTER
        if page_no:
            n = _text(slide, ctx, X1 - 64, SLIDE_H - 30, 64, 24, [str(ctx.page)], "foot", color=WHITE)
            n.text_frame.paragraphs[0].alignment = PP_ALIGN.RIGHT
        self._notes(slide, notes)
        self.recs.append(_SlideRec(page, "主视觉页", title, notes=notes, extra_texts=[subtitle]))

    def _write_qa(self, path, rep):
        with open(os.path.splitext(path)[0] + "_QA.txt", "w", encoding="utf-8") as f:
            f.write(rep)

    def _write_requests(self, path):
        req_path = os.path.join(os.path.dirname(os.path.abspath(path)), "image_requests.json")
        with open(req_path, "w", encoding="utf-8") as f:
            json.dump({"说明": "对每条 status=待生成 的请求：用你的生图工具按 prompt（和 negative）生成图片，按 size 的比例保存为 PNG 到 abs_filename（即 filename），然后重新运行构建脚本。",
                       "requests": self.requests()}, f, ensure_ascii=False, indent=2)

    def _run_qa(self, path):
        """调用同目录的 qa.py 做几何/存在性核对。返回 (报告段落, 必须修复数)。"""
        try:
            from qa import check_presentation     # 同目录脚本，按需导入
        except Exception as e:                    # 缺 qa.py 不应让生成流程失败
            return f"【几何核对】未执行（找不到 qa.py：{type(e).__name__}）", 0
        try:
            res = check_presentation(path)
        except Exception as e:
            return f"【几何核对】未执行（qa.py 运行失败：{type(e).__name__}: {e}）", 0
        fails = [f for f in res["findings"] if f["level"] == "fail"]
        warns = [f for f in res["findings"] if f["level"] == "warn"]
        lines = [f"【几何核对】必须修复 {len(fails)} 项，建议修复 {len(warns)} 项（qa.py 口径：越界/占位残留/标题重复/图片分辨率等）"]
        lines += [f"  - {f['page'] if f['page'] else '全局'} | {f['check']} | {f['message']}" for f in fails]
        if warns:
            lines += [f"  - （建议）{f['page'] if f['page'] else '全局'} | {f['check']} | {f['message']}" for f in warns[:8]]
        if res.get("errors"):
            lines += [f"  - （qa.py 自身问题）{x}" for x in res["errors"]]
        return "\n".join(lines), len(fails)

    def save(self, path: str, draft: bool = False) -> str:
        """保存 pptx，运行整体质检，打印并返回质检报告。

        校验错误一次性收集：有任何【必须修复】就不写 pptx（避免留下缺页的坏稿），
        报告会列出全部问题，改完一次重跑即可。写出成功后再跑 qa.py 做几何核对。

        draft=True：明知还有未解决的问题也先把 pptx 写出来。只给"两轮出图"用——
        第一轮缺 AI 图时先出草稿（image_requests.json 无论成败都会写），补完图再正常 save()。
        """
        rep = self.report()
        self._write_requests(path)          # 出图清单必须落盘，否则补图那一轮没有输入
        if self.errors and not draft:
            self._write_qa(path, rep)
            print(rep)
            raise DeckError(f"共 {len(self.errors)} 个问题未解决，本次未写出 pptx；"
                            f"按上面的清单一次改完再重跑（不需要一个错跑一次）")
        self.prs.save(path)
        self._cleanup_processed()
        extra, hard = self._run_qa(path)
        rep = rep + "\n\n" + extra
        self._write_qa(path, rep)
        print(rep)
        if hard and not draft:
            raise DeckError(f"几何核对发现 {hard} 个必须修复的问题（见报告）；pptx 已写出，但不建议直接交付")
        return rep

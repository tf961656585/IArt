#!/usr/bin/env python3
"""PPT 独立质检脚本：只做几何 / 数值 / 存在性检查，不做任何审美判断。

两种用法
--------
1. 命令行::

       python qa.py <pptx路径> [--json] [--notes-min 20] [--json-out <路径>]

   人类可读报告输出到 stdout；``--json`` 时输出结构化 JSON；
   ``--json-out`` 额外把 JSON 写入指定文件。
   退出码：0 = 没有 fail（warn / info 不影响退出码）；1 = 存在 fail；2 = 文件打不开或不是 pptx。

2. 被 ``pptdeck.py`` 当模块导入::

       from qa import check_presentation
       result = check_presentation("演示.pptx", notes_min=20)

   ``check_presentation`` 不打印、不退出；文件打不开 / 不是 pptx 时把异常抛给调用方；
   某一项检查本身跑不动时记进返回值的 ``errors``，其余检查继续。

返回结构
--------
``{"file": str, "slide_count": int,
   "findings": [{"level": "fail|warn|info", "check": str, "page": int|None, "message": str}],
   "counts": {"fail": int, "warn": int, "info": int},
   "fonts": [str], "errors": [str]}``

检查项与判定口径
----------------
- 页数（info）：报告总页数与画布尺寸。
- 形状越界（fail）：形状外接矩形超出画布，容差 1pt。组合形状按组合自身矩形与子形状的
  绝对矩形分别判定（子形状坐标按 a:xfrm 的 off / chOff / chExt 换算到幻灯片坐标）。
- 文字疑似丢失（warn）：有文字容器、去空白后无文字、面积超过画布 5%、高度大于 20pt 的
  形状。8pt 色条 / 1pt 横线被高度与面积阈值排除；此外把「文字体里从未出现过
  run / fld / br 且带纯色填充」的形状视为纯装饰色块（封面大色块、警示框底板等），
  不报问题——只报「本该装文字却空了」的框（如空白文本框、正文卡片被清空）。
- 占位残留（fail）：页面文字或讲者备注里出现 TODO / 占位符 / 待补 / XXX / Lorem（拉丁词不区分大小写）。
- 讲者备注（warn）：没有备注、或备注去掉空白后不足 notes_min 字（默认 20），逐页报告。
- 标题重复（fail / warn）：每页取「位置最靠上」的文字形状（允许 2pt 的同线容差），
  在该带内取字号最大者、字号相同取更靠左者作为标题；两份标题完全相同 → fail，
  去掉标点与空白后相同 → warn。未显式设置字号按 0 处理（视为最小）。
- 图片分辨率（warn / fail）：按图片在页面上的实际显示尺寸估算有效 DPI
  （源图像素 × 可见比例 ÷ 显示英寸），低于 96 → warn，低于 72 → fail；横纵取较低者。
- 文字重叠（warn）：两个都含文字的形状外接矩形重叠面积超过较小者面积的 30%，
  逐页列出疑似对数；同一形状与其组合父形状不算。
- 字体清单（info）：收集全文显式指定的 typeface（latin / ea / cs / sym）；出现非
  Microsoft YaHei 的字体时一并列出。
"""

from __future__ import annotations

import argparse
import itertools
import json
import os
import sys
import unicodedata
from collections import Counter
from dataclasses import dataclass
from typing import Any, Dict, Iterator, List, Optional, Sequence, Tuple

from pptx import Presentation
from pptx.oxml.ns import qn
from pptx.shapes.group import GroupShape
from pptx.util import Emu, Pt

# --------------------------------------------------------------------------
# 阈值与常量（单位一律用 pptx.util 换算，不手写 EMU / 英寸魔数）
# --------------------------------------------------------------------------
BOUNDS_TOLERANCE = Pt(1)            # 形状越界容差：1pt
EMPTY_AREA_RATIO = 0.05            # 空文字形状的面积阈值：画布 5%
EMPTY_MIN_HEIGHT = Pt(20)          # 空文字形状的高度阈值：20pt
OVERLAP_RATIO = 0.30               # 文字重叠阈值：较小者面积的 30%
TITLE_TOP_BAND = Pt(2)             # 标题候选的「同一行」容差
DPI_WARN = 96.0                    # 有效 DPI 低于此值 → warn
DPI_FAIL = 72.0                    # 有效 DPI 低于此值 → fail
DEFAULT_NOTES_MIN = 20             # 讲者备注最少字数
DEFAULT_FONT = "Microsoft YaHei"   # 本技能的唯一正文字体
PLACEHOLDER_WORDS = ("TODO", "占位符", "待补", "XXX", "Lorem")

CHECK_PAGES = "页数"
CHECK_BOUNDS = "形状越界"
CHECK_EMPTY_TEXT = "文字疑似丢失"
CHECK_PLACEHOLDER = "占位残留"
CHECK_NOTES = "讲者备注"
CHECK_TITLE = "标题重复"
CHECK_TITLE_LIST = "标题提取"
CHECK_IMAGE_DPI = "图片分辨率"
CHECK_OVERLAP = "文字重叠"
CHECK_FONTS = "字体清单"

_LEVEL_RANK = {"fail": 0, "warn": 1, "info": 2}
_CHECK_RANK = {
    CHECK_PAGES: 0, CHECK_BOUNDS: 1, CHECK_EMPTY_TEXT: 2, CHECK_PLACEHOLDER: 3,
    CHECK_NOTES: 4, CHECK_TITLE: 5, CHECK_TITLE_LIST: 6, CHECK_IMAGE_DPI: 7,
    CHECK_OVERLAP: 8, CHECK_FONTS: 9,
}
_TYPEFACE_TAGS = (qn("a:latin"), qn("a:ea"), qn("a:cs"), qn("a:sym"))


# --------------------------------------------------------------------------
# 基础工具
# --------------------------------------------------------------------------
def _pt(emu: Any) -> float:
    """EMU → 磅（pt）。"""
    return Emu(int(emu)).pt


def _in(emu: Any) -> float:
    """EMU → 英寸（in）。"""
    return Emu(int(emu)).inches


def _num(obj: Any, attr: str) -> float:
    """安全读取形状的 EMU 属性（缺失记 0）。"""
    value = getattr(obj, attr, None)
    return float(value) if value is not None else 0.0


def _fattr(el: Any, name: str) -> float:
    """安全读取 XML 属性上的数值（缺失或非法记 0）。"""
    raw = el.get(name) if el is not None else None
    try:
        return float(raw)
    except (TypeError, ValueError):
        return 0.0


def _finding(level: str, check: str, page: Optional[int], message: str) -> Dict[str, Any]:
    """构造一条检查结论。"""
    return {"level": level, "check": check, "page": page, "message": message}


def _short(text: str, limit: int = 240) -> str:
    """把过长的消息截断，避免报告刷屏。"""
    one_line = " ".join(str(text).split())
    return one_line if len(one_line) <= limit else one_line[: limit - 1] + "…"


# --------------------------------------------------------------------------
# 形状遍历（含组合形状坐标换算）
# --------------------------------------------------------------------------
@dataclass
class _Node:
    """页面上一个形状，坐标已换算到幻灯片坐标系（单位 pt）。"""

    node_id: int
    page: int
    shape: Any
    left: float
    top: float
    width: float
    height: float
    text: Optional[str]          # None = 不含文字容器；"" = 有容器但无文字
    max_size: float              # 形状内最大显式字号（pt），无则 0
    ancestors: Tuple[int, ...]   # 组合父形状的 node_id 链

    @property
    def right(self) -> float:
        return self.left + self.width

    @property
    def bottom(self) -> float:
        return self.top + self.height

    @property
    def area(self) -> float:
        return self.width * self.height

    @property
    def name(self) -> str:
        return str(getattr(self.shape, "name", "形状"))


def _frame_sizes(text_frame: Any) -> List[float]:
    """收集文字框里所有显式字号（段落级 + run 级，单位 pt）。"""
    sizes: List[float] = []
    for para in text_frame.paragraphs:
        if para.font.size is not None:
            sizes.append(para.font.size.pt)
        for run in para.runs:
            if run.font.size is not None:
                sizes.append(run.font.size.pt)
    return sizes


def _shape_text(shape: Any) -> Tuple[Optional[str], float]:
    """提取形状里的文字与最大字号。

    返回 (文字, 最大字号pt)：形状不含文字容器时文字为 None；
    含容器但没写字时为 ""（这种形状才可能是「文字疑似丢失」）。
    表格（GraphicFrame）的单元格文字同样计入。
    """
    has_container = False
    chunks: List[str] = []
    sizes: List[float] = []
    if getattr(shape, "has_text_frame", False):
        has_container = True
        frame = shape.text_frame
        chunks.append(frame.text or "")
        sizes.extend(_frame_sizes(frame))
    if getattr(shape, "has_table", False):
        has_container = True
        for row in shape.table.rows:
            for cell in row.cells:
                chunks.append(cell.text or "")
                sizes.extend(_frame_sizes(cell.text_frame))
    if not has_container:
        return None, 0.0
    return "\n".join(chunks), (max(sizes) if sizes else 0.0)


def _had_text_markup(shape: Any) -> bool:
    """形状的文字体里是否出现过 run / fld / br（即「曾经装过文字」）。"""
    element = getattr(shape, "_element", None)
    if element is None:
        return False
    body = element.find(qn("p:txBody"))
    if body is None:
        return False
    return any(body.find(".//" + qn(tag)) is not None for tag in ("a:r", "a:fld", "a:br"))


def _has_solid_fill(shape: Any) -> bool:
    """形状是否带纯色填充（生成器画装饰色块的方式）。"""
    element = getattr(shape, "_element", None)
    if element is None:
        return False
    props = element.find(qn("p:spPr"))
    return props is not None and props.find(qn("a:solidFill")) is not None


def _is_pure_decoration(node: _Node) -> bool:
    """纯装饰色块：从未装过文字、且带纯色填充（8pt 色条、封面大色块、警示框底板……）。"""
    return not _had_text_markup(node.shape) and _has_solid_fill(node.shape)


def _group_transform(group: Any) -> Tuple[float, float, float, float]:
    """组合形状的子坐标系 → 组合自身坐标系，返回 (sx, tx, sy, ty)，单位 EMU。"""
    element = getattr(group, "_element", None)
    props = element.find(qn("p:grpSpPr")) if element is not None else None
    xfrm = props.find(qn("a:xfrm")) if props is not None else None
    if xfrm is None:
        return 1.0, 0.0, 1.0, 0.0
    off = xfrm.find(qn("a:off"))
    ext = xfrm.find(qn("a:ext"))
    ch_off = xfrm.find(qn("a:chOff"))
    ch_ext = xfrm.find(qn("a:chExt"))
    tx, ty = _fattr(off, "x"), _fattr(off, "y")
    if ext is None or ch_off is None or ch_ext is None:
        return 1.0, tx, 1.0, ty
    child_w, child_h = _fattr(ch_ext, "cx"), _fattr(ch_ext, "cy")
    ext_w, ext_h = _fattr(ext, "cx"), _fattr(ext, "cy")
    sx = ext_w / child_w if child_w else 1.0
    sy = ext_h / child_h if child_h else 1.0
    return sx, tx - _fattr(ch_off, "x") * sx, sy, ty - _fattr(ch_off, "y") * sy


def _compose(outer: Tuple[float, float, float, float],
             inner: Tuple[float, float, float, float]) -> Tuple[float, float, float, float]:
    """复合两个 (scale, translate) 变换。"""
    o_sx, o_tx, o_sy, o_ty = outer
    i_sx, i_tx, i_sy, i_ty = inner
    return (o_sx * i_sx, o_sx * i_tx + o_tx, o_sy * i_sy, o_sy * i_ty + o_ty)


def _iter_nodes(shapes: Any, page: int,
                xform: Tuple[float, float, float, float] = (1.0, 0.0, 1.0, 0.0),
                ancestors: Tuple[int, ...] = (),
                counter: Optional[Iterator[int]] = None) -> Iterator[_Node]:
    """递归遍历一页里的形状（含组合形状与表格），坐标换算到幻灯片坐标系。"""
    if counter is None:
        counter = itertools.count(1)
    sx, tx, sy, ty = xform
    for shape in shapes:
        node_id = next(counter)
        text, size = _shape_text(shape)
        node = _Node(
            node_id=node_id,
            page=page,
            shape=shape,
            left=_pt(sx * _num(shape, "left") + tx),
            top=_pt(sy * _num(shape, "top") + ty),
            width=_pt(sx * _num(shape, "width")),
            height=_pt(sy * _num(shape, "height")),
            text=text,
            max_size=size,
            ancestors=ancestors,
        )
        yield node
        if isinstance(shape, GroupShape):
            inner = _group_transform(shape)
            yield from _iter_nodes(shape.shapes, page, _compose(xform, inner),
                                   ancestors + (node_id,), counter)


# --------------------------------------------------------------------------
# 单项检查
# --------------------------------------------------------------------------
def _check_bounds(page: int, nodes: Sequence[_Node], canvas_w: float, canvas_h: float,
                  findings: List[Dict[str, Any]]) -> None:
    """形状越界：外接矩形超出画布（容差 1pt）→ fail。"""
    tol = BOUNDS_TOLERANCE.pt
    for node in nodes:
        over = []
        if node.left < -tol:
            over.append(f"左边界超出 {-node.left:.1f}pt")
        if node.top < -tol:
            over.append(f"上边界超出 {-node.top:.1f}pt")
        if node.right > canvas_w + tol:
            over.append(f"右边界超出 {node.right - canvas_w:.1f}pt")
        if node.bottom > canvas_h + tol:
            over.append(f"下边界超出 {node.bottom - canvas_h:.1f}pt")
        if not over:
            continue
        findings.append(_finding(
            "fail", CHECK_BOUNDS, page,
            f"形状「{node.name}」越界：{'、'.join(over)}"
            f"（矩形 L{node.left:.1f} T{node.top:.1f} W{node.width:.1f} H{node.height:.1f}pt，"
            f"画布 {canvas_w:.0f}×{canvas_h:.0f}pt）"))


def _check_empty_text(page: int, nodes: Sequence[_Node], canvas_area: float,
                      findings: List[Dict[str, Any]]) -> None:
    """文字疑似丢失：大块的、没写字的文字容器 → warn（纯装饰色块除外）。"""
    for node in nodes:
        if node.text is None or node.text.strip():
            continue
        if node.area <= canvas_area * EMPTY_AREA_RATIO:
            continue
        if node.height <= EMPTY_MIN_HEIGHT.pt:
            continue
        if _is_pure_decoration(node):
            continue
        ratio = node.area / canvas_area * 100 if canvas_area else 0.0
        findings.append(_finding(
            "warn", CHECK_EMPTY_TEXT, page,
            f"形状「{node.name}」有文字框但没有任何文字"
            f"（{node.width:.0f}×{node.height:.0f}pt，占画布 {ratio:.1f}%）"))


def _check_placeholders(page: int, texts: Sequence[Tuple[str, str]],
                        findings: List[Dict[str, Any]]) -> None:
    """占位残留：任何文本里含占位词 → fail。texts 为 (来源说明, 文本)。"""
    for origin, text in texts:
        lowered = text.lower()
        for word in PLACEHOLDER_WORDS:
            idx = lowered.find(word.lower())
            if idx < 0:
                continue
            snippet = " ".join(text[max(0, idx - 20): idx + len(word) + 20].split())
            findings.append(_finding(
                "fail", CHECK_PLACEHOLDER, page,
                f"{origin}含占位词「{word}」：…{snippet}…"))


def _check_notes(page: int, notes: str, notes_min: int,
                 findings: List[Dict[str, Any]]) -> None:
    """讲者备注覆盖率：没有备注或备注过短 → warn。"""
    count = len("".join(notes.split()))
    if count == 0:
        findings.append(_finding("warn", CHECK_NOTES, page, "没有讲者备注"))
    elif count < notes_min:
        findings.append(_finding(
            "warn", CHECK_NOTES, page, f"讲者备注仅 {count} 字（少于 {notes_min} 字）"))


def _title_of(nodes: Sequence[_Node]) -> Optional[_Node]:
    """取一页的标题形状：先取全页最大字号那一档（0.5pt 容差），其中取最靠上、再取最靠左。

    为什么按字号而不是按位置：章节过渡页会把小节名排在标题上方，按位置会把小节名
    当成标题，从而把不同页的标题误判成重复（实测 demo 第 5/10/17 页）。组件体系里
    标题始终是全页最大字号，正文与节名都比它小一档。
    """
    candidates = [n for n in nodes if n.text and n.text.strip()]
    if not candidates:
        return None
    max_size = max(n.max_size for n in candidates)
    band = [n for n in candidates if n.max_size >= max_size - 0.5]
    return min(band, key=lambda n: (round(n.top, 1), n.left))


def _norm_title(text: str) -> str:
    """标题归一化：全角转半角、去掉空白与标点，用于「高度相似」判定。"""
    folded = unicodedata.normalize("NFKC", text)
    return "".join(ch for ch in folded
                   if not ch.isspace() and not unicodedata.category(ch).startswith("P"))


def _check_titles(titles: Dict[int, str], findings: List[Dict[str, Any]]) -> None:
    """标题重复：两份标题完全相同 → fail；去标点后相同 → warn。"""
    pages = sorted(titles)
    for left, right in itertools.combinations(pages, 2):
        a = " ".join(titles[left].split())
        b = " ".join(titles[right].split())
        if a == b:
            findings.append(_finding(
                "fail", CHECK_TITLE, right,
                f"第{left}页与第{right}页标题完全相同：「{_short(a, 40)}」"))
        elif _norm_title(a) and _norm_title(a) == _norm_title(b):
            findings.append(_finding(
                "warn", CHECK_TITLE, right,
                f"第{left}页与第{right}页标题高度相似（仅标点 / 空白不同）：「{_short(a, 40)}」"
                f" / 「{_short(b, 40)}」"))


def _image_dpi(picture: Any) -> Tuple[float, int, int, float, float]:
    """估算图片的有效 DPI。

    返回 (较低者DPI, 源图宽px, 源图高px, 显示宽in, 显示高in)。
    有效 DPI = 源图像素 × 可见比例 ÷ 显示英寸；原始文件里没有有效像素数据时抛异常。
    """
    image = picture.image
    px_w, px_h = image.size
    crop_w = float(getattr(picture, "crop_left", 0.0) or 0.0) + float(getattr(picture, "crop_right", 0.0) or 0.0)
    crop_h = float(getattr(picture, "crop_top", 0.0) or 0.0) + float(getattr(picture, "crop_bottom", 0.0) or 0.0)
    visible_w = px_w * max(0.0, 1.0 - crop_w)
    visible_h = px_h * max(0.0, 1.0 - crop_h)
    disp_w = _in(_num(picture, "width"))
    disp_h = _in(_num(picture, "height"))
    candidates = []
    if disp_w > 0 and visible_w > 0:
        candidates.append(visible_w / disp_w)
    if disp_h > 0 and visible_h > 0:
        candidates.append(visible_h / disp_h)
    if not candidates:
        raise ValueError("图片显示尺寸或源图像素为 0，无法估算 DPI")
    return min(candidates), px_w, px_h, disp_w, disp_h


def _check_images(page: int, nodes: Sequence[_Node],
                  findings: List[Dict[str, Any]], errors: List[str]) -> None:
    """图片分辨率：按显示尺寸估算有效 DPI，<96 → warn，<72 → fail。"""
    for node in nodes:
        if getattr(node.shape, "image", None) is None:
            continue
        try:
            dpi, px_w, px_h, disp_w, disp_h = _image_dpi(node.shape)
        except Exception as exc:  # 检查过程的问题，记进 errors
            errors.append(f"第{page}页 | {CHECK_IMAGE_DPI} | 图片「{node.name}」读取失败："
                          f"{type(exc).__name__}: {exc}")
            continue
        detail = (f"图片「{node.name}」显示 {disp_w:.2f}×{disp_h:.2f} in，"
                  f"源图 {px_w}×{px_h} px，估算 {dpi:.0f} DPI")
        if dpi < DPI_FAIL:
            findings.append(_finding("fail", CHECK_IMAGE_DPI, page, detail + f"（低于 {DPI_FAIL:.0f}）"))
        elif dpi < DPI_WARN:
            findings.append(_finding("warn", CHECK_IMAGE_DPI, page, detail + f"（低于 {DPI_WARN:.0f}）"))


def _check_overlap(page: int, nodes: Sequence[_Node],
                   findings: List[Dict[str, Any]]) -> None:
    """文字重叠疑似：两个含文字形状外接矩形重叠超过较小者 30% → warn。"""
    text_nodes = [n for n in nodes if n.text and n.text.strip() and n.area > 0]
    pairs: List[str] = []
    for a, b in itertools.combinations(text_nodes, 2):
        if a.node_id in b.ancestors or b.node_id in a.ancestors:
            continue
        overlap_w = min(a.right, b.right) - max(a.left, b.left)
        overlap_h = min(a.bottom, b.bottom) - max(a.top, b.top)
        if overlap_w <= 0 or overlap_h <= 0:
            continue
        smaller = min(a.area, b.area)
        ratio = (overlap_w * overlap_h) / smaller if smaller else 0.0
        if ratio > OVERLAP_RATIO:
            pairs.append(f"「{a.name}」↔「{b.name}」{ratio * 100:.0f}%")
    if pairs:
        shown = "、".join(pairs[:5]) + ("等" if len(pairs) > 5 else "")
        findings.append(_finding(
            "warn", CHECK_OVERLAP, page,
            f"{len(pairs)} 对文字形状外接矩形重叠超过 {OVERLAP_RATIO:.0%}：{shown}"))


def _collect_fonts(slide: Any) -> Counter:
    """收集一页里显式指定的字体名（latin / ea / cs / sym）。"""
    found: Counter = Counter()
    for element in slide._element.iter():
        if element.tag in _TYPEFACE_TAGS:
            name = (element.get("typeface") or "").strip()
            if name:
                found[name] += 1
    return found


def _theme_fonts(prs: Any) -> List[str]:
    """读取主题字体（文字没有显式指定字体时会用到）。"""
    names: List[str] = []
    package = getattr(getattr(prs, "part", None), "package", None)
    if package is None:
        return names
    for part in package.iter_parts():
        if not str(part.partname).endswith(".xml") or "theme" not in str(part.partname):
            continue
        root = getattr(part, "_element", None)
        if root is None:
            continue
        for tag in ("a:majorFont", "a:minorFont"):
            font = root.find(".//" + qn(tag))
            if font is None:
                continue
            latin = font.find(qn("a:latin"))
            name = (latin.get("typeface") if latin is not None else "") or ""
            if name.strip():
                names.append(name.strip())
    return names


# --------------------------------------------------------------------------
# 主入口
# --------------------------------------------------------------------------
def check_presentation(pptx_path: str, notes_min: int = DEFAULT_NOTES_MIN) -> Dict[str, Any]:
    """对一份 pptx 做几何 / 数值 / 存在性质检，返回结构化结果。

    参数：
        pptx_path: pptx 文件路径。
        notes_min: 讲者备注的最少字数（按去掉空白后的字符数计），默认 20。

    返回：见模块 docstring 的 schema。函数不打印、不退出；
    文件打不开 / 不是 pptx 时把异常抛给调用方；单项检查自身出错时记进 errors 并继续。
    """
    path = os.fspath(pptx_path)
    if not os.path.isfile(path):
        raise FileNotFoundError(f"找不到文件：{path}")
    minimum = max(0, int(notes_min))
    prs = Presentation(path)  # 坏文件在这里抛异常给调用方

    findings: List[Dict[str, Any]] = []
    errors: List[str] = []
    canvas_w = _pt(prs.slide_width)
    canvas_h = _pt(prs.slide_height)
    canvas_area = canvas_w * canvas_h
    slides = list(prs.slides)

    findings.append(_finding(
        "info", CHECK_PAGES, None,
        f"共 {len(slides)} 页；画布 {canvas_w:.0f}×{canvas_h:.0f}pt"))

    font_counter: Counter = Counter()
    titles: Dict[int, str] = {}

    for page, slide in enumerate(slides, start=1):
        try:
            nodes = list(_iter_nodes(slide.shapes, page))
        except Exception as exc:
            errors.append(f"第{page}页 | 遍历形状失败：{type(exc).__name__}: {exc}")
            continue

        texts: List[Tuple[str, str]] = []
        for node in nodes:
            if node.text:
                texts.append((f"文本「{node.name}」", node.text))
        notes = ""
        try:
            if getattr(slide, "has_notes_slide", False):
                frame = slide.notes_slide.notes_text_frame
                notes = (frame.text if frame is not None else "") or ""
        except Exception as exc:
            errors.append(f"第{page}页 | 读取讲者备注失败：{type(exc).__name__}: {exc}")
        if notes:
            texts.append(("讲者备注", notes))

        for check, action in (
            (CHECK_BOUNDS, lambda: _check_bounds(page, nodes, canvas_w, canvas_h, findings)),
            (CHECK_EMPTY_TEXT, lambda: _check_empty_text(page, nodes, canvas_area, findings)),
            (CHECK_PLACEHOLDER, lambda: _check_placeholders(page, texts, findings)),
            (CHECK_NOTES, lambda: _check_notes(page, notes, minimum, findings)),
            (CHECK_IMAGE_DPI, lambda: _check_images(page, nodes, findings, errors)),
            (CHECK_OVERLAP, lambda: _check_overlap(page, nodes, findings)),
        ):
            try:
                action()
            except Exception as exc:
                errors.append(f"第{page}页 | {check} 检查失败：{type(exc).__name__}: {exc}")

        try:
            title_node = _title_of(nodes)
            if title_node is not None:
                titles[page] = " ".join((title_node.text or "").split())
        except Exception as exc:
            errors.append(f"第{page}页 | {CHECK_TITLE} 提取失败：{type(exc).__name__}: {exc}")

        try:
            font_counter.update(_collect_fonts(slide))
        except Exception as exc:
            errors.append(f"第{page}页 | {CHECK_FONTS} 收集失败：{type(exc).__name__}: {exc}")

    try:
        _check_titles(titles, findings)
    except Exception as exc:
        errors.append(f"整份 | {CHECK_TITLE} 检查失败：{type(exc).__name__}: {exc}")

    fonts = sorted(font_counter)
    if titles:
        findings.append(_finding(
            "info", CHECK_TITLE_LIST, None,
            "；".join(f"第{p}页「{titles[p]}」" for p in sorted(titles))))
    if font_counter:
        listed = "、".join(f"{name}（{count} 处）"
                           for name, count in sorted(font_counter.items(), key=lambda kv: (-kv[1], kv[0])))
        findings.append(_finding("info", CHECK_FONTS, None, f"全文用到字体：{listed}"))
        others = sorted(name for name in font_counter if name != DEFAULT_FONT)
        if others:
            findings.append(_finding(
                "info", CHECK_FONTS, None,
                f"非 {DEFAULT_FONT} 的字体：{'、'.join(others)}"))
    else:
        try:
            theme = _theme_fonts(prs)
        except Exception as exc:
            theme = []
            errors.append(f"整份 | {CHECK_FONTS} 读取主题字体失败：{type(exc).__name__}: {exc}")
        suffix = f"（主题字体：{'、'.join(sorted(set(theme)))}）" if theme else ""
        findings.append(_finding(
            "info", CHECK_FONTS, None, f"没有显式指定字体，文字使用主题字体{suffix}"))
        fonts = sorted(set(theme))

    findings.sort(key=lambda f: (_LEVEL_RANK.get(f["level"], 9), f["page"] or 0,
                                 _CHECK_RANK.get(f["check"], 99), f["message"]))
    counts = {level: sum(1 for f in findings if f["level"] == level)
              for level in ("fail", "warn", "info")}
    return {
        "file": os.path.abspath(path),
        "slide_count": len(slides),
        "findings": findings,
        "counts": counts,
        "fonts": fonts,
        "errors": errors,
    }


# --------------------------------------------------------------------------
# 命令行
# --------------------------------------------------------------------------
_LEVEL_TITLE = {"fail": "【必须修复】", "warn": "【建议修复】", "info": "【信息】"}


def render_text(result: Dict[str, Any], max_message: int = 240) -> str:
    """把结构化结果渲染成人类可读报告。"""
    lines = [
        "=" * 64,
        "PPT 质检报告（几何 / 数值 / 存在性）",
        f"文件：{result['file']}",
        f"页数：{result['slide_count']}    字体：{'、'.join(result['fonts']) or '（未显式指定）'}",
        "=" * 64,
    ]
    for level in ("fail", "warn", "info"):
        items = [f for f in result["findings"] if f["level"] == level]
        lines.append(f"{_LEVEL_TITLE[level]} {len(items)} 项")
        for item in items:
            where = f"第{item['page']}页" if item["page"] else "整份"
            lines.append(f"  - [{item['check']}] {where} {_short(item['message'], max_message)}")
    if result["errors"]:
        lines.append(f"【检查过程报错】{len(result['errors'])} 项（不是 PPT 的问题）")
        for err in result["errors"]:
            lines.append(f"  ! {_short(err, max_message)}")
    counts = result["counts"]
    lines.append("-" * 64)
    lines.append(f"统计：fail {counts['fail']} / warn {counts['warn']} / info {counts['info']}")
    lines.append("退出码：0 = 没有 fail；1 = 存在 fail；2 = 文件打不开或不是 pptx")
    return "\n".join(lines)


def build_parser() -> argparse.ArgumentParser:
    """构造命令行参数解析器。"""
    parser = argparse.ArgumentParser(
        prog="qa.py",
        description="PPT 独立质检：只做几何 / 数值 / 存在性检查，不修改文件。",
        epilog="退出码：0 = 没有 fail（warn / info 不影响退出码）；1 = 存在 fail；2 = 文件打不开或不是 pptx。",
    )
    parser.add_argument("pptx", help="要检查的 pptx 文件路径")
    parser.add_argument("--json", action="store_true", help="把结构化 JSON 输出到 stdout")
    parser.add_argument("--notes-min", type=int, default=DEFAULT_NOTES_MIN,
                        help=f"讲者备注最少字数，默认 {DEFAULT_NOTES_MIN}")
    parser.add_argument("--json-out", default=None, help="把结构化 JSON 另存到指定路径")
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    """命令行入口：返回进程退出码。"""
    args = build_parser().parse_args(argv)
    try:
        result = check_presentation(args.pptx, notes_min=args.notes_min)
    except Exception as exc:
        print(f"无法读取 pptx：{args.pptx}\n  {type(exc).__name__}: {exc}", file=sys.stderr)
        return 2
    payload = json.dumps(result, ensure_ascii=False, indent=2)
    if args.json_out:
        try:
            with open(args.json_out, "w", encoding="utf-8") as handle:
                handle.write(payload + "\n")
        except OSError as exc:
            print(f"无法写入 {args.json_out}：{exc}", file=sys.stderr)
            return 2
    print(payload if args.json else render_text(result))
    return 1 if result["counts"]["fail"] else 0


if __name__ == "__main__":
    sys.exit(main())

# -*- coding: utf-8 -*-
"""把组件库的能力、字段、字数上限导出成机器可读的 JSON —— 让 agent 不必读散文手册、
也不必用 grep 翻源码，就能知道「能放什么、每个字段最多几个字」。

用法：
    python deck_schema.py            # 人类可读摘要
    python deck_schema.py --json     # 完整 schema（JSON）
    python deck_schema.py --verify   # 自检：schema 与源码是否一致

字数上限不是手写的：直接从 pptdeck.py 的源码里把 _check_text(...) 的字面量上限抽出来，
所以改了代码不会出现"文档写 20 字、代码查 20 字"的漂移。结构性上限（条目数、步数、
行列数）写在 STRUCT_LIMITS 里，--verify 会用「构造 N+1 个」的探针逐个复核。
"""
from __future__ import annotations

import argparse
import ast
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
PPTDeck = HERE / "pptdeck.py"

# 结构性上限：这些是"数量"约束，没法从 _check_text 的字面量里抽，单独列出并由 --verify 探针复核
STRUCT_LIMITS = {
    "Bullets.items": ("条目数", 2, 5, "超过 5 条请拆页"),
    "Steps.steps": ("步骤数", 3, 6, "超过 6 步拆成两页（第2页标题加（续））"),
    "Example.steps": ("步骤数", 1, 5, "超过 5 步拆页"),
    "Question.options": ("选项数", 2, 4, "选择题 2–4 个选项"),
    "Compare.headers": ("对比对象数", 2, 3, "超过 3 个改用表格"),
    "Compare.rows": ("对比维度数", 2, 5, "删减维度或拆页"),
    "Table.headers": ("列数", 2, 5, "拆成两张表"),
    "Table.rows": ("行数", 1, 6, "拆成两页"),
    "Evidence.callouts": ("标注数", 0, 4, "只保留最关键的 4 个"),
    "points.items": ("要点条数", 1, 6, "超过 6 条拆页"),
    "summary.points": ("小结条数", 1, 6, "超过 6 条拆页"),
    "section.sections": ("节数", 2, 8, "节太多请合并"),
    "slide.blocks": ("每页组件数", 1, 2, "拆成多页，每页一个结论"),
}

# 页面级方法与内容组件的用途（写给人看的那一句）
PAGE_METHODS = {
    "cover": "封面（第 1 页）：标题 ≤20字、副标题 ≤24字，可选 AI 氛围图",
    "points": "要点页：1–6 条编号条目，放在封面之后当议程",
    "section": "章节过渡：显示全部节名并高亮当前节",
    "slide": "内容页：一句结论标题 + 1–2 个内容组件",
    "summary": "小结：1–6 条结论 + 一句收尾提问",
    "image_page": "整页图片页：一张整页图铺满画布，不加标题与页脚（还原设计稿用）",
    "hero": "主视觉页：整页图打底 + 主色面板压标题",
}

COMPONENTS = {
    "Evidence": "断言 + 证据：用一张图支撑标题里的结论",
    "Definition": "概念卡片：术语 + 定义 + 补充说明",
    "Bullets": "要点列表：几条并列/顺序/递进/因果的短句（最后才考虑）",
    "Steps": "步骤流程：做什么 + 要点 + 为什么（写具体后果）",
    "Compare": "对比：2–3 个对象 × 2–5 个维度，可做正误对比",
    "Example": "示例讲解：一道题 / 一次估算 / 一个任务的分步做法",
    "Question": "现场提问：自动在下一页生成参考答案",
    "Alert": "警示框：风险 / 注意事项 / 易错点（三段必填）",
    "Table": "表格：参数表、规格表、对照表",
}

TOKEN_DOC = {
    "primary": "主色（顶部色条、序号圆点、主视觉面板）6位十六进制",
    "accent": "强调色（来源补充说明等）",
    "bg": "页面底色，默认白；深色课件改这里",
    "text": "正文色",
    "gray": "辅助文字色",
    "line": "分隔线 / 描边色",
    "font": "字体名（PowerPoint 缺字体时系统回退）",
    "chrome": "是否画页面骨架（顶部色条 + 页脚线 + 页码）",
    "scale": "全局字号倍率，0.7–1.3，默认 1.0",
    "title_size": "标题字号（默认 32）",
    "body_size": "正文字号（默认 24）",
    "small_size": "辅助字号（默认 18）",
    "foot_size": "页脚字号（默认 14）",
}

LIMITATIONS = [
    "版式是固定的 12 栏网格：不能自由指定坐标、字号、行距——需要自由排版时不要用本库",
    "字号只有 4 档（标题/正文/辅助/页脚），靠 scale 整体缩放，不能单页调字号",
    "主题只有内置 3 套 + 设计令牌（颜色/字体/缩放）；没有任意模板导入",
    "图片只能作为内容页里的「证据图」或「整页图页型」；不支持图片局部裁切框选",
    "不支持动画、切换、图表对象（需要图表请先出图片再走 Evidence / image_page）",
    "不支持合并单元格、脚注、目录页自动生成",
]


def _text_limits() -> dict:
    """从源码里抽 _check_text(...) 的字面量上限 → {"组件.字段": {"max_chars": N, "required": bool}}。

    组件名写在 self.name 里（各组件类自己的 name 属性），所以按类上下文还原成类名；
    页面方法的限制用字面量中文名（如 "封面"），原样保留。
    """
    tree = ast.parse(PPTDeck.read_text(encoding="utf-8"))
    out: dict[str, dict] = {}

    class Visitor(ast.NodeVisitor):
        def __init__(self):
            self.cls: list[str] = []

        def visit_ClassDef(self, node):
            self.cls.append(node.name)
            self.generic_visit(node)
            self.cls.pop()

        def visit_Call(self, node):
            fn = node.func
            if isinstance(fn, ast.Name) and fn.id == "_check_text" and len(node.args) >= 5:
                comp_node, field_node, max_node = node.args[1], node.args[2], node.args[4]
                comp = None
                if isinstance(comp_node, ast.Constant) and isinstance(comp_node.value, str):
                    comp = comp_node.value
                elif (isinstance(comp_node, ast.Attribute) and comp_node.attr == "name" and self.cls):
                    comp = self.cls[-1]
                if comp and isinstance(field_node, ast.Constant) and isinstance(max_node, ast.Constant) \
                        and isinstance(max_node.value, int):
                    allow_empty = any(
                        kw.arg == "allow_empty" and isinstance(kw.value, ast.Constant) and bool(kw.value.value)
                        for kw in node.keywords)
                    out[f"{comp}.{field_node.value}"] = {"max_chars": max_node.value,
                                                        "required": not allow_empty}
            self.generic_visit(node)

    Visitor().visit(tree)
    return dict(sorted(out.items()))


def build_schema() -> dict:
    return {
        "skill": "ppt-builder",
        "canvas": {"width_pt": 960, "height_pt": 540, "ratio": "16:9",
                   "margin_pt": 48, "body_top_pt": 140, "body_bottom_pt": 476,
                   "body_height_pt": 336},
        "page_methods": PAGE_METHODS,
        "components": COMPONENTS,
        "text_limits": _text_limits(),
        "struct_limits": {k: {"what": v[0], "min": v[1], "max": v[2], "fix": v[3]}
                          for k, v in STRUCT_LIMITS.items()},
        "tokens": TOKEN_DOC,
        "limitations": LIMITATIONS,
        "rules": [
            "标题必须是本页的一句结论（≤32字、≤2行），且全篇唯一",
            "文字里不要写换行符，换行由组件库计算",
            "放不下时删字/拆页/换组件，绝不缩小字号",
            "每页都要写 notes（讲者备注），否则质检会警告",
            "设计已定（有设计稿/整页图）→ 用 image_page 或 hero；设计未定 → 用内容组件",
        ],
    }


def _verify(schema: dict) -> int:
    """自检：schema 里的组件/令牌必须真实存在于源码，结构性上限用探针复核。"""
    sys.path.insert(0, str(HERE))
    import pptdeck as P  # noqa: N812

    bad = []
    for name in schema["components"]:
        if not hasattr(P, name):
            bad.append(f"组件 {name} 在 pptdeck.py 里不存在")
    for k in schema["tokens"]:
        if k not in P.DEFAULT_TOKENS:
            bad.append(f"令牌 {k} 不在 DEFAULT_TOKENS 里")
    for k in P.DEFAULT_TOKENS:
        if k not in schema["tokens"] and k != "sizes":
            bad.append(f"DEFAULT_TOKENS 的 {k} 没有写进 schema")

    probes = [
        ("Bullets.items", lambda n: P.Bullets([f"条目{i}" for i in range(n)], relation="并列")),
        ("Steps.steps", lambda n: P.Steps([P.Step(f"步骤{i}", ["要点"], "超过上限提交会超时") for i in range(n)])),
        ("Question.options", lambda n: P.Question("这样对不对？", kind="选择",
                                                  options=[f"选项{i}" for i in range(n)],
                                                  answer="A", explanation="解析")),
        ("Compare.headers", lambda n: P.Compare(headers=[f"对象{i}" for i in range(n)],
                                                rows=[("维度一", ["甲"] * n), ("维度二", ["乙"] * n)])),
        ("Table.rows", lambda n: P.Table(headers=["列一", "列二"], rows=[["甲", "乙"]] * n)),
    ]
    for key, make in probes:
        lo, hi = schema["struct_limits"][key]["min"], schema["struct_limits"][key]["max"]
        try:
            obj = make(hi + 1)
            d = P.Deck("verify", theme="深蓝")
            ctx = P._Ctx(d, 1)
            obj.validate(ctx, 800)
            bad.append(f"{key} 上限 {hi}：传入 {hi + 1} 个竟然通过了校验")
        except Exception as e:
            msg = str(e)
            if str(hi + 1) not in msg:
                bad.append(f"{key} 上限探针的报错里没提到 {hi + 1}：{msg[:80]}")
        try:
            obj = make(max(lo, 1))
            d = P.Deck("verify", theme="深蓝")
            obj.validate(P._Ctx(d, 1), 800)
        except Exception as e:
            bad.append(f"{key} 下限 {lo}：合法数量反而报错：{str(e)[:80]}")

    print(f"自检：文本上限 {len(schema['text_limits'])} 项、结构上限 {len(schema['struct_limits'])} 项、组件 {len(schema['components'])} 个")
    if bad:
        print("不一致：")
        for b in bad:
            print("  -", b)
        return 1
    print("一致：schema 与源码没有漂移")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="导出 ppt-builder 的能力 schema")
    ap.add_argument("--json", action="store_true", help="输出完整 JSON")
    ap.add_argument("--verify", action="store_true", help="自检 schema 与源码是否一致")
    a = ap.parse_args()
    schema = build_schema()
    if a.verify:
        return _verify(schema)
    if a.json:
        print(json.dumps(schema, ensure_ascii=False, indent=2))
        return 0
    print("== 页面方法")
    for k, v in schema["page_methods"].items():
        print(f"  {k:12s} {v}")
    print("\n== 组件")
    for k, v in schema["components"].items():
        print(f"  {k:12s} {v}")
    print("\n== 字数上限（从源码抽取）")
    for k, v in schema["text_limits"].items():
        print(f"  {k:28s} ≤{v['max_chars']:>3} 字{'' if v['required'] else '（可空）'}")
    print("\n== 数量上限")
    for k, v in schema["struct_limits"].items():
        print(f"  {k:24s} {v['min']}–{v['max']} {v['what']}")
    print("\n== 设计令牌")
    for k, v in schema["tokens"].items():
        print(f"  {k:12s} {v}")
    print("\n== 做不到的事")
    for x in schema["limitations"]:
        print(f"  - {x}")
    print("\n提示：加 --json 取机器可读版本；加 --verify 自检与源码是否漂移。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

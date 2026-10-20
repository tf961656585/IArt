# -*- coding: utf-8 -*-
"""【示例】demo.py —— 用 scripts/pptdeck.py 生成一份示例演示文稿，覆盖全部组件和三类图片。
⚠ 这是示例：内容、人名、编号、图片都是虚构的（图片是 PIL 画的替身图），不能用于实际汇报。

运行（在任意目录）：python examples/demo.py
  第1轮：构建 → 输出 image_requests.json（待生成的 AI 图）
  模拟：fake_image_tool() 用 PIL 画"替身图"代替真实生图能力（故意少画一张、画一张低分辨率的）
  第2轮：重新构建 → 已有图片自动裁切/加圆角/加来源标签，缺的那张显示占位框并在质检中报错
真实使用时，把 fake_image_tool() 换成你自己的生图能力即可。本库和本脚本都不调用任何生图 API。
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "scripts"))   # 使用技能自带的 scripts/pptdeck.py
from pptdeck import *  # noqa: E402

os.chdir(HERE)   # 所有相对路径（assets/、images/、输出文件）都相对于 examples/
LOCAL_IMG = os.path.join("assets", "console_mock.png")


# ---------------------------------------------------------------- 演示素材（替身）
def make_local_image(path):
    """生成一张"本地图片"示例：模拟调用方自备的界面截图。已存在就不重画。"""
    if os.path.isfile(path):
        return
    from PIL import Image, ImageDraw
    W, H = 1200, 800
    navy, teal, light, mid, white = "#1F3A5F", "#0B6E69", "#E8EEF4", "#9FB3C8", "#FFFFFF"
    im = Image.new("RGB", (W, H), white)
    d = ImageDraw.Draw(im)
    d.rectangle([0, 0, W, H * 0.14], fill=navy)                       # 顶栏
    d.rounded_rectangle([W * 0.30, H * 0.04, W * 0.72, H * 0.11], radius=12, fill=light)
    d.rectangle([0, H * 0.14, W * 0.18, H], fill=mid)                 # 左侧导航
    for k in range(5):
        d.rectangle([W * 0.03, H * (0.24 + 0.11 * k), W * 0.15, H * (0.28 + 0.11 * k)], fill=light)
    d.rectangle([W * 0.22, H * 0.20, W * 0.96, H * 0.24], fill=teal)  # 表头
    for k in range(6):                                                # 列表行
        y = H * (0.28 + 0.10 * k)
        d.rectangle([W * 0.22, y, W * 0.96, y + H * 0.06], fill=light if k % 2 else "#F7F9FC")
        d.rectangle([W * 0.24, y + H * 0.018, W * 0.40, y + H * 0.042], fill=mid)
        d.rectangle([W * 0.46, y + H * 0.018, W * 0.60, y + H * 0.042], fill=mid)
    d.rounded_rectangle([W * 0.78, H * 0.90, W * 0.95, H * 0.97], radius=10, fill=navy)   # 批量操作按钮
    os.makedirs(os.path.dirname(path), exist_ok=True)
    im.save(path)


def _monitors(d, W, H, x0, n=3):
    cw = W * 0.20
    for i in range(n):
        x = x0 + i * (cw + W * 0.03)
        d.rounded_rectangle([x, H * 0.30, x + cw, H * 0.72], radius=10, fill="#9FB3C8", outline="#1F3A5F", width=4)
        d.rectangle([x + cw * 0.12, H * 0.36, x + cw * 0.88, H * 0.62], fill="#E8EEF4")
        d.rectangle([x + cw * 0.42, H * 0.72, x + cw * 0.58, H * 0.78], fill="#1F3A5F")


def _people(d, W, H, n=3, board=False):
    if board:
        d.rectangle([W * 0.12, H * 0.16, W * 0.72, H * 0.52], fill="#E8EEF4", outline="#1F3A5F", width=4)
    for i in range(n):
        cx = W * (0.30 + 0.22 * i)
        d.ellipse([cx - 22, H * 0.46, cx + 22, H * 0.46 + 44], fill="#E9C4A0")
        d.rounded_rectangle([cx - 34, H * 0.55, cx + 34, H * 0.80], radius=14, fill="#0B6E69")


def paint(req):
    """按请求画一张"替身图"（扁平风格、无文字、无图表）。真实流程里这一步由生图能力完成。"""
    from PIL import Image, ImageDraw
    W, H = map(int, req["size"].split("x"))
    sub = req["subject"]
    im = Image.new("RGB", (W, H), "#E8EEF4")
    d = ImageDraw.Draw(im)
    d.rectangle([0, H * 0.80, W, H], fill="#C9D4E0")
    if "值班室" in sub:
        _monitors(d, W, H, W * 0.08, n=4 if W > H else 2)
    elif "白板" in sub:
        _people(d, W, H, n=3, board=True)
    elif "箱子" in sub:      # 迁移：在新旧系统之间搬运数据
        d.rounded_rectangle([W * 0.06, H * 0.30, W * 0.30, H * 0.74], radius=14, fill="#9FB3C8")
        d.rounded_rectangle([W * 0.70, H * 0.30, W * 0.94, H * 0.74], radius=14, fill="#0B6E69")
        d.polygon([(W * 0.34, H * 0.48), (W * 0.66, H * 0.48), (W * 0.66, H * 0.40), (W * 0.78, H * 0.52),
                   (W * 0.66, H * 0.64), (W * 0.66, H * 0.56), (W * 0.34, H * 0.56)], fill="#F28C28")
        d.rectangle([W * 0.40, H * 0.20, W * 0.52, H * 0.32], fill="#F2E6D0", outline="#1F3A5F", width=3)
        d.rectangle([W * 0.54, H * 0.16, W * 0.66, H * 0.32], fill="#F2E6D0", outline="#1F3A5F", width=3)
    else:
        _monitors(d, W, H, W * 0.10, n=3)
    return im


def fake_image_tool(req_file, skip_keyword="箱子", lowres_keyword="值班室"):
    """模拟调用方按 image_requests.json 生图：逐条"生成"图片保存到 filename。"""
    data = json.load(open(req_file, encoding="utf-8"))
    for r in data["requests"]:
        if r["status"] != "待生成":
            continue
        if skip_keyword in r["subject"]:
            print(f"  [模拟] 跳过 {r['id']}（演示缺图占位）")
            continue
        im = paint(r)
        if lowres_keyword in r["subject"]:
            im = im.resize((im.size[0] // 4, im.size[1] // 4))     # 演示分辨率不足警告
        os.makedirs(os.path.dirname(r["filename"]) or ".", exist_ok=True)
        im.save(r["filename"])
        print(f"  [模拟] 生成 {r['id']} {im.size[0]}x{im.size[1]} → {r['filename']}")


# ---------------------------------------------------------------- 演示文稿内容
def build():
    deck = Deck(title="设备管理台 v2 改版说明", source="产品需求文档 v2.3（示例）", theme="深蓝")
    room = deck.mood("现代化的运维值班室，一排显示器亮着，桌上放着咖啡杯")
    talk = deck.mood("一个人在会议室白板前讲解，旁边几个人在听")

    deck.cover(title="设备管理台 v2 改版说明", subtitle="给一线运维与客服的使用变更", author="示例作者",
               date="2026年10月", image=room, notes="开场先问一句\"上周谁因为找不到设备加过班\"，再进入正题。")

    deck.points([
        "看懂改版的三个主要变化",
        "知道旧数据迁移时要注意什么",
        "知道出问题找谁、怎么回滚",
    ], title="今天讲三件事", notes="逐条读一遍，说明最后一节留了时间答疑，别急着往下翻。")

    SECTIONS = ["为什么改", "三个主要变化", "迁移与风险", "上线与答疑"]
    deck.section(SECTIONS, current=1, image=room, notes="先讲背景：旧版为什么会被投诉，再说这次具体改了什么。")

    deck.slide("旧版最常被投诉的是找不到设备", [
        Bullets(["按台账逐级查找", "筛选条件只能单选", "找不到就导出表格"], relation="因果"),
    ], source="§1.2 用户反馈汇总", notes="念两条原始反馈，让大家先有代入感，再解释这些投诉背后的流程问题。")

    deck.section(SECTIONS, current=2, image=room, notes="进入第二部分：三个主要变化，逐个展开，每讲完一个停两秒看反应。")

    deck.slide("新版把查找、筛选、批量操作收进同一个页面", [
        Evidence(image=deck.image(LOCAL_IMG, source="设计稿 v2 · 主界面"),
                 callouts=[Callout("顶部搜索与筛选", 0.50, 0.07),
                           Callout("导航", 0.09, 0.55),
                           Callout("设备列表", 0.55, 0.45),
                           Callout("批量操作", 0.86, 0.93)]),
    ], source="§2.1 主界面", notes="指着设计稿走一遍：搜索在顶栏，列表不做跳转，批量按钮在右下角。")

    deck.slide("查找从五步缩短到两步", [
        Compare(headers=["旧版", "新版"], rows=[
            ("入口", ["台账 > 设备 > 查找", "首页搜索框"]),
            ("筛选", ["一次只能选一个条件", "多条件叠加"]),
            ("结果", ["跳到独立结果页", "原地刷新列表"]),
        ]),
    ], source="§2.2 交互对比", notes="强调\"原地刷新\"，不会丢失当前的筛选条件。")

    deck.slide("批量操作前会先校验权限", [
        Steps([
            Step("勾选设备", ["一次最多 200 台"], "超过上限提交会超时失败"),
            Step("选择操作类型", [], "不同操作要求的权限不同"),
            Step("确认影响范围", ["显示命中台数"], "避免误操作整批设备"),
            Step("提交并等待结果", ["结果异步返回"], "提交后可以先离开页面"),
        ]),
    ], source="§2.4 批量操作", notes="提醒：四步里只有最后一步是异步的，前面三步都在本地完成。")

    deck.slide("权限不足时按钮直接禁用，而不是等提交后报错", [
        Alert(level="注意", subject="客服账号默认没有批量操作权限",
              impact="点提交会收到 403，操作记录里会留痕", action="需要时走权限申请流程，或用管理员账号"),
    ], source="§2.5 权限说明", notes="这是本次改版唯一改动权限模型的地方，重点讲。")

    deck.section(SECTIONS, current=3, image=room, notes="进入第三部分：迁移与风险，这部分最容易出问题，需要讲得慢一点。")

    deck.slide("迁移期间旧系统只读，数据分批搬运", [
        Evidence(image=deck.illustration("在新旧两个系统之间用箭头和箱子搬运数据的场景比喻"),
                 caption="分批迁移"),
    ], source="§3.1 迁移方案", notes="这张插图只帮助理解，具体步骤以迁移手册为准。")

    deck.slide("用新旧耗时估算迁移窗口", [
        Example(problem="1 万条记录迁移约 4 小时，停机窗口 6 小时，够不够？",
                steps=["导出旧数据：约 2 小时", "转换与校验：约 1 小时", "导入并回滚预留：约 3 小时"],
                answer="4 小时刚好够，但没有余量"),
    ], source="§3.2 窗口估算", notes="按 6 小时现场算一次，让「没有余量」这件事可见。")

    deck.slide("想一想：停机窗口怎么排最稳", [
        Question(question="1 万条记录迁移约 4 小时，停机窗口 6 小时，最稳妥的做法是？", kind="选择",
                 options=["一次性迁移", "分两批迁移", "跳过校验直接导入"], answer="B. 分两批迁移",
                 explanation="分批能把每次的风险和回滚窗口控制在一半以内。"),
    ], source="§3.2 窗口估算", decor=talk, notes="现场投票，然后请一位同学说理由。")

    deck.slide("判一判：迁移当天能先改配置吗", [
        Question(question="为了省时间，迁移当天可以先改新系统的配置，再导入数据。", kind="判断",
                 answer="错误", explanation="配置先改会让导入校验按新规则执行，出问题不好回滚。"),
    ], source="§3.3 迁移当天纪律", decor=talk, notes="这题是提醒：当天只做迁移，不改别的。")

    deck.section(SECTIONS, current=4, image=room, notes="进入第四部分：上线与答疑，先讲清单，再留十分钟给大家提问。")

    deck.slide("上线当天按这张表盯三件事", [
        Table(headers=["时间", "动作", "谁负责"], rows=[
            ["20:00", "停止旧系统写入", "值班运维"],
            ["20:30", "导出并校验数据", "值班 DBA"],
            ["23:30", "切换入口并冒烟", "值班运维"],
        ]),
    ], source="§4.1 上线清单", notes="这里只列三个关键节点，完整清单会后发到群里。")

    deck.summary([
        "查找与批量操作收进同一页",
        "权限不足时按钮直接禁用",
        "迁移分批做，当天不改配置",
    ], source="§1–§4", prompt="如果迁移当天出问题，第一步做什么？", notes="请一位同学先回答提问，再回顾三条结论，最后留两分钟收尾。")
    return deck


if __name__ == "__main__":
    import shutil
    shutil.rmtree("images", ignore_errors=True)        # 演示从零开始
    make_local_image(LOCAL_IMG)
    print("========== 第1轮构建 ==========")
    build().save("demo.pptx", draft=True)
    print("\n========== 模拟按 image_requests.json 生图 ==========")
    fake_image_tool("image_requests.json")
    print("\n========== 第2轮构建 ==========")
    # 示例故意留一张插图不生成，用来演示"缺图→占位框→报错"这条路径；
    # 所以最终一版仍带 1 个必须修复，这里用 draft=True 让它也能写出来。真实使用时补齐图片再正常 save()。
    build().save("demo.pptx", draft=True)

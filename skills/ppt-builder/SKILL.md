---
name: ppt-builder
description: 制作 PPT / 演示文稿（.pptx）：给一份大纲、文档、要点或一页材料，输出排版整齐、不会溢出、带讲者备注的幻灯片。适用于汇报、路演、培训、课程、产品介绍等要稳定出片的场合。用内置组件库 scripts/pptdeck.py 自动排版与质检，支持本地图片、AI 插图与氛围图。用户说"做个 PPT""做演示文稿""做一份汇报的幻灯片""把这份材料做成 PPT"时使用。
---

# PPT 制作（ppt-builder）

下文 `<SKILL_DIR>` 指本 SKILL.md 所在目录的绝对路径（写命令和 build.py 时替换成实际路径）。演示文稿的工作目录另建（如用户的项目文件夹），不要把产物写进技能目录。所有脚本都在 `<SKILL_DIR>/scripts/`，详细手册在 `<SKILL_DIR>/references/`，需要时再读。

## 能力边界（先读这段，别靠试错发现）

**能做的**：把"内容"排成一套统一的版式——12 栏网格、4 档字号、内置 3 套主题或自定义设计令牌、
9 个内容组件 + 7 个页型；每一页都自动校验溢出、标题唯一、讲者备注，产出可编辑的 .pptx。

**做不到的（别指望，也别承诺给用户）**：
- 不能自由定位：没有坐标、字号、行距、边距参数——版式由系统算；
- 不能还原一份既有设计稿的版式：它只认"内容 + 组件"，不认"像素位置"；要 1:1 装设计稿用 `image_page` / `hero`；
- 字号只有 4 档，靠令牌的 `scale` 整体缩放，不能单页调；
- 没有动画、切换、原生图表（要图表先出图，再走 `Evidence` 或 `image_page`）；
- 不支持合并单元格、脚注、自动目录、图片局部裁切框选。

**先问一句再动手**：这份材料的设计定了吗？
- 设计已定（有设计稿、参考图、上一版成品）→ 用 `image_page` 把整页图装进去，或干脆不用本技能；
- 设计未定（只有大纲/文档/要点）→ 本技能最合适。

**不确定某个字段能不能放、最多几个字** → 跑 `python <SKILL_DIR>/scripts/deck_schema.py`（人读）
或 `--json`（机器读）。它直接从源码抽字数上限，不会和代码漂移；不要靠读散文手册或数汉字去猜。

## 核心原则（最高优先级）
1. **模型决定放什么，系统决定怎么放**：你只选组件、填内容。生成**只能**调用 `scripts/pptdeck.py`；**禁止**直接用 python-pptx 画形状/文本框/图片，禁止设置坐标、字号、颜色，禁止修改 pptdeck.py 或吞掉它的报错。
2. **一页一个结论**：标题是一句完整的结论（≤32 字），能画图/流程图/对比的不用列表。
3. **内容必须是真的**：不编造数据、人名、时间、结论。材料里没有的数字向用户要；拿不准的地方写进 notes 并说明，不要塞进标题或正文。
4. **放不下就改内容**：报错时删字、拆页或换组件，**绝不**缩小字号或绕过校验。

## 工作流程（按顺序，不要跳步）

**第 0 步 检查环境**：`python <SKILL_DIR>/scripts/check_env.py`。缺必需依赖就按提示安装（`pip install python-pptx pillow`）；缺 LibreOffice 只是不能渲染，记下来，交付时说明。脚本会跑一次**真实渲染探针**——如果它报"渲染不出中文"，按提示把一个中文 TTF 复制进 LibreOffice 的字体目录，否则后面看图质检看到的全是豆腐块（这种失真比不检查更危险）。

**第 1 步 确认三件事**（用户没给就先问，缺哪项问哪项）：
- **内容与对象**：讲什么、给谁看、时长或页数上限，以及已有的大纲/文档/数据/截图；
- **结构**：分几节、每节大致几页（用户没给就由你出大纲）；
- **署名与来源**：封面上的标题、副标题、讲者、日期；每页要不要标来源（文档名/版本/页码，也可以不标）。

**第 2 步 出大纲**：每页一行：
`第N页 | 组件 | 标题（一句结论） | 来源 | 图片（无 / 本地图片：文件名 / 插图：画面描述 / 氛围图：画面描述）`
推荐结构：封面 → 要点页 → 各节（节多时用章节过渡页）→ 小结。内容多、或用户没给结构时，**先把大纲给用户确认再往下做**；用户已经给了明确结构就直接生成。
选组件看 `references/components.md` 末尾的对照表；结构与页数规则见 `references/layout-rules.md`。

**第 3 步 写 build.py 并运行**：在工作目录写 `build.py`（模板见下方速查），按大纲逐页调用，最后 `deck.save("演示.pptx")`。运行 `python build.py`。
- 校验错误**一次性给全**：一次运行会列出所有页的所有问题（每页每个组件各一条），并**不写出 pptx**；把清单一次改完再重跑，不要修一个跑一次。组件参数和字数限制查 `deck_schema.py` 或 `references/components.md`。
- 素材：用户给的图片复制到工作目录 `assets/`，用 `deck.image("assets/xxx.png", source=...)` 引用。

**第 4 步 生成图片**：脚本跑通后，工作目录里有 `image_requests.json`。对每条 `status` 为"待生成"的请求：把 `prompt` 原样交给你的生图能力（支持反向提示词就填 `negative`），按 `size` 生成，保存为 PNG 到 `abs_filename`（路径必须完全一致）。没有生图能力就跳过，保留占位框并在报告说明。详见 `references/images.md`。

**第 5 步 重新运行** `python build.py`（同一工作目录）。系统会自动裁切、加圆角和来源标签，并检查图片。

**第 6 步 渲染并看图质检**：`bash <SKILL_DIR>/scripts/render.sh 演示.pptx render`，先看 `render/contact.png` 总览，再逐页打开 `render/page-*.png`。几何/存在性核对不用自己做：`deck.save()` 已自动调用 `scripts/qa.py` 并把结果附在报告里；也可以单独跑 `python <SKILL_DIR>/scripts/qa.py 演示.pptx [--json]`（越界、空文字、标题重复、图片 DPI、备注覆盖率）。（没有 bash 的 Windows 环境：`soffice --headless --convert-to pdf 演示.pptx` 后逐页查看 PDF；无法渲染就在报告写"未做渲染检查"。）按 `references/qa-checklist.md` 检查内容层和视觉层；AI 图按 `references/images.md` 第 5 节的视觉清单检查（图里有无文字/乱码、是否与事实矛盾）。

**第 7 步 修复循环**：按 `save()` 打印的质检报告修改：【必须修复】全部清零，【建议修复】尽量处理，然后重跑第 5–6 步。同一页或同一张图**最多 3 轮**；仍不行就改成最简单形式（`Evidence(placeholder=...)` 或 `Bullets`），notes 写"【需人工检查】原因：……"，继续往下。

**第 8 步 交付**：`演示.pptx`、`build.py`、`images/`、`image_requests.json`，以及质检报告（模板见 `references/qa-checklist.md` 第 7 节：报错修复记录、save() 报告原文、来源标注清单、【需人工检查】页、图片清单、是否做了渲染检查、内容层自查结果）。

## API 速查（最小可用）
```python
import sys
sys.path.insert(0, r"<SKILL_DIR>/scripts")      # 换成本技能 scripts 目录的实际路径
from pptdeck import *

deck = Deck(title="设备管理台 v2 改版说明", source="产品需求文档 v2.3", theme="深蓝")  # 深蓝 / 墨绿 / 石墨

# 需要自定义视觉时传设计令牌（只写要改的键，其余取默认）：
# deck = Deck(title="课程课件", theme=dict(primary="1D5446", accent="B45309", bg="FBF9F4",
#                                        font="Microsoft YaHei", scale=1.05, chrome=True))
# 令牌字段：primary/accent/bg/text/gray/line/font/chrome/scale/title_size/body_size/small_size/foot_size
# chrome=False 不画顶部色条、页脚线与页码；字体必须在**演示机器**上存在，否则会掉字

room = deck.mood("现代化的运维值班室，一排显示器亮着")        # 氛围图：只用于封面/章节页/互动页
deck.cover(title="设备管理台 v2 改版说明", subtitle="给一线运维的使用变更", author="张三",
           date="2026年10月", image=room)
deck.points(["看懂三个主要变化", "知道迁移要注意什么"], title="今天讲三件事", source="§1", notes="……")
S = ["为什么改", "三个主要变化", "迁移与风险"]
deck.section(S, current=1, image=room)

# 内容页：deck.slide(结论标题, [1–2 个组件], source=..., notes=完整讲解)
deck.slide("新版把查找和批量操作收进同一个页面", [
    Evidence(image=deck.image("assets/console.png", source="设计稿 v2"),
             callouts=[Callout("顶部搜索", 0.50, 0.07), Callout("批量操作", 0.86, 0.93)])],
    source="§2.1", notes="……")
deck.slide("查找从五步缩短到两步", [
    Compare(headers=["旧版", "新版"], rows=[("入口", ["台账 > 查找", "首页搜索框"])])],
    source="§2.2", notes="……")
deck.slide("批量操作前会先校验权限", [
    Steps([Step("勾选设备", ["一次最多 200 台"], "超过上限提交会超时"),
           Step("确认影响范围", ["显示命中台数"], "避免误操作整批设备"),
           Step("提交并等待结果", ["结果异步返回"], "提交后可以先离开页面")])],
    source="§2.4", notes="……")
deck.slide("权限不足时按钮直接禁用", [
    Alert(level="注意", subject="客服账号默认没有批量权限", impact="提交会收到 403",
          action="走权限申请流程，或用管理员账号")],
    source="§2.5", notes="……")
deck.slide("想一想：停机窗口怎么排最稳", [
    Question(question="迁移约 4 小时，窗口 6 小时，最稳妥的做法是？", kind="选择",
             options=["一次性迁移", "分两批迁移", "跳过校验"], answer="B. 分两批迁移",
             explanation="分批把每次的风险和回滚窗口控制在一半以内。")],
    source="§3.2", decor=room, notes="……")                    # 参考答案页自动生成在下一页
deck.summary(["查找与批量操作收进同一页", "权限不足时按钮禁用"], source="§1–§4",
             prompt="如果当天出问题，第一步做什么？", notes="……")
deck.save("演示.pptx")      # 写出 演示.pptx、演示_QA.txt、image_requests.json，并打印质检报告
```

### 设计已定：把整页图 1:1 装进 pptx（还原场景）

```python
deck = Deck(title="课程课件（图片还原版）", theme="深蓝")
deck.image_page("assets/slide-01.png", notes="第 1 页讲稿", page_no=True)   # 整页铺满，不加标题与页脚
deck.image_page("assets/slide-02.png", caption="第 2 页：价格差之谜")       # 可选图注，底部一条
deck.hero("assets/cover.png", "标题压在图上", subtitle="副标题", position="bottom")  # 图打底 + 主色面板
deck.save("课件.pptx")
```

要点：`image_page` 是唯一会**跳过标题/骨架**的页型（`fit="contain"` 等比留白、`"cover"` 裁边铺满）；
`hero` 保留标题（仍受"标题唯一"约束）。两者都吃 `deck.image(...)` 或本地路径字符串。

其他组件：`Definition(term, definition, note)` 概念卡片、`Bullets(items, relation)` 要点列表（最后才考虑）、`Example(problem, steps, answer)` 示例讲解、`Table(headers, rows)` 表格。全部参数和限制见 `references/components.md`。

## 需要时再读
| 文件 | 什么时候读 |
|---|---|
| `references/components.md` | 第 2–3 步：每个组件的用途、参数、字数限制、示例；组件选择对照表 |
| `references/layout-rules.md` | 第 2 步：整份结构与每页规则（版式由系统自动执行） |
| `references/images.md` | 大纲里有图时、第 4 步：三类图片怎么选、画面描述怎么写、两步生图、图片质检 |
| `references/qa-checklist.md` | 第 6–8 步：三层质检、视觉清单、修复循环、交付报告模板 |
| `scripts/deck_schema.py`（不是文档，是命令） | 第 2–3 步：不确定字段/字数上限时先跑它，`--json` 给机器读、`--verify` 自检 |
| `scripts/qa.py`（不是文档，是命令） | 第 6 步：对已生成的 pptx 做几何/存在性核对，`--json` 可机读 |
| `scripts/eval_deck.py`（不是文档，是命令） | 改完技能做回归时：对产物下客观断言（页数/备注/整页图铺满/图上无叠字/qa 计数），`--mode restore` 查还原稿 |
| `references/textbook-deck-example.md` | 要按教材/文档做可溯源的课件或培训材料时：页码标注、【补充】标法、原图优先等**做法示例** |
| `examples/demo.py` | 想看一份完整的 build 脚本（19 页，含三类图片与全部组件）时 |

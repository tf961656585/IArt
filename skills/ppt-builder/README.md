# ppt-builder（PPT 制作技能）v0.3

让 AI Agent 把一份大纲、文档或要点做成**排版整齐、可复现**的 PPT（.pptx）。Agent 只决定"每页放什么"，排版、字号、配色、图片裁切和质检全部由内置组件库 `scripts/pptdeck.py` 完成，所以能力较弱的模型也能做出不溢出、不重排的成片，并且成品自带讲者备注。

本技能是自包含的：只用自己目录下的脚本，依赖为 `python-pptx` + `Pillow`（渲染看图另需 LibreOffice 与 pdftoppm，可选）。

## v0.3 新增（设计令牌 / 还原页型 / 一次性校验 / 自检）

- **设计令牌**：`Deck(theme=dict(primary=..., bg=..., font=..., scale=..., chrome=...))`，不再只有 3 套固定主题；
  `chrome=False` 可关掉顶部色条与页脚（自定义底图时用）。
- **还原页型**：`deck.image_page(...)` 把整页图 1:1 装进 pptx（不加标题/骨架），`deck.hero(...)` 图打底 + 标题压图。
  "把设计好的图片课件变成 pptx"从此是一条命令，不再需要自己拼形状。
- **错误一次性给全**：一页/一份稿的问题一次列完并**拒绝写出坏稿**，不再修一个跑一次。
- **`scripts/deck_schema.py`**：导出能力、组件字段、字数上限（**从源码 AST 抽取**，不会和代码漂移）、
  数量上限、令牌字段与"做不到什么"；`--json` 机器读，`--verify` 自检。
- **`scripts/qa.py`**：几何/存在性质检（越界、占位残留、标题重复、图片 DPI、备注覆盖率、文字重叠疑似），
  `save()` 自动调用并附在报告里。
- **`check_env.py` 增加真实渲染探针**：不只查 `fc-list`，而是真的让 LibreOffice 画一句中文再数笔画——
  macOS 上"字体装了但渲染不出中文"这个坑现在会被直接报出来并给出修法。

## 它能做什么
- 按"确认需求 → 大纲 → 生成 → 质检 → 修复"的流程做演示文稿，适合汇报、路演、培训、课程、产品介绍等场景。
- 内容组件：封面、要点页、章节过渡、图片证据（可加标注）、概念卡片、要点列表、步骤流程、对比、示例讲解、现场提问（自动生成参考答案页）、警示框、表格、小结。
- 三类图片：本地图片（调用方自备，等比放入不裁切、可加标注）、AI 插图、AI 氛围图。组件库**不调用任何生图接口**，而是输出 `image_requests.json`（完整 prompt + 目标文件名），由 Agent 用自己的生图能力生成后重跑。
- 自动质检：字数/条数/版面溢出即时报错（给出修复建议，绝不偷偷缩字）；整体报告检查标题重复、来源标注、讲者备注覆盖率、图片缺失/分辨率/比例等。
- 渲染看图：`scripts/render.sh` 把 pptx 转成逐页 PNG 和一张总览，供逐页核对版式与图片。

## 目录
```
ppt-builder/
├── SKILL.md              # Agent 读的主指令（简明流程 + API 速查）
├── README.md             # 本文件（给人看）
├── scripts/
│   ├── pptdeck.py        # 组件库（唯一允许的生成入口）
│   ├── check_env.py      # 环境检查
│   ├── render.sh         # pptx → 逐页 PNG + 总览（需 LibreOffice）
│   └── contact.py        # 拼缩略图总览
├── references/           # Agent 按需读取的详细手册
│   ├── components.md  layout-rules.md  images.md  qa-checklist.md
│   └── textbook-deck-example.md   # 可溯源教材课件的做法示例（非校验规则）
└── examples/             # 自包含示例：只保留 demo.py，运行即生成全部素材与产物
    └── demo.py
```

## 安装
- **支持 Skills 的 Agent**（Claude Code / Claude、Codex 类工具、WorkBuddy 等）：把整个 `ppt-builder/` 文件夹复制到该工具的 skills 目录（例如 `~/.claude/skills/`、项目内 `.claude/skills/`，或工具文档指定的目录），重启或刷新技能列表即可。Agent 会根据 SKILL.md 的 description 自动触发。
- **不支持 Skills 的工具**：把文件夹放到 Agent 能访问的位置，把 `SKILL.md` 的内容作为系统提示/项目说明，并告诉它"`<SKILL_DIR>` = 这个文件夹的路径"。
- 安装后让 Agent（或你自己）运行一次：`python ppt-builder/scripts/check_env.py`。

## 环境要求
- 必需：Python 3.8+，`pip install python-pptx pillow`
- 可选（渲染看图质检）：LibreOffice、poppler-utils（pdftoppm）、中文字体（如 Noto Sans CJK）
- 可选：Agent 自带的生图能力（没有的话 AI 图会保留占位框，演示文稿仍可交付）

## 试用
1. 运行示例：`python examples/demo.py`（自动生成素材、模拟完整两步生图流程、输出 19 页示例与两份质检报告），再 `bash scripts/render.sh examples/demo.pptx /tmp/render` 查看效果。
2. 正式使用：对 Agent 说"把这份材料做成 20 分钟的汇报 PPT"，附上大纲/文档/数据，以及需要放进页面的图片。
3. 反馈时请带上：生成的 pptx、build.py、image_requests.json、images/、质检报告和中途报错。

## 已知限制
- 文字宽度是估算的（偏保守），偶尔会多留空白；字体指定微软雅黑，其他电脑上可能被替换。
- 一次只报一个组件层错误（脚本在第一个错误处停止），多处超限需要多轮修复。
- 版式为顶部对齐的固定网格，暂不支持自定义模板/母版、动画、视频、音频、图表（数据图建议做成图片）。
- 内容层（内容是否与来源一致、有没有事实错误）和图片视觉层（AI 图里有无乱码、是否与事实矛盾）只能靠 Agent 自查和用户确认。
- AI 图不能保证准确：凡是数字、图表、结构标注、需要精确的示意图，请用本地图片或组件（表格/步骤/对比），不要用插图。
- 本地图片需要调用方自备（截图、图表、照片），组件库不会从整页材料里自动切图；插图为居中裁切，主体偏一侧时可能被裁。
- `render.sh` 需要 bash；Windows 下需手动用 LibreOffice 转 PDF 查看。
- 换了画面描述后，旧的源图（images/旧id.png）不会自动删除（处理后的中间图会自动清理）。
- `examples/demo.py` 里的图片是 PIL 画的替身图，真实生图能力的效果未在本包中测试；运行示例会生成 `examples/assets/`、`examples/images/` 与输出文件，这些都可以随时删除。

# 探针工具

浏览器里跑的一次性核验页，不属于构建链、不参与门禁。

## cdp-electron-driver.mjs

不是核验页，是**驱动基座**：裸 CDP（node + ws）attach 到运行中的 dev Electron 窗口，做真机 DOM / 交互验证——`jsdom` 不实现命中测试与指针捕获，面板内可交互浮层、「点击没反应」类改动交付前必须用真实鼠标输入点一次（纪律见仓库 `AGENTS.md`「交互命中类改动没有机械兜底」条），本脚本是那条纪律的现成工具。attach 的窗口目标查找、`Page.bringToFront` / `Page.reload`（产物重建后热换，editor 与 hub dist 均实测免重启）、`Runtime.evaluate`（returnByValue）与真实鼠标三连都已封装。

**用法**：dev 实例已起（未打包默认 9222，`IART_CDP_PORT` 可覆盖）→ 各次验证写一次性 phase 脚本 `import { attachHub, sleep, realClick } from '<repo>/tooling/probes/cdp-electron-driver.mjs'` → 定位元素用「`scrollIntoView({block:'center'})` 后取 `getBoundingClientRect` 中心」→ `realClick` → **读数复核**。Editor 窗口要先在 Hub 里点开项目卡片才出现，按 URL 含 `/editor/` 过滤。

**四坑纪律**（2026-09-26 批次实证，违者会得出假结论）：① `evalJs` 必须 `await`，Promise 当坐标会静默点空；② 视口外元素 rect 超界直接点落空，先 scrollIntoView；③ Radix 勾选框无原生 input，查 `[role="checkbox"]` 按 aria-label 定位，候选列表 DOM 含全部条目、innerText 过滤 ≠ DOM 范围；④ `send` 不查 CDP error 字段、错误被吞，每次点击后必须读数复核（aria-checked / aria-pressed / computed display / 按钮文案），「脚本跑完」≠「点中」。

**局限**：驱动的是运行中的真实应用，读数即事实；但不覆盖自动化断言的持久性——phase 脚本是一次性的，结论要落进当轮交付汇报或测试。

## css-geometry-probe.html

把目标组件链路的 Tailwind 类逐条等价转写成静态 HTML，在真实 Chromium 里量 rect（容器/媒体框、溢出像素、可见比例），用来验证 CSS 布局语义——`jsdom` 无语义布局，类型检查与静态门禁都不覆盖（纪律见仓库 `AGENTS.md`「Harness：门禁体系」的「布局/尺寸类改动没有机械兜底」条）。

**用法**：把要验证的类名转写进页面（文件头注释有默认的 Editor 弹窗链转写说明）→ 用 browser 工具打开并显式给 `viewport`（`90vh` 依赖视口高度）→ `evaluate` 调 `MEASURE([['A','dA','iA'],['B','dB','iB']])` 取几何数值 → 可选 `screenshot({selector:"#stageA"})` 取视觉佐证。

**局限**：只验证 CSS/cascade 语义，不覆盖组件真实装配与运行时数据；结论以数值为准，截图只作辅助。

## pointer-capture-probe.html

核验「面板指针捕获吞掉槽内按钮点击」这一类交互故障：内部可交互浮层（底部导航槽 / 工具栏 / 缩放 HUD）的按钮挂在带拖拽平移的面板上，而面板在 `pointerdown` 里 `preventDefault` + `setPointerCapture` 后，浏览器会把随后的 `mouseup` / `click` 重定向到面板本体——槽内按钮的 `onclick` 永不执行，表现为「点了没反应」（2026-09-23 相册预览「下一张」即此故障）。`jsdom` 不实现命中测试与指针捕获，`fireEvent.click` 直接投递目标节点，单测对此静态绿，故需要本探针。

**用法**：用 browser 工具打开 → 对每个用例按钮调 `clickAt(按钮中心)`（**必须真实鼠标输入**，用 `evaluate` 派发合成事件会绕开捕获语义、得出假的绿色）→ `__PROBE.events()` 读事件序列，`__PROBE.reset()` 清空。判据：出现 `<按钮 id>: BUTTON CLICKED` 才算按钮收到点击；只有 `surface: click ... (target=surface)` 即被捕获吞掉。四个用例即四组对照：A 复现（无守卫）、B 只 `preventDefault` 不捕获（正常）、C 按钮自身 `stopPropagation`（工具栏旧写法，正常）、D 守卫挂在槽位容器上（`SLOT_INTERACTION_GUARD` 修复形态，正常）。

**局限**：只验证浏览器指针捕获/命中语义，不覆盖 React 装配；React 侧的 prop 接线由 `apps/editor/src/components/ui/zoomable-image-preview/__tests__/ZoomableImagePreview.test.tsx` 兜住。

## container-gap-hit-probe.html

核验「容器内空隙（成员之间的空白）命中谁」这一类交互故障：画布容器（节点组 / Agent 节点容器）用围栏模型——容器背板与内部空隙是纯视觉层，命中要穿透到画布（单击不选中容器、拖拽平移视口），容器自身可点/可拖的区域只有容器头交互条（展开态）与折叠卡片（折叠态）。口径见 `docs/runtime/画布节点组.md`「选择」/ AG-CN-016。

穿透由投影层在节点包裹层上注入**内联** `pointer-events: none`（`nodeCanvasFlowProjection.ts` 的 `CONTAINER_FLOW_NODE_STYLE`）实现——React Flow 自己也在包裹层上内联注入 `pointerEvents`，内联值压过任何样式表规则：只写一条 CSS 规则（`.react-flow .react-flow__node-agent { pointer-events: none }`）**不生效**，整个容器矩形仍是实心命中区（2026-09-23 实测缺陷：Agent 容器空隙单击选中容器、拖拽搬走容器）。`jsdom` 不实现命中测试，单测对此静态绿，故需要本探针。

**用法**：用 browser 工具打开（**需显式给 `viewport` 高度 ≥ 900**，三个用例纵向排布；`file://` 偶发打不开时改用 `python3 -m http.server` 在 `tooling/probes/` 起静态服务走 `http://127.0.0.1:8791/container-gap-hit-probe.html`）→ `__PROBE.points()` 取各用例的 `gap` / `header` / `member` 屏幕坐标 → 用 `clickAt`，拖拽用 `mouseMove` **先移到起点**再 `mouseDown` → `mouseMove` 终点 → `mouseUp`（`mouseDown` 不移动指针，缺了前置 `mouseMove` 会按在上一处位置；且必须真实鼠标输入，`evaluate` 派发合成事件会绕开命中语义）→ `__PROBE.events()` 读事件序列，`__PROBE.reset()` 清空。判据：空隙点出现 `pane: ...` 且不出现 `node: ...` 才算穿透成立；容器头点必须出现 `node: ...`。三组对照：A 修复前（仅 CSS 规则，空隙命中容器）、B 修复后（投影层内联穿透，与 C 一致）、C 节点组（既有口径）。

**局限**：只验证浏览器命中/cascade 语义，不覆盖 React 装配与真实画布；投影层接线由 `apps/editor/src/features/canvas/components/canvas/__tests__/groupDerivedSize.container.test.ts` 兜住。

// verify-settings-density.mjs — 设置页密度与行承载八指标真机验收（dev 运行 + CDP 9222）。
//
// 判据 owner：docs/hub/visual-design.md §8.5（密度）与 §8.6（行承载三律）；
// 登记：docs/harness/gates.md「运行时验收入口」。
// 不并入 check:preflight（需要真实窗口）；设置域布局/密度/行承载改动交付前必须运行。
// 复用 cdp-probe 的连接与真实输入纪律（先例：verify-hub-title-band.mjs）。
//
// 八指标（①② 2026-09-29 密度重组后标定，③④ 同日随行承载三律标定；
// ⑤–⑧ 2026-10-16 商店「管理自定义 Agent 目录」弹层行承载标定；阈值随实现态校准，
// derivation 见各常量注释）：
//   ① 「标题↔同行动作」最长无内容横档 ≤240px（只量含 h1-h4 的标题行；字段行 trailing 对齐豁免，
//      基线 681px @「服务商↔刷新」，重组后 0px）
//   ② 分栏容器人工垫高 ≤24px = 容器高 − max(左右列内容高)
//      （基线 min-h-[420px] 垫高 ~121px，重组后 ~0-18px；列背景连续性由 stretch 承担，
//      本指标只拦「用 min-h 给内容面板垫底」的回潮）
//   ③ 行内同高档：服务商详情模型行内输入框与按钮底边差 ≤1px（行内编辑排 32px 档；
//      旧态实测 2px——h-7 输入 28px 与 sm 按钮 32px 混排居中的几何必然，visual-design §8.6 律一。
//      行无行内编辑排时记 SKIP，不计失败也不计入分母）
//   ④ 行承载容器呼吸档：模型行容器 computed padding 垂直 ≥8px 且水平 ≥12px
//      （律二钉死 py-2/px-3；旧态实测垂直 2px（py-0.5）/ 水平 8px（px-2）贴边）
//   ⑤ 商店弹层行承载内距：内置目标行容器 computed padding 垂直 ≥8px 且水平 ≥12px（律二）
//   ⑥ 商店弹层行间空档：内置目标行↔行垂直空档 = 8px±0.5（律三）
//   ⑦ 商店弹层组间空档：内置组末行底 → 下一组（自定义列表首行 / 空态文本块）顶 = 16px±0.5（律三）
//   ⑧ 商店弹层行内编辑排混高：编辑行（编辑态两行——首行名称输入框 + 保存/取消，次行文件夹
//      输入框 +「选择文件夹」）各自「输入框 vs 同排按钮」底边差 ≤1px，输出取两行最大差（律一）。
//      注册表无自定义目标时记 SKIP（本脚本不写用户注册表，不为此创建目标）。
//
// 已退役指标（勿再加回）：设置页滚动容器屏数 scrollHeight/clientHeight —— 2026-10-16 用户裁决移除，
// 理由：屏数随开发进度与用户配置（服务商条目数等）动态变化，固定阈值不合理。退役前阈值 ≤1.55
// （2026-09-29 标定），实测自 1.46 漂移至 2.03（10-13）→ 2.09（10-16）。
// 弹层三项几何断言的前提：弹层进入稳定态（enter 动画已结束）。本机 dev 常被遮挡——
// renderer 处于 hidden 时动画冻结在 0.95 缩放，rect 全部失真，故先开 focus emulation
// 强制可见，再等 computed transform 归 none（2026-10-16 实测：仅 setWebLifecycleState
// 不足以唤醒，Emulation.setFocusEmulationEnabled 有效）。
//
// 用法：pnpm desktop:run-built 起 dev 后 `pnpm verify:settings-density`。

import { getTargets, Cdp } from '../../.agents/skills/project-development-discipline/scripts/cdp-probe.mjs';

const MAX_VOID_GAP = 240; // 指标① px
const MAX_SPLIT_PAD = 24; // 指标② px
const MAX_BOTTOM_DIFF = 1; // 指标③⑧ px
const MIN_PAD_Y = 8; // 指标④⑤ 垂直 px
const MIN_PAD_X = 12; // 指标④⑤ 水平 px
const STORE_ROW_GAP = 8; // 指标⑥ px（律三：列表行间 gap-2）
const STORE_GROUP_GAP = 16; // 指标⑦ px（律三：组间空档 gap-4）
const GAP_TOLERANCE = 0.5; // 指标⑥⑦ px（设备像素取整余量）

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 指标①：标题行拉空。扫 flex/grid 且 space-between、且含 h1-h4 的行，取相邻可见子元素最大水平空档。
const GAP_JS = `(() => {
  let best = { gap: 0, where: '' };
  for (const el of document.querySelectorAll('body *')) {
    const st = getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden') continue;
    if (!(st.display.includes('flex') || st.display.includes('grid'))) continue;
    if (st.justifyContent !== 'space-between') continue;
    if (!el.querySelector('h1, h2, h3, h4')) continue;
    const kids = [...el.children].filter((k) => {
      const s = getComputedStyle(k);
      return s.display !== 'none' && s.visibility !== 'hidden';
    });
    if (kids.length < 2) continue;
    for (let i = 0; i + 1 < kids.length; i++) {
      const a = kids[i].getBoundingClientRect();
      const b = kids[i + 1].getBoundingClientRect();
      if (a.width === 0 || b.width === 0) continue;
      const gap = Math.round(b.left - a.right);
      if (gap > best.gap) best = { gap, where: (el.textContent || '').trim().slice(0, 24) };
    }
  }
  return best;
})()`;

// 指标②：分栏容器人工垫高。容器 = 首个子树含「添加服务商」按钮的双子元素容器；
// 垫高 = 容器 clientHeight − max(各列 scrollHeight)。
const SPLIT_JS = `(() => {
  const root = document.getElementById('providers');
  if (!root) return { error: 'providers 锚点不存在（当前不在设置页？）' };
  let split = null;
  for (const el of root.querySelectorAll('*')) {
    const kids = [...el.children];
    if (kids.length < 2) continue;
    if ((kids[0].textContent || '').includes('添加服务商')) { split = el; break; }
  }
  if (!split) return { error: '主从分栏容器未找到' };
  const cols = [...split.children].map((c) => c.scrollHeight);
  const excess = Math.round(split.clientHeight - Math.max(...cols));
  return { excess, boxH: split.clientHeight, cols };
})()`;

// 指标③④：行承载（visual-design §8.6）。行容器 = 详情里含 <input> 的 bg-elevated 行（第一个）。
const ROW_JS = `(() => {
  const rows = [...document.querySelectorAll('#providers .bg-elevated')].filter((el) => el.querySelector('input'));
  if (rows.length === 0) return { skip: '无含行内编辑排的模型行（retired 塌缩或纯自建行）' };
  const row = rows[0];
  const cs = getComputedStyle(row);
  const bottoms = [...row.querySelectorAll('input, button')].map((el) => el.getBoundingClientRect().bottom);
  if (bottoms.length < 2) return { skip: '行内控件不足 2 个' };
  const maxDiff = Math.round((Math.max(...bottoms) - Math.min(...bottoms)) * 10) / 10;
  return { pt: cs.paddingTop, pb: cs.paddingBottom, pl: cs.paddingLeft, pr: cs.paddingRight, maxBottomDiff: maxDiff, rowH: Math.round(row.getBoundingClientRect().height) };
})()`;

// 指标⑤⑥⑦：商店「管理自定义 Agent 目录」弹层行承载（visual-design §8.6）。
// 内置行 = 弹层内容槽内无 input/button 的 bg-elevated 行（静态两行，不依赖用户注册表）；
// 下一组 = 外层 gap-4 容器的第二个子元素（自定义列表 / 空态文本块 / 读取中 / 读取失败态）。
const STORE_JS = `(() => {
  const content = document.querySelector('[data-slot="dialog-content"]');
  if (!content) return { error: '弹层未打开' };
  const body = content.querySelector('[data-slot="dialog-body"]');
  if (!body) return { error: '弹层内容槽未找到' };
  const rows = [...body.querySelectorAll('.bg-elevated')];
  const builtin = rows.filter((r) => !r.querySelector('input, button'));
  const custom = rows.filter((r) => r.querySelector('button'));
  const firstChildTop = (el) => (el.children[0] ? el.children[0] : el).getBoundingClientRect().top;
  const outer = builtin.length > 0 ? builtin[0].parentElement.parentElement : null;
  const nextGroup = outer && outer.children[1] ? outer.children[1] : null;
  const cs = builtin.length > 0 ? getComputedStyle(builtin[0]) : null;
  return {
    transform: getComputedStyle(content).transform,
    builtinCount: builtin.length,
    pad: cs ? { pt: cs.paddingTop, pb: cs.paddingBottom, pl: cs.paddingLeft, pr: cs.paddingRight } : null,
    rowGap: builtin.length >= 2
      ? +(builtin[1].getBoundingClientRect().top - builtin[0].getBoundingClientRect().bottom).toFixed(1)
      : null,
    groupGap: builtin.length > 0 && nextGroup
      ? +(firstChildTop(nextGroup) - builtin[builtin.length - 1].getBoundingClientRect().bottom).toFixed(1)
      : null,
    groupKind: nextGroup ? (nextGroup.children[0] ? '列表' : '文本块') : null,
    customCount: custom.length,
    loading: (body.textContent || '').includes('正在读取自定义目录'),
    firstCustomName: custom.length > 0 ? (custom[0].textContent || '').trim().slice(0, 20) : null,
  };
})()`;

// 指标⑧：编辑行几何（行内编辑排，编辑态两行——首行名称输入框 + 保存/取消，次行文件夹输入框 +
// 「选择文件夹」）。只在注册表有自定义目标时可达（点「编辑」仅切本地编辑态，不落盘；量完点
// 「取消」还原）。本脚本绝不写入用户注册表。
const EDIT_ROW_JS = `(() => {
  const content = document.querySelector('[data-slot="dialog-content"]');
  if (!content) return { error: '弹层未打开' };
  const inputs = [...content.querySelectorAll('input')];
  const nameInput = inputs.find((i) => (i.getAttribute('aria-label') || '').startsWith('编辑名称 '));
  const dirInput = inputs.find((i) => (i.getAttribute('aria-label') || '').startsWith('编辑文件夹 '));
  if (!nameInput) return { error: '编辑名称输入框未出现' };
  if (!dirInput) return { error: '编辑文件夹输入框未出现' };
  const rowDiff = (input) => {
    const rowButtons = [...input.parentElement.querySelectorAll('button')];
    if (rowButtons.length === 0) return null;
    const bottoms = [input, ...rowButtons].map((el) => el.getBoundingClientRect().bottom);
    return +(Math.max(...bottoms) - Math.min(...bottoms)).toFixed(1);
  };
  const nameBottomDiff = rowDiff(nameInput);
  const dirBottomDiff = rowDiff(dirInput);
  if (nameBottomDiff === null) return { error: '名称编辑行无同排按钮' };
  if (dirBottomDiff === null) return { error: '文件夹编辑行无同排按钮' };
  const heights = [
    nameInput, ...nameInput.parentElement.querySelectorAll('button'),
    dirInput, ...dirInput.parentElement.querySelectorAll('button'),
  ].map((el) => +el.getBoundingClientRect().height.toFixed(1));
  return {
    nameBottomDiff,
    dirBottomDiff,
    heights,
    maxBottomDiff: Math.max(nameBottomDiff, dirBottomDiff),
  };
})()`;

/** 真实鼠标点击「容器内唯一文本按钮」，点前 elementFromPoint 命中断言（坑一纪律）。 */
async function clickByLocator(locatorExpr, label) {
  const pos = await cdp.evalJs(`(() => {
    const el = ${locatorExpr};
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
    const hit = document.elementFromPoint(cx, cy);
    return { x: Math.round(cx), y: Math.round(cy),
      hitSelf: hit === el || el.contains(hit) || (hit !== null && hit.contains(el)),
      hitDesc: hit ? hit.tagName + ':' + (hit.textContent || '').trim().slice(0, 10) : 'null' };
  })()`);
  if (!pos) throw new Error(`${label}: 元素未找到`);
  if (!pos.hitSelf) throw new Error(`${label}: elementFromPoint 未命中目标（可能是残留遮罩）-> ${pos.hitDesc}`);
  await cdp.clickAt(pos.x, pos.y);
  return pos;
}

const hub = (await getTargets()).find((t) => t.type === 'page' && t.url.includes('hub/dist-static'));
if (!hub) {
  console.error('未找到 Hub 窗口目标（dev 未启动或未加载 dist-static）。先运行 pnpm desktop:run-built。');
  process.exit(2);
}
const cdp = new Cdp(hub.webSocketDebuggerUrl);
await cdp.connect();
await cdp.bringToFront();
// 全局唤醒（必须先于任何真实点击）：dev 窗口被遮挡时 renderer 处于 hidden，
// ① 弹层 enter/exit 动画冻结（rect 失真、Radix 退出动画永不结束、浮层残留吞点击）；
// ② bringToFront 不足以唤醒，Emulation.setFocusEmulationEnabled 有效（2026-10-16 本机实测）。
await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
await sleep(200);

// 等 renderer 挂载完成（刚启动时 CDP target 先于 React 挂载出现，直接点击会空手）
let ready = false;
for (let i = 0; i < 40; i++) {
  if (await cdp.evalJs(`!!document.querySelector('aside')`)) { ready = true; break; }
  await sleep(300);
}
if (!ready) {
  console.error('Hub renderer 20s 内未挂载（aside 未出现）。');
  cdp.close();
  process.exit(2);
}

// 前置：若 Hub 上已有打开中的弹层（用户手动开过 / 上一轮验收遗留），先用真实鼠标关掉——
// 模态遮罩会吞掉后续对主侧栏的真实点击。关掉后再等浮层真正卸载（Radix 退出动画结束后
// 才移除节点；动画未结束的残留浮层是「点击无反应」的经典形态）。
for (let i = 0; i < 2; i++) {
  const opened = await cdp.evalJs(`!!document.querySelector('[data-slot="dialog-content"]')`);
  if (!opened) break;
  await clickByLocator(
    `document.querySelector('[data-slot="dialog-content"] [data-slot="dialog-close"]')`,
    '关闭遗留弹层（X）',
  );
  await sleep(500);
}
for (let i = 0; i < 20; i++) {
  const leftover = await cdp.evalJs(
    `!!document.querySelector('[data-slot="dialog-content"], [data-slot="dialog-overlay"]')`,
  );
  if (!leftover) break;
  await sleep(150);
}

// 确保设置页激活（主侧栏「设置」项；已在设置页则跳过）。
// 注意：侧栏按钮内部是「图标+文字」同层，无纯文本叶子，safeClick 的 leafText 定位不适用——
// 改为 aside 内按按钮全文精确匹配 + 真实鼠标点击。
const onSettings = await cdp.evalJs(`!!document.getElementById('providers') && !!document.getElementById('update')`);
if (!onSettings) {
  const pos = await cdp.evalJs(`(() => {
    const btn = [...document.querySelectorAll('aside button')]
      .filter((b) => (b.textContent || '').trim() === '设置').pop();
    if (!btn) return null;
    btn.scrollIntoView({ block: 'center' });
    const r = btn.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`);
  if (!pos) {
    console.error('主侧栏未找到「设置」按钮。');
    cdp.close();
    process.exit(2);
  }
  await cdp.clickAt(pos.x, pos.y);
  await sleep(600);
}

// 等服务商数据加载（连接列表来自 backend，冷启动有异步窗口）
let hasData = false;
for (let i = 0; i < 30; i++) {
  if (await cdp.evalJs(`document.querySelectorAll('#providers [role="button"][aria-pressed]').length > 0`)) {
    hasData = true;
    break;
  }
  await sleep(300);
}
if (!hasData) {
  console.error('服务商列表 10s 内未加载出任何条目（后端未就绪或确无数据）。');
  cdp.close();
  process.exit(2);
}

// 若无选中项则点首个服务商卡（详情空态会让指标②失真），等详情标题渲染
const needSelect = await cdp.evalJs(
  `[...document.querySelectorAll('#providers [role="button"][aria-pressed]')].filter(e => e.getAttribute('aria-pressed') === 'true').length === 0`,
);
if (needSelect) {
  const pos = await cdp.evalJs(`(() => {
    const card = document.querySelector('#providers [role="button"][aria-pressed]');
    if (!card) return null;
    card.scrollIntoView({ block: 'nearest' });
    const r = card.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`);
  if (pos) {
    await cdp.clickAt(pos.x, pos.y);
    for (let i = 0; i < 15; i++) {
      if (await cdp.evalJs(`!!document.querySelector('#providers h4')`)) break;
      await sleep(300);
    }
  }
}

const m1 = await cdp.evalJs(GAP_JS);
const m2 = await cdp.evalJs(SPLIT_JS);
const m3 = await cdp.evalJs(ROW_JS);

// ---- 指标⑤⑥⑦⑧：商店「管理自定义 Agent 目录」弹层（visual-design §8.6；2026-10-16 批次）----
// 先强制可见再量：被遮挡时 renderer 处于 hidden，enter 动画冻结在 0.95 缩放（rect 失真）；
// setWebLifecycleState 不足以唤醒，Emulation.setFocusEmulationEnabled 有效（本机实测）。
const m4Fallback = (error) => ({ error });
let m4 = m4Fallback('弹层未测（流程中断）');
let m5 = { skip: '弹层未达' };
try {
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await sleep(200);
  // 切到 Skill 商店（真实鼠标；侧栏按钮内是「图标+文字」同层，无纯文本叶子，按全文精确匹配）
  await clickByLocator(
    `[...document.querySelectorAll('aside button')].filter((b) => (b.textContent || '').trim() === 'Skill 商店').pop()`,
    'Skill 商店 tab',
  );
  await sleep(600);
  // 打开弹层（真实鼠标 + 命中断言）
  await clickByLocator(
    `[...document.querySelectorAll('button')].filter((b) => (b.textContent || '').trim() === '管理自定义 Agent 目录').pop()`,
    '管理自定义 Agent 目录按钮',
  );
  // 等弹层挂载 + enter 动画落定（transform none）+ 注册表读取完成（不再显示「正在读取自定义目录」）
  for (let i = 0; i < 30; i++) {
    m4 = await cdp.evalJs(STORE_JS);
    if (!m4.error && m4.transform === 'none' && !m4.loading) break;
    await sleep(200);
  }

  // 指标⑧：编辑行（行内编辑排）。仅注册表已有自定义目标时可达；点「编辑」只切本地编辑态
  // （不落盘），量完点「取消」还原——本脚本绝不写入用户注册表。
  if (m4.error) {
    m5 = { skip: `弹层未就绪（${m4.error}）` };
  } else if (m4.customCount === 0) {
    m5 = { skip: '注册表无自定义目标（本脚本不写用户注册表，不为此创建目标）' };
  } else {
    const editPos = await cdp.evalJs(`(() => {
      const row = [...document.querySelectorAll('[data-slot="dialog-body"] .bg-elevated')].find((r) => r.querySelector('button'));
      if (!row) return null;
      const btn = [...row.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') || '').startsWith('编辑 '));
      if (!btn) return null;
      btn.scrollIntoView({ block: 'center' });
      const r = btn.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    })()`);
    if (!editPos) {
      m5 = { skip: '编辑按钮未定位' };
    } else {
      await cdp.clickAt(editPos.x, editPos.y);
      await sleep(400);
      m5 = await cdp.evalJs(EDIT_ROW_JS);
      // 还原行编辑态：点「取消」（真实鼠标）
      const cancelPos = await cdp.evalJs(`(() => {
        const b = [...document.querySelectorAll('[data-slot="dialog-content"] button')]
          .find((x) => (x.getAttribute('aria-label') || '').startsWith('取消 '));
        if (!b) return null;
        const r = b.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      })()`);
      if (cancelPos) {
        await cdp.clickAt(cancelPos.x, cancelPos.y);
        await sleep(300);
      }
    }
  }

  // 收尾：关闭弹层并回设置页（真实鼠标），不在用户窗口留悬挂模态
  const closePos = await cdp.evalJs(`(() => {
    const b = [...document.querySelectorAll('[data-slot="dialog-footer"] button')]
      .find((x) => (x.textContent || '').trim() === '关闭');
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`);
  if (closePos) {
    await cdp.clickAt(closePos.x, closePos.y);
    await sleep(400);
  }
  await clickByLocator(
    `[...document.querySelectorAll('aside button')].filter((b) => (b.textContent || '').trim() === '设置').pop()`,
    '设置 tab（回位）',
  );
  await sleep(400);
} catch (error) {
  m4 = m4Fallback(`商店弹层流程失败：${error instanceof Error ? error.message : String(error)}`);
}
cdp.close();

const rowSkipped = typeof m3.skip === 'string';
const rowPadOk = !rowSkipped
  && parseFloat(m3.pt) >= MIN_PAD_Y && parseFloat(m3.pb) >= MIN_PAD_Y
  && parseFloat(m3.pl) >= MIN_PAD_X && parseFloat(m3.pr) >= MIN_PAD_X;

// 指标⑤⑥⑦⑧ 判定（弹层不可达时 ⑤⑥⑦ 以 error 文案报 FAIL，⑧ 记 SKIP——与 ③ 的 SKIP 惯例一致）
const storeErr = m4.error ? m4.error : null;
const storePadOk = !storeErr && m4.pad !== null
  && parseFloat(m4.pad.pt) >= MIN_PAD_Y && parseFloat(m4.pad.pb) >= MIN_PAD_Y
  && parseFloat(m4.pad.pl) >= MIN_PAD_X && parseFloat(m4.pad.pr) >= MIN_PAD_X;
const storeRowGapSkipped = !storeErr && m4.rowGap === null;
const storeRowGapOk = !storeErr && !storeRowGapSkipped && Math.abs(m4.rowGap - STORE_ROW_GAP) <= GAP_TOLERANCE;
const storeGroupGapOk = !storeErr && m4.groupGap !== null
  && Math.abs(m4.groupGap - STORE_GROUP_GAP) <= GAP_TOLERANCE;
const editSkipped = typeof m5.skip === 'string';
const editOk = !editSkipped && !m5.error && m5.maxBottomDiff <= MAX_BOTTOM_DIFF;

const checks = [
  {
    label: `标题行最长无内容横档 ${m1.gap}px @「${m1.where}」（目标 ≤${MAX_VOID_GAP}px）`,
    pass: m1.gap <= MAX_VOID_GAP,
  },
  {
    label:
      m2.error
        ? `分栏容器垫高：${m2.error}`
        : `分栏容器垫高 ${m2.excess}px（容器 ${m2.boxH}px / 列内容 ${m2.cols.join('/')}px，目标 ≤${MAX_SPLIT_PAD}px）`,
    pass: !m2.error && m2.excess <= MAX_SPLIT_PAD,
  },
  {
    // SKIP 不计失败、不计入分母：行没有行内编辑排（retired 塌缩或纯自建行）时无混排可言
    label: rowSkipped
      ? `行内同排控件底边差：SKIP（${m3.skip}）`
      : `行内同排控件底边差 ${m3.maxBottomDiff}px（目标 ≤${MAX_BOTTOM_DIFF}px，行高 ${m3.rowH}px）`,
    pass: rowSkipped || m3.maxBottomDiff <= MAX_BOTTOM_DIFF,
    skip: rowSkipped,
  },
  {
    label: rowSkipped
      ? `行承载容器呼吸档：SKIP（${m3.skip}）`
      : `行承载容器内边距 pt/pb ${m3.pt}/${m3.pb}（目标 ≥${MIN_PAD_Y}px）pl/pr ${m3.pl}/${m3.pr}（目标 ≥${MIN_PAD_X}px）`,
    pass: rowSkipped || rowPadOk,
    skip: rowSkipped,
  },
  {
    label: storeErr
      ? `商店弹层行承载内距：${storeErr}`
      : m4.pad === null
        ? '商店弹层行承载内距：未找到内置目标行'
        : `商店弹层行承载内距 pt/pb ${m4.pad.pt}/${m4.pad.pb}（目标 ≥${MIN_PAD_Y}px）pl/pr ${m4.pad.pl}/${m4.pad.pr}（目标 ≥${MIN_PAD_X}px）`,
    pass: storePadOk,
  },
  {
    label: storeErr
      ? `商店弹层行间空档：${storeErr}`
      : storeRowGapSkipped
        ? `商店弹层行间空档：SKIP（内置行不足 2 行）`
        : `商店弹层行间空档 ${m4.rowGap}px（目标 ${STORE_ROW_GAP}px±${GAP_TOLERANCE}）`,
    pass: storeRowGapSkipped || storeRowGapOk,
    skip: storeRowGapSkipped,
  },
  {
    label: storeErr
      ? `商店弹层组间空档：${storeErr}`
      : `商店弹层组间空档 ${m4.groupGap}px → 下一组（${m4.groupKind}，目标 ${STORE_GROUP_GAP}px±${GAP_TOLERANCE}）`,
    pass: storeGroupGapOk,
  },
  {
    // SKIP 不计失败、不计入分母：注册表无自定义目标时无编辑行可量（本脚本不写用户注册表）
    label: editSkipped
      ? `商店弹层行内编辑排混高：SKIP（${m5.skip}）`
      : m5.error
        ? `商店弹层行内编辑排混高：${m5.error}`
        : `商店弹层编辑行底边差 ${m5.maxBottomDiff}px（名称行 ${m5.nameBottomDiff} / 文件夹行 ${m5.dirBottomDiff}，高 ${m5.heights.join('/')}，目标 ≤${MAX_BOTTOM_DIFF}px）`,
    pass: editSkipped || editOk,
    skip: editSkipped,
  },
];

let failed = 0;
let evaluated = 0;
for (const c of checks) {
  console.log(`[${c.skip === true ? 'SKIP' : c.pass ? 'PASS' : 'FAIL'}] ${c.label}`);
  if (c.skip === true) continue;
  evaluated += 1;
  if (!c.pass) failed += 1;
}
if (failed > 0) {
  console.log(`\n设置页密度验收未通过（${failed}/${evaluated} 项不达标）。探针数据：${JSON.stringify({ m1, m2, m3, m4, m5 })}`);
  process.exit(1);
}
const skipped = checks.length - evaluated;
console.log(
  skipped === 0
    ? `\n设置页密度八指标全部通过。`
    : `\n设置页密度验收通过（实测 ${evaluated}/8 项达标，${skipped} 项 SKIP——${[...(rowSkipped ? [m3.skip] : []), ...(editSkipped ? [m5.skip] : []), ...(storeRowGapSkipped ? ['内置行不足 2 行'] : [])].join('；')}）。`,
);

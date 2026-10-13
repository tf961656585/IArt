// verify-settings-density.mjs — 设置页密度与行承载五指标真机验收（dev 运行 + CDP 9222）。
//
// 判据 owner：docs/hub/visual-design.md §8.5（密度）与 §8.6（行承载三律）；
// 登记：docs/harness/gates.md「运行时验收入口」。
// 不并入 check:preflight（需要真实窗口）；设置域布局/密度/行承载改动交付前必须运行。
// 复用 cdp-probe 的连接与真实输入纪律（先例：verify-hub-title-band.mjs）。
//
// 五指标（①②③ 2026-09-29 密度重组后标定，④⑤ 同日随行承载三律标定；
// 阈值随实现态校准，derivation 见各常量注释）：
//   ① 设置页滚动容器屏数 scrollHeight/clientHeight ≤1.55
//      （基线旧布局按实测组件高推算 ≈1.69；重组后实测 1.46。滚动无关，不依赖滚动位置）
//   ② 「标题↔同行动作」最长无内容横档 ≤240px（只量含 h1-h4 的标题行；字段行 trailing 对齐豁免，
//      基线 681px @「服务商↔刷新」，重组后 0px）
//   ③ 分栏容器人工垫高 ≤24px = 容器高 − max(左右列内容高)
//      （基线 min-h-[420px] 垫高 ~121px，重组后 ~0-18px；列背景连续性由 stretch 承担，
//      本指标只拦「用 min-h 给内容面板垫底」的回潮）
//   ④ 行内同高档：服务商详情模型行内输入框与按钮底边差 ≤1px（行内编辑排 32px 档；
//      旧态实测 2px——h-7 输入 28px 与 sm 按钮 32px 混排居中的几何必然，visual-design §8.6 律一。
//      行无行内编辑排时记 SKIP，不计失败也不计入分母）
//   ⑤ 行承载容器呼吸档：模型行容器 computed padding 垂直 ≥8px 且水平 ≥12px
//      （律二钉死 py-2/px-3；旧态实测垂直 2px（py-0.5）/ 水平 8px（px-2）贴边）
//
// 用法：pnpm desktop:run-built 起 dev 后 `pnpm verify:settings-density`。

import { getTargets, Cdp } from '../../.agents/skills/project-development-discipline/scripts/cdp-probe.mjs';

const MAX_SCREENS = 1.55; // 指标①
const MAX_VOID_GAP = 240; // 指标② px
const MAX_SPLIT_PAD = 24; // 指标③ px
const MAX_BOTTOM_DIFF = 1; // 指标④ px
const MIN_PAD_Y = 8; // 指标⑤ 垂直 px
const MIN_PAD_X = 12; // 指标⑤ 水平 px

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 指标①：设置页滚动容器屏数（容器 = 溢出滚动且包含 #update 的最近祖先）。
const SCREENS_JS = `(() => {
  const box = [...document.querySelectorAll('*')].find((e) => {
    const s = getComputedStyle(e);
    return (s.overflowY === 'auto' || s.overflowY === 'scroll') && e.querySelector('#update');
  });
  if (!box) return { error: '设置页滚动容器未找到（当前不在设置页？）' };
  return { screens: Math.round((box.scrollHeight / box.clientHeight) * 100) / 100 };
})()`;

// 指标②：标题行拉空。扫 flex/grid 且 space-between、且含 h1-h4 的行，取相邻可见子元素最大水平空档。
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

// 指标③：分栏容器人工垫高。容器 = 首个子树含「添加服务商」按钮的双子元素容器；
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

// 指标④⑤：行承载（visual-design §8.6）。行容器 = 详情里含 <input> 的 bg-elevated 行（第一个）。
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

const hub = (await getTargets()).find((t) => t.type === 'page' && t.url.includes('hub/dist-static'));
if (!hub) {
  console.error('未找到 Hub 窗口目标（dev 未启动或未加载 dist-static）。先运行 pnpm desktop:run-built。');
  process.exit(2);
}
const cdp = new Cdp(hub.webSocketDebuggerUrl);
await cdp.connect();
await cdp.bringToFront();

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

// 若无选中项则点首个服务商卡（详情空态会让指标③失真），等详情标题渲染
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

const m1 = await cdp.evalJs(SCREENS_JS);
const m2 = await cdp.evalJs(GAP_JS);
const m3 = await cdp.evalJs(SPLIT_JS);
const m4 = await cdp.evalJs(ROW_JS);
cdp.close();

const rowSkipped = typeof m4.skip === 'string';
const rowPadOk = !rowSkipped
  && parseFloat(m4.pt) >= MIN_PAD_Y && parseFloat(m4.pb) >= MIN_PAD_Y
  && parseFloat(m4.pl) >= MIN_PAD_X && parseFloat(m4.pr) >= MIN_PAD_X;

const checks = [
  {
    label: m1.error ? `设置页屏数：${m1.error}` : `设置页屏数 ${m1.screens}（目标 ≤${MAX_SCREENS}）`,
    pass: !m1.error && m1.screens <= MAX_SCREENS,
  },
  {
    label: `标题行最长无内容横档 ${m2.gap}px @「${m2.where}」（目标 ≤${MAX_VOID_GAP}px）`,
    pass: m2.gap <= MAX_VOID_GAP,
  },
  {
    label:
      m3.error
        ? `分栏容器垫高：${m3.error}`
        : `分栏容器垫高 ${m3.excess}px（容器 ${m3.boxH}px / 列内容 ${m3.cols.join('/')}px，目标 ≤${MAX_SPLIT_PAD}px）`,
    pass: !m3.error && m3.excess <= MAX_SPLIT_PAD,
  },
  {
    // SKIP 不计失败、不计入分母：行没有行内编辑排（retired 塌缩或纯自建行）时无混排可言
    label: rowSkipped
      ? `行内同排控件底边差：SKIP（${m4.skip}）`
      : `行内同排控件底边差 ${m4.maxBottomDiff}px（目标 ≤${MAX_BOTTOM_DIFF}px，行高 ${m4.rowH}px）`,
    pass: rowSkipped || m4.maxBottomDiff <= MAX_BOTTOM_DIFF,
    skip: rowSkipped,
  },
  {
    label: rowSkipped
      ? `行承载容器呼吸档：SKIP（${m4.skip}）`
      : `行承载容器内边距 pt/pb ${m4.pt}/${m4.pb}（目标 ≥${MIN_PAD_Y}px）pl/pr ${m4.pl}/${m4.pr}（目标 ≥${MIN_PAD_X}px）`,
    pass: rowSkipped || rowPadOk,
    skip: rowSkipped,
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
  console.log(`\n设置页密度验收未通过（${failed}/${evaluated} 项不达标）。探针数据：${JSON.stringify({ m1, m2, m3, m4 })}`);
  process.exit(1);
}
const skipped = checks.length - evaluated;
console.log(
  skipped === 0
    ? `\n设置页密度五指标全部通过。`
    : `\n设置页密度验收通过（实测 ${evaluated}/5 项达标，${skipped} 项 SKIP——${(m4.skip || '').trim()}）。`,
);

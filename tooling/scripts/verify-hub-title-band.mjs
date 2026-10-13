#!/usr/bin/env node
// verify-hub-title-band.mjs — Hub 顶栏带几何纪律核验（spec docs/hub/window-chrome.md §6.3/§13）。
//
// 前置：dev 正在运行且 CDP 9222 可达（desktop:dev:fast / desktop:dev:debug）。核验对象是
// 运行中的 Hub 窗口，属运行时验收入口（gates.md「运行时验收入口」），不是静态硬门禁。
//
// 对侧栏全部 7 个 tab 逐一校验四条几何纪律：
//   ① 唯一带高 token：品牌区与顶栏带 height === contracts WINDOW_CHROME_INSETS.hubTopBandHeight
//   ② 单 hairline：品牌区底线与顶栏带底线 y 差 ≤0.5px（交界处不得出现 T 形断点）
//   ③ 单一水平轴：带内 logo / 标题 / 控件中心 y 与带高一半差 ≤1px
//   ④ 拖拽连续：带内空白采样点有效区域为 drag，交互控件为 no-drag（豁免选择器与
//      HubTopBand 组件一致：button/input/select/textarea/a/[data-no-drag]）
//   附：mac 品牌区 paddingLeft === macosTrafficLightWidth；win 顶栏带 paddingRight ≥ overlay 让位。
//
// 注意：
// - 切 tab 用真实鼠标输入（Input.dispatchMouseEvent），不用 evaluate 派发合成事件；
// - 校验结束把 tab 恢复为初始 tab；
// - macOS 交通灯是 OS 绘制、不在 DOM 内，其圆心对轴核验方式见 spec §13（真机截图像素扫描），
//   本脚本不覆盖。
//
// 用法：pnpm verify:hub-title-band
import { getTargets } from '../../.agents/skills/project-development-discipline/scripts/cdp-probe.mjs';

const NAV_LABELS = ['画布', '提示词预设', '任务监控', '包管理', 'Skill 商店', '设置', '帮助'];
const WAIT_TAB_SWITCH_MS = 350;

// 页内求值表达式：返回当前 tab 的顶栏带几何事实（JSON 可序列化）。
// regionAt 的判定规则与 Chromium 可拖拽区域的绘制语义对齐：只有显式声明 app-region
// 的元素参与区域计算；命中链上先遇到的「交互豁免元素（no-drag）」或「drag 元素」决定结果；
// 固定定位浮层（如 UpdateBanner）覆盖的采样点记为 overlay，跳过不计。
const PROBE_EXPRESSION = `(() => {
  const H = window.electron && window.electron.windowChromeInsets && window.electron.windowChromeInsets.hubTopBandHeight;
  const platform = window.electron && window.electron.platform;
  const insets = window.electron && window.electron.windowChromeInsets;
  const INTERACTIVE = 'button, input, select, textarea, a, [data-no-drag]';
  const appRegion = (el) => el ? getComputedStyle(el).getPropertyValue('-webkit-app-region').trim() : 'absent';
  const brand = document.querySelector('aside') && document.querySelector('aside').firstElementChild;
  const tabRoot = document.querySelector('main') && document.querySelector('main').firstElementChild;
  const band = tabRoot && tabRoot.firstElementChild;
  if (!H || !brand || !band) {
    return { fatal: 'missing ' + JSON.stringify({ H, brand: !!brand, band: !!band }) };
  }
  const rb = brand.getBoundingClientRect();
  const bb = band.getBoundingClientRect();
  const logo = brand.querySelector('span');
  const controls = Array.from(band.querySelectorAll('button, input')).filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });
  const controlRects = controls.map((el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  const axisTargets = [...controls, ...(logo ? [logo] : []), ...band.querySelectorAll('h1')];
  const axis = axisTargets.map((el) => {
    const r = el.getBoundingClientRect();
    return { tag: el.tagName, text: (el.textContent || '').trim().slice(0, 10), cy: Number((r.y + r.height / 2).toFixed(1)) };
  });
  const axisMaxDev = axis.length ? Number(Math.max(...axis.map((a) => Math.abs(a.cy - H / 2))).toFixed(2)) : null;
  const regionAt = (x, y) => {
    let node = document.elementFromPoint(x, y);
    if (!node) return 'none';
    while (node && node !== document.body) {
      const st = getComputedStyle(node);
      const region = st.getPropertyValue('-webkit-app-region');
      if (region === 'drag') return 'drag';
      if (region === 'no-drag' && node.matches(INTERACTIVE)) return 'no-drag';
      if (st.position === 'fixed') return 'overlay';
      node = node.parentElement;
    }
    return 'none';
  };
  const samples = [];
  const sampleCount = Math.min(30, Math.floor((bb.width - 16) / 24));
  const step = (bb.width - 16) / Math.max(1, sampleCount);
  for (let i = 0; i <= sampleCount; i++) {
    const x = bb.x + 8 + i * step;
    if (controlRects.some((r) => x > r.x - 4 && x < r.x + r.w + 4)) continue;
    samples.push({ x: Math.round(x), region: regionAt(x, H / 2) });
  }
  const brandSample = regionAt(rb.x + rb.width - 10, H / 2);
  const controlRegions = controls.map((el) => {
    const r = el.getBoundingClientRect();
    return { text: (el.textContent || '').trim().slice(0, 8) || el.tagName, region: regionAt(r.x + r.width / 2, r.y + r.height / 2) };
  });
  return {
    platform,
    H,
    brand: { height: Number(rb.height.toFixed(1)), bottom: Number(rb.bottom.toFixed(1)), paddingLeft: getComputedStyle(brand).paddingLeft, paddingRight: getComputedStyle(brand).paddingRight, appRegion: appRegion(brand), sample: brandSample },
    band: { height: Number(bb.height.toFixed(1)), bottom: Number(bb.bottom.toFixed(1)), appRegion: appRegion(band), paddingRight: getComputedStyle(band).paddingRight },
    insets,
    hairlineDelta: Number(Math.abs(rb.bottom - bb.bottom).toFixed(2)),
    axisMaxDev,
    axis,
    controlRegions,
    dragSamples: samples,
  };
})()`;

const hub = (await getTargets()).find((t) => t.type === 'page' && t.url.includes('hub/dist'));
if (!hub) throw new Error('未找到 Hub 窗口（dev 未启动或 URL 不含 hub/dist）');

const ws = new WebSocket(hub.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const msgId = ++id;
    const timer = setTimeout(() => {
      pending.delete(msgId);
      reject(new Error(`CDP ${method} 30s 无响应（渲染进程繁忙或目标丢失）`));
    }, 30000);
    pending.set(msgId, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
  }
};
await new Promise((r) => (ws.onopen = r));
await send('Page.enable');
await send('Page.bringToFront');

const evalJson = async () => {
  const result = await send('Runtime.evaluate', { expression: PROBE_EXPRESSION, returnByValue: true });
  if (result.exceptionDetails) throw new Error('页内表达式抛错: ' + JSON.stringify(result.exceptionDetails));
  return result.result.value;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 真实鼠标点击侧栏导航项（先读 rect，再 Input.dispatchMouseEvent 派发真实按下/抬起）。 */
const clickNav = async (label) => {
  const rect = await send('Runtime.evaluate', {
    expression: `(() => {
      const btn = Array.from(document.querySelectorAll('aside nav button')).find(
        (b) => (b.textContent || '').trim() === ${JSON.stringify(label)},
      );
      if (!btn) return null;
      const r = btn.getBoundingClientRect();
      return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
    })()`,
    returnByValue: true,
  });
  if (!rect.result.value) throw new Error(`侧栏导航未找到: ${label}`);
  const { x, y } = JSON.parse(rect.result.value);
  for (const [type, opts] of [
    ['mousePressed', { x, y, clickCount: 1 }],
    ['mouseReleased', { x, y, clickCount: 1 }],
  ]) {
    await send('Input.dispatchMouseEvent', { type, button: 'left', ...opts });
  }
};

// 记录初始 tab 并在结束时恢复
const initialActive = await send('Runtime.evaluate', {
  expression:
    `(() => { const b = Array.from(document.querySelectorAll('aside nav button')).find((x) => x.className.includes('bg-accent')); return b ? (b.textContent || '').trim() : null; })()`,
  returnByValue: true,
});
const initialLabel = initialActive.result.value;

const failures = [];
const report = [];
for (const label of NAV_LABELS) {
  await clickNav(label);
  await sleep(WAIT_TAB_SWITCH_MS);
  const probe = await evalJson();
  const tabFailures = [];
  if (probe.fatal) {
    tabFailures.push(probe.fatal);
  } else {
    const { brand, band, H, hairlineDelta, axisMaxDev, controlRegions, dragSamples } = probe;
    if (brand.height !== H) tabFailures.push(`品牌区带高 ${brand.height} ≠ token ${H}`);
    if (band.height !== H) tabFailures.push(`顶栏带高 ${band.height} ≠ token ${H}`);
    if (hairlineDelta > 0.5) tabFailures.push(`hairline 错位 ${hairlineDelta}px（品牌区 bottom ${brand.bottom} vs 带 bottom ${band.bottom}）`);
    if (axisMaxDev === null || axisMaxDev > 1) tabFailures.push(`单轴偏差 ${axisMaxDev}px（>1px）`);
    if (brand.appRegion !== 'drag') tabFailures.push(`品牌区 appRegion=${brand.appRegion}`);
    if (band.appRegion !== 'drag') tabFailures.push(`顶栏带 appRegion=${band.appRegion}`);
    if (brand.sample !== 'drag') tabFailures.push(`品牌区尾端采样=${brand.sample}（应为 drag）`);
    for (const c of controlRegions) {
      if (c.region !== 'no-drag') tabFailures.push(`控件「${c.text}」区域=${c.region}（应为 no-drag）`);
    }
    for (const s of dragSamples) {
      if (s.region !== 'drag') tabFailures.push(`空白采样 x=${s.x} 区域=${s.region}（应为 drag）`);
    }
    if (probe.platform === 'darwin' && Math.abs(parseFloat(brand.paddingLeft) - probe.insets.macosTrafficLightWidth) > 0.5) {
      tabFailures.push(`mac 品牌区让位 paddingLeft=${brand.paddingLeft} ≠ ${probe.insets.macosTrafficLightWidth}`);
    }
    if (probe.platform === 'win32' && parseFloat(band.paddingRight) < 140) {
      tabFailures.push(`win 顶栏带右让位 paddingRight=${band.paddingRight} < overlay 预留下限 140`);
    }
  }
  report.push({ tab: label, failures: tabFailures, probe });
  if (tabFailures.length > 0) failures.push({ tab: label, tabFailures });
}

if (initialLabel) {
  await clickNav(initialLabel);
  await sleep(WAIT_TAB_SWITCH_MS);
}

// 摘要输出（probe 细节仅在失败时全量打印）
for (const r of report) {
  const tag = r.failures.length === 0 ? 'PASS' : 'FAIL';
  console.log(`[${tag}] ${r.tab}` + (r.failures.length ? '\n  - ' + r.failures.join('\n  - ') : ''));
}
if (failures.length > 0) {
  console.log('\n== 失败明细 ==');
  for (const f of failures) console.log(JSON.stringify(report.find((r) => r.tab === f.tab).probe, null, 2));
  ws.close();
  process.exit(1);
}
console.log(`\n顶栏带几何纪律全部通过（${NAV_LABELS.length} 个 tab；平台 ${report[0]?.probe.platform ?? '未知'}）。`);
// 显式关闭 CDP 连接并退出：WebSocket 不关会挂住 node 事件循环（跑完却不退出）
ws.close();
process.exit(0);

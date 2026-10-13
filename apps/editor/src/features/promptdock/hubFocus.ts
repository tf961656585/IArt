/**
 * 聚焦主窗口并定位设置页子单元（首次指引随批存量修补，docs/hub/首次指引-design.md §4.4）。
 *
 * Editor 拦截/空态文案的可点击动作经此触发：Editor renderer → main
 * （window:focus-hub-settings）→ main 显示/聚焦 Hub 主窗口并转发锚点通知 →
 * Hub renderer 切设置 tab 并滚动定位。非 Electron 环境（web/dev 变体）静默不动作。
 */

const PROVIDERS_SECTION_ID = 'providers';

/** 打开主窗口的「设置 → 服务商与模型」；返回是否成功触发（供调用方决定提示降级）。 */
export function focusHubModelProviders(): boolean {
  const api = window.electron;
  if (!api || typeof api.focusHubSettings !== 'function') return false;
  void api.focusHubSettings(PROVIDERS_SECTION_ID);
  return true;
}

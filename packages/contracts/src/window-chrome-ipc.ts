import * as z from 'zod';

/**
 * window chrome IPC channel 名集中管理。
 *
 * Hub 窗口 chrome 主题同步（Windows titleBarOverlay 配色）经此通道从 renderer 推送到 main。
 * 规范见 docs/hub/window-chrome.md §7.4。
 *
 * `hub:focus-settings`：Editor 聚焦主窗口并定位设置页子单元（首次指引随批存量修补，
 * docs/hub/首次指引-design.md §4.4）——Editor 的拦截/空态文案从纯文字升级为可点击动作。
 * 命名空间 `window:` 与 `clipboard:` / `storage:` 对称，遵循 AGENTS.md Zod 边界规范。
 */
export const WINDOW_CHROME_IPC_CHANNELS = {
  SET_TITLE_BAR_OVERLAY: 'window:set-title-bar-overlay',
  SET_NATIVE_THEME_SOURCE: 'window:set-native-theme-source',
  FOCUS_HUB_SETTINGS: 'window:focus-hub-settings',
} as const;

export type WindowChromeIpcChannel =
  (typeof WINDOW_CHROME_IPC_CHANNELS)[keyof typeof WINDOW_CHROME_IPC_CHANNELS];

// ---------------------------------------------------------------------------
// window:set-title-bar-overlay
// ---------------------------------------------------------------------------

/**
 * renderer → main，同步 Windows titleBarOverlay 配色。
 *
 * 载荷必须是 sRGB hex（#rrggbb / #rrggbbaa）：Electron 的 CSS 颜色解析器
 * （ParseCSSColor）只认 hex / rgb() / hsl() / named，oklch 会静默解析失败回落
 * 浅色白条（2026-10-16 实证）。映射自 Hub 视觉令牌 --background / --foreground
 * （见 docs/hub/window-chrome.md §7.2）；oklch 令牌经 @iart/utils 的 cssColorToHex
 * 在边界折算，禁止把 oklch 原串直接过 IPC。
 * fire-and-forget：主进程更新 overlay 后无返回值。
 */
export const SetTitleBarOverlayRequestSchema = z
  .object({
    color: z.string().regex(/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i),
    symbolColor: z.string().regex(/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i),
  })
  .strict();

export type SetTitleBarOverlayRequest = z.infer<typeof SetTitleBarOverlayRequestSchema>;

// ---------------------------------------------------------------------------
// window:set-native-theme-source
// ---------------------------------------------------------------------------

/**
 * renderer → main，把应用主题偏好直写到主进程 `nativeTheme.themeSource`。
 *
 * 原生窗口 chrome（Editor 原生标题栏、原生菜单、对话框、滚动条）只认主进程外观，
 * 不读 renderer 的主题 class / localStorage；不同步时这些表面永远跟随系统外观。
 *
 * 裁定（docs/hub/window-chrome.md §7.5）：themeSource 是 app 级单值，会反向覆盖
 * 渲染端 prefers-color-scheme 媒询，由 Hub 主题偏好唯一驱动——light/dark 直写显式值，
 * system 必须直写 'system'。把 system 解析成 light/dark 再推送会让媒询从此只能读到
 * 被写死的值，「跟随系统」自锁失效（2026-10-16 实证）。Editor 不写本开关
 * （docs/editor/window-chrome.md）。
 * fire-and-forget：主进程更新 themeSource 后无返回值。
 */
export const SetNativeThemeSourceRequestSchema = z
  .object({
    theme: z.enum(['light', 'dark', 'system']),
  })
  .strict();

export type SetNativeThemeSourceRequest = z.infer<typeof SetNativeThemeSourceRequestSchema>;

// ---------------------------------------------------------------------------
// window:focus-hub-settings
// ---------------------------------------------------------------------------

/**
 * renderer（Editor）→ main：聚焦 Hub 主窗口并定位设置页子单元。
 *
 * 载荷为设置页锚点 id（如 `providers`，即「服务商与模型 · 服务商」；全集见
 * apps/hub/src/features/settings/components/SettingsNav.tsx 的 SETTINGS_SECTION_IDS）。
 * main 侧职责：显示/还原/聚焦 Hub 主窗口，并把锚点 id 转发给 Hub renderer
 * （经 main-window 的 webContents.send，Hub 侧收到后切换到设置 tab 并滚动定位）。
 * fire-and-forget：聚焦完成后无返回值。
 */
export const FocusHubSettingsRequestSchema = z
  .object({
    sectionId: z.string().min(1),
  })
  .strict();

export type FocusHubSettingsRequest = z.infer<typeof FocusHubSettingsRequestSchema>;

/** main → Hub renderer：转发要定位的设置页锚点（与 FocusHubSettingsRequest 同形状，单向通知）。 */
export const HubFocusSettingsNoticeSchema = FocusHubSettingsRequestSchema;

export type HubFocusSettingsNotice = z.infer<typeof HubFocusSettingsNoticeSchema>;

// ---------------------------------------------------------------------------
// 窗口 chrome 几何常量（跨进程单一事实源）
// ---------------------------------------------------------------------------

/**
 * 窗口 chrome 几何常量（spec docs/hub/window-chrome.md §4.2/§4.3/§6）。
 *
 * 跨进程共享：主进程（Windows titleBarOverlay.height）与渲染层（品牌区、各 tab
 * 顶栏带 HubTopBand 的 height 内联样式）必须消费同一值，禁止两处硬编码。
 * 顶栏带几何纪律（单轴 / 单 hairline / 唯一带高 token）见 spec §6.3；
 * 运行时几何核验入口 `pnpm verify:hub-title-band`（dev 运行中执行）。
 */
export const WINDOW_CHROME_INSETS = {
  /** macOS 交通灯水平占位宽度（按钮组右缘 ~68px + 16px 原生间距），渲染层品牌区左侧让位。 */
  macosTrafficLightWidth: 84,
  /**
   * Hub 顶栏带高度（唯一带高 token）。
   * 主进程消费：Windows titleBarOverlay.height —— overlay 带必须与顶栏带同高同轴。
   * 渲染层消费：侧栏品牌区与各 tab 首行带（HubTopBand）的 height 内联样式。
   */
  hubTopBandHeight: 56,
} as const;

export type WindowChromeInsets = typeof WINDOW_CHROME_INSETS;

// ---------------------------------------------------------------------------
// Hub 初始 titleBarOverlay 配色（跨进程单一事实源）
// ---------------------------------------------------------------------------

/**
 * Hub 窗口创建期的 Windows titleBarOverlay 初始配色（spec docs/hub/window-chrome.md §5）。
 *
 * 主进程创建窗口时读不到 renderer localStorage 中的主题偏好，初始取**默认深色主题**
 * 令牌的 sRGB hex 折算值；renderer bootstrap 后经 window:set-title-bar-overlay IPC
 * 按实际主题校正（spec §7.3）。
 *
 * 值来源（Chromium 渲染像素实测折算，2026-10-16）：
 * - color ← apps/hub/src/app/globals.css `.dark --background` oklch(0.165 0.012 277) → #0d0e14
 * - symbolColor ← `.dark --foreground` oklch(0.97 0.003 277) → #f4f5f7
 * 与 CSS 令牌的一致性由 apps/hub 的令牌漂移守卫测试看护（globals.css 改值必须同步本常量）。
 */
export const HUB_INITIAL_TITLE_BAR_OVERLAY = {
  color: '#0d0e14',
  symbolColor: '#f4f5f7',
} as const;

export type HubInitialTitleBarOverlay = typeof HUB_INITIAL_TITLE_BAR_OVERLAY;

import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { cn } from '@iart/ui';

/**
 * Hub 顶栏带（spec docs/hub/window-chrome.md §6.1/§6.3）。
 *
 * 窗口顶部唯一 chrome 带：各 tab 首行必须用它渲染（侧栏品牌区为带的左段，同为
 * hubTopBandHeight 高）。组件固化四条几何纪律：
 * 1. 带高唯一 token——height 来自 preload 桥暴露的 WINDOW_CHROME_INSETS.hubTopBandHeight，
 *    与主进程 Windows titleBarOverlay.height 同源，禁止各 tab 自定带高；
 * 2. 整带拖拽——带容器 -webkit-app-region: drag，交互控件按选择器自动 no-drag 豁免
 *    （button / input / select / textarea / a / [data-no-drag]），新增交互形态须登记选择器
 *    或标 data-no-drag；
 * 3. 单 hairline——border-b 与品牌区底线同高，交界处像素级对齐（验收 ±0.5px）；
 * 4. Windows 右让位——overlay 三键与带同高（56px），右侧预留 overlay 宽度 + 最小间隙，
 *    运行时经 windowControlsOverlay.getTitlebarAreaRect() 取精确值，不硬编码。
 */
const electronApi = typeof window !== 'undefined' ? window.electron : undefined;
const osPlatform = electronApi?.platform;
const windowChromeInsets = electronApi?.windowChromeInsets;

if (windowChromeInsets === undefined) {
  throw new Error(
    'HubTopBand 需要 preload 桥暴露的 windowChromeInsets（Hub 只在 Electron 内运行；缺桥说明 preload 未注入）',
  );
}

/** Windows overlay 让位宽度（overlay 宽 + 最小间隙 14px），非 win32 恒为 0。 */
function useWindowsOverlayReserve(): number {
  const [reserve, setReserve] = useState(0);
  useEffect(() => {
    if (osPlatform !== 'win32') return;
    const overlay = 'windowControlsOverlay' in navigator
      ? (navigator as Navigator & { windowControlsOverlay?: WindowControlsOverlayLike }).windowControlsOverlay
      : undefined;
    if (!overlay) return;
    const update = (): void => {
      const rect = overlay.getTitlebarAreaRect();
      if (rect === null) return;
      // 可交互区（titlebarAreaRect）之外的横向占用即 overlay 三键宽度
      setReserve(Math.max(0, window.innerWidth - rect.x - rect.width) + 14);
    };
    update();
    overlay.addEventListener('geometrychange', update);
    return () => overlay.removeEventListener('geometrychange', update);
  }, []);
  return reserve;
}

/** windowControlsOverlay 能力的最小结构类型（TS DOM lib 未稳定覆盖时的窄化入口）。 */
interface WindowControlsOverlayLike {
  getTitlebarAreaRect(): DOMRect | null;
  addEventListener(type: 'geometrychange', listener: () => void): void;
  removeEventListener(type: 'geometrychange', listener: () => void): void;
}

const BAND_BASE_CLASS =
  'relative flex shrink-0 items-center gap-2 border-b border-border bg-background px-4 ' +
  '[-webkit-app-region:drag] ' +
  '[&_a]:[-webkit-app-region:no-drag] [&_button]:[-webkit-app-region:no-drag] ' +
  '[&_input]:[-webkit-app-region:no-drag] [&_select]:[-webkit-app-region:no-drag] ' +
  '[&_textarea]:[-webkit-app-region:no-drag] [&_[data-no-drag]]:[-webkit-app-region:no-drag]';

/** 品牌区（App 侧栏）与顶栏带共用的带高（已过 preload 桥守卫）。 */
export const HUB_TOP_BAND_HEIGHT = windowChromeInsets.hubTopBandHeight;

export function HubTopBand({ className, children }: { className?: string; children: ReactNode }) {
  const overlayReserve = useWindowsOverlayReserve();
  const style: CSSProperties = { height: HUB_TOP_BAND_HEIGHT };
  if (overlayReserve > 0) style.paddingRight = overlayReserve;
  return (
    <div className={cn(BAND_BASE_CLASS, className)} style={style}>
      {children}
    </div>
  );
}

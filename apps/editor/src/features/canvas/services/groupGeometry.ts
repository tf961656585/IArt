/**
 * 节点组几何常量与坐标契约。
 *
 * 组节点派生尺寸（derived size）与组渲染组件（GroupNode）统一从本文件引用常量与
 * position 算法，禁止各自硬编码或复现公式，避免双线口径。
 *
 * 坐标契约（spec：docs/runtime/画布节点组.md「组节点尺寸与坐标契约」）：
 * - 组 position = 成员包围盒左上角 − (leftPadding, topPadding + headerHeight)
 * - 组 size = (包围盒宽 + leftPadding + rightPadding, 包围盒高 + topPadding + bottomPadding + headerHeight)
 * - header 区域位于成员区域之上，占组节点顶部 headerHeight 高度
 */

import { computeGroupExpandedPosition as computeSharedGroupExpandedPosition } from "@iart/utils/canvas-geometry";

/**
 * 展开态 header 高度、成员区 padding、折叠态卡片最小宽度与高度。
 *
 * 数值由 @iart/utils/canvas-geometry 承载；本文件是画布侧的统一导出入口。
 */
export {
  GROUP_HEADER_HEIGHT,
  GROUP_PADDING,
  GROUP_COLLAPSED_MIN_WIDTH,
  GROUP_COLLAPSED_HEIGHT,
} from "@iart/utils/canvas-geometry";

/**
 * 根据成员节点的位置计算展开态组节点的派生 position。
 *
 * 坐标契约：position = 成员包围盒左上角 − (leftPadding, topPadding + headerHeight)。
 *
 * 算法由 @iart/utils/canvas-geometry 承载。投影层 derived selector 与
 * store 层成员位置更新（updateNodePositionsBatch）都必须调用本入口，禁止各自实现，
 * 否则两处算出的组 position 不一致会导致拖组位移错位。
 *
 * 入参保持 size 可为 null 的形态：position 语义只取成员位置，size 不参与计算。
 */
export const computeGroupExpandedPosition = (
  members: ReadonlyArray<{
    position: { x: number; y: number };
    size: { width: number; height: number } | null;
  }>,
): { x: number; y: number } | null =>
  computeSharedGroupExpandedPosition(
    members.map((member) => ({
      position: member.position,
      size: member.size ?? { width: 0, height: 0 },
    })),
  );

/**
 * 折叠态 LOD 降级阈值（屏幕空间尺寸，单位 px）——双阈值。
 *
 * 折叠卡片的屏幕空间宽或高低于对应阈值时，渲染层降级为 LOD 锚点块：
 * - 宽 < 120px
 * - 高 < 48px
 *
 * spec「折叠态 LOD 降级」（AG-CN-021）：触发维度是屏幕空间尺寸，不是画布 zoom。
 * 同一 zoom 下不同画布尺寸的卡片降级状态可能不同——这是按屏幕可见性决定渲染细节的语义。
 *
 * 旧口径是「宽或高 < 80px」单阈值，导致默认折叠卡（240×72）在 100% 缩放下恒被判降级
 * （72 < 80），折叠卡永远看不到、且整卡拖动不可用。双阈值让 240×72 在 zoom=1 时正常显示。
 */
export const GROUP_LOD_TRIGGER_SCREEN_WIDTH = 120;
export const GROUP_LOD_TRIGGER_SCREEN_HEIGHT = 48;

/**
 * LOD 锚点块屏幕固定尺寸（单位 px）。
 *
 * 降级后渲染的锚点块在屏幕上固定为 44px（Apple HIG / WCAG 2.5.5 舒适命中目标；
 * WCAG 2.5.8 的最低线是 24px），不随画布 zoom 继续缩小，保证任何 zoom 级别下折叠组
 * 都可见、可识别、可点击、可拖动。锚点居中于容器框。
 */
export const GROUP_LOD_ANCHOR_SCREEN_SIZE = 44;

/**
 * 屏幕恒定容器握把（spec AG-CN-019）尺寸常量（单位 px，屏幕空间）。
 *
 * - 触发：容器头屏幕高 < 28 或容器屏幕最短边 < 120
 * - 命中区 44px（Apple HIG / WCAG 2.5.5 舒适目标；WCAG 2.5.8 的最低线是 24px），视觉 pill 24px
 * - 宽度 max(88, min(240, 容器屏幕宽))：容器屏宽 < 88px 时保持 88px、允许略宽于容器
 */
export const CONTAINER_GRIP_TRIGGER_SCREEN_SIZE = 120;
export const CONTAINER_GRIP_HEADER_TRIGGER_SCREEN_SIZE = 28;
export const CONTAINER_GRIP_HIT_SCREEN_SIZE = 44;
export const CONTAINER_GRIP_VISUAL_SCREEN_SIZE = 24;
export const CONTAINER_GRIP_MIN_WIDTH_SCREEN_SIZE = 88;
export const CONTAINER_GRIP_MAX_WIDTH_SCREEN_SIZE = 240;

/**
 * 握把放置（SSoT）：above = 容器框上方（成员区域之外）；inside = 顶边翻转进框内首行。
 * 节点组件、握把组件与视口 hook 共用本类型。
 */
export type ContainerGripPlacement = "above" | "inside";

/**
 * 折叠态 LOD 降级判定（spec AG-CN-021）。
 *
 * 屏幕宽 < 120 或屏幕高 < 48 即降级。调用方传入屏幕空间尺寸（画布尺寸 × zoom），
 * 未收敛尺寸以 Infinity 传入时不会误判降级。
 */
export const isContainerLodDegraded = (
  screenWidth: number,
  screenHeight: number,
): boolean =>
  screenWidth < GROUP_LOD_TRIGGER_SCREEN_WIDTH ||
  screenHeight < GROUP_LOD_TRIGGER_SCREEN_HEIGHT;

/**
 * 展开态容器是否显示屏幕恒定握把（spec AG-CN-019）。
 *
 * 两个触发条件任一成立即显示：
 * - 容器头屏幕高 < 28px（标题条已读不清，需要恒定握把承接拖动与定位）
 * - 容器屏幕最短边 < 120px（容器整体过小）
 */
export const shouldShowContainerGrip = (params: {
  headerScreenHeight: number;
  screenWidth: number;
  screenHeight: number;
}): boolean =>
  params.headerScreenHeight < CONTAINER_GRIP_HEADER_TRIGGER_SCREEN_SIZE ||
  Math.min(params.screenWidth, params.screenHeight) < CONTAINER_GRIP_TRIGGER_SCREEN_SIZE;

/**
 * 单节点形态 Agent（无成员、整卡可拖）是否显示握把（spec AG-CN-019）。
 *
 * 只在卡片屏幕高 < 48px 时显示；100% 缩放下 240×64 卡片不显示，避免与卡片自身标题重复。
 */
export const shouldShowAgentLeafGrip = (screenHeight: number): boolean =>
  screenHeight < GROUP_LOD_TRIGGER_SCREEN_HEIGHT;

/**
 * LOD 锚点聚焦 zoom 反算下限。
 *
 * spec「折叠态 LOD 降级·锚点交互·聚焦脱离 LOD 不变量」（画布节点组.md）：
 * 点击 LOD 锚点定位后，目标组必须脱离 LOD 降级态，即聚焦后 zoom × 折叠卡片画布尺寸的
 * 每一维度分别 ≥ GROUP_LOD_TRIGGER_SCREEN_WIDTH / GROUP_LOD_TRIGGER_SCREEN_HEIGHT。
 * 聚焦 zoom 由 `computeLodAnchorLocateZoom` 按该不变量反算得出，本常量是反算值的下限——
 * 反算结果低于此值时取此值。
 *
 * 取值 1，与 useLocateToNode 的默认 zoom 一致：当折叠卡片画布尺寸已远大于 LOD 阈值
 * （反算值 < 1）时，聚焦 zoom 不低于定位主口径默认值，避免聚焦后视口比默认更远。
 */
export const GROUP_LOD_LOCATE_ZOOM = 1;

/**
 * 计算点击 LOD 锚点聚焦时，保证目标组脱离 LOD 降级态所需的 zoom。
 *
 * spec「折叠态 LOD 降级·锚点交互·聚焦脱离 LOD 不变量」（画布节点组.md / AG-CN-021）：
 * 聚焦后 zoom × 折叠卡片画布尺寸的每一维度必须分别 ≥ 宽/高阈值（双阈值）。本函数是该
 * 不变量的可执行表达：取两个维度各自所需 zoom 的较大值；反算值低于
 * GROUP_LOD_LOCATE_ZOOM（默认 1）时取下限。
 *
 * 调用方传入手持的折叠卡片画布尺寸（GroupNode 组件的派生 width/height props）；
 * 尺寸未收敛（初渲染 undefined）时由调用方兜底为折叠卡片常量（GROUP_COLLAPSED_MIN_WIDTH /
 * GROUP_COLLAPSED_HEIGHT），不在此函数内兜底，保持纯函数职责单一。
 *
 * 返回值直接作为 useLocateToNode 的 zoom override（LOD 锚点点击是定位主抽象的显式入口，
 * 传 zoom override 不改变居中主口径，不引入 fitView）。
 */
export const computeLodAnchorLocateZoom = (
  cardWidth: number,
  cardHeight: number,
): number => {
  if (cardWidth <= 0 || cardHeight <= 0) {
    return GROUP_LOD_LOCATE_ZOOM;
  }
  const required = Math.max(
    GROUP_LOD_TRIGGER_SCREEN_WIDTH / cardWidth,
    GROUP_LOD_TRIGGER_SCREEN_HEIGHT / cardHeight,
  );
  return Math.max(GROUP_LOD_LOCATE_ZOOM, required);
};

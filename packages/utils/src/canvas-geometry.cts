/**
 * 画布几何共享口径（跨进程单一事实源）。
 *
 * 为什么放在 @iart/utils：节点尺寸与容器渲染框原先只在画布渲染进程可用，
 * CLI 侧（Main 进程）无法复用；这两套公式一旦各写一份就是两套尺寸口径。
 * 本模块承载纯几何公式与常量，画布界面（Layout Model / 组派生尺寸）与
 * CLI 画布投影共同消费，禁止任何消费方再复现公式或硬编码常量。
 *
 * 边界：
 * - 纯函数，无 IO、无 DOM、无 Date.now / Math.random。
 * - 只承载几何公式与常量；节点数据形状、尺寸来源优先级（layoutModel > measured >
 *   default）由各进程的调用方负责解析后传入。
 * - 折叠态卡片宽度是字体测量的保守估算（8px/字符），不承诺与真实渲染逐像素一致。
 *
 * 口径来源（画布侧既有实现，本模块为其唯一实现）：
 * - 媒体展示尺寸：docs/runtime/画布启动性能与Layout-Model架构.md「媒体尺寸层」
 * - 容器派生几何：docs/runtime/画布节点组.md「组节点尺寸与坐标契约」
 * - 音频节点尺寸：docs/runtime/画布节点尺寸管理架构.md（分段全量渲染，无内部滚动）
 */

/** 画布尺寸（宽高，px）。 */
export type CanvasSize = {
  width: number;
  height: number;
};

/** 画布坐标点（任意有限数值，可负、可小数）。 */
export type CanvasPoint = {
  x: number;
  y: number;
};

/** 带位置的画布矩形（position 为左上角）。 */
export type CanvasBox = {
  position: CanvasPoint;
  size: CanvasSize;
};

/** 媒体原始宽高元信息（宽高必须为正数才可用于派生）。 */
export type CanvasMediaMeta = {
  width: number;
  height: number;
  aspectRatio?: number | null | undefined;
};

/** 容器成员几何（成员位置 + 解析后的最终尺寸）。 */
export type CanvasMemberGeometry = {
  position: CanvasPoint;
  size: CanvasSize;
};

/** 媒体展示宽度下限（px），避免极小宽图塌缩到不可读。 */
export const CANVAS_MEDIA_MIN_WIDTH = 180;

/** 媒体展示尺寸上限（px，宽高双向）。 */
export const CANVAS_MEDIA_MAX_DISPLAY_DIMENSION = 320;

/** 未知节点类型的兜底尺寸。 */
export const CANVAS_DEFAULT_NODE_SIZE: CanvasSize = { width: 240, height: 160 };

/** 资产节点在媒体比例不可得时的兜底尺寸。 */
export const CANVAS_DEFAULT_ASSET_SIZE: CanvasSize = { width: 240, height: 180 };

/** 媒体输入节点（imageInput / videoInput）在媒体比例不可得时的兜底尺寸。 */
export const CANVAS_DEFAULT_MEDIA_INPUT_SIZE: CanvasSize = { width: 240, height: 180 };

/** Agent 容器在单节点形态下的静态尺寸。 */
export const CANVAS_DEFAULT_AGENT_SIZE: CanvasSize = { width: 240, height: 64 };

/** 组节点在 Layout Model 阶段的静态占位尺寸（真实尺寸由容器派生框给出）。 */
export const CANVAS_DEFAULT_GROUP_SIZE: CanvasSize = { width: 220, height: 56 };

/** 展开态容器标题栏高度（px）。 */
export const GROUP_HEADER_HEIGHT = 32;

/** 成员区域与容器边框之间的内边距。 */
export const GROUP_PADDING = {
  top: 8,
  right: 12,
  bottom: 12,
  left: 12,
} as const;

/** 折叠态卡片最小宽度（容纳组名 + 成员数徽章 + 舒适内边距的下限）。 */
export const GROUP_COLLAPSED_MIN_WIDTH = 240;

/** 折叠态卡片高度（independent of 展开态 header 高度）。 */
export const GROUP_COLLAPSED_HEIGHT = 72;

/** 音频播放区固定高度（px）。 */
export const AUDIO_AREA_HEIGHT = 64;

/** 音频节点宽度下限（px）。 */
export const AUDIO_MIN_WIDTH = 200;

/** 音频分段列表头部行高（px）。 */
export const SEGMENT_HEADER_HEIGHT = 20;

/** 单段行高（px）。 */
export const SEGMENT_ROW_HEIGHT = 20;

/** 段间垂直间距（px）。 */
export const SEGMENT_GAP_Y = 2;

/** 分段列表距上方内容区的外边距（px）。 */
export const SEGMENT_LIST_MARGIN_TOP = 8;

/** 分段编辑按钮高度（px，含上方外边距）。 */
export const AUDIO_EDIT_BUTTON_HEIGHT = 36;

/** 内容块间垂直间距（flex gap，px）。 */
export const AUDIO_CONTENT_GAP_Y = 8;

/** audioInput 的 chrome overhead（border 1px ×2 + p-3 12px ×2）。 */
export const AUDIO_CHROME_OVERHEAD = { overheadX: 26, overheadY: 26 } as const;

/**
 * 按最大边长等比缩放，返回取整后的尺寸。
 *
 * 与画布侧既有实现同语义：先取整输入（最小 1），在限制内原样返回；
 * 超限时按较小比例缩放，宽高各自取整且不小于 1。
 */
export const computeFittedCanvasSize = (
  width: number,
  height: number,
  maxDimension: number | undefined,
): CanvasSize & { resized: boolean } => {
  const safeWidth = Math.max(Math.round(width), 1);
  const safeHeight = Math.max(Math.round(height), 1);
  const safeMax =
    Number.isFinite(maxDimension) && maxDimension !== undefined && maxDimension > 0
      ? Math.floor(maxDimension)
      : Number.POSITIVE_INFINITY;
  if (safeWidth <= safeMax && safeHeight <= safeMax) {
    return { width: safeWidth, height: safeHeight, resized: false };
  }
  const ratio = Math.min(safeMax / safeWidth, safeMax / safeHeight);
  return {
    width: Math.max(Math.round(safeWidth * ratio), 1),
    height: Math.max(Math.round(safeHeight * ratio), 1),
    resized: true,
  };
};

/**
 * 媒体展示尺寸（长边 ≤ 上限；宽度不低于下限；抬升后超高则回退 fitted）。
 *
 * 返回 null 表示 meta 不可用，调用方应回落兜底尺寸。
 */
export const computeCanvasMediaDisplaySize = (
  meta: CanvasMediaMeta | null | undefined,
  defaultAspectRatio: number,
): CanvasSize | null => {
  if (meta === null || meta === undefined) return null;
  if (!meta.width || !meta.height) return null;
  const aspect = meta.aspectRatio || meta.width / meta.height || defaultAspectRatio;
  const fitted = computeFittedCanvasSize(meta.width, meta.height, CANVAS_MEDIA_MAX_DISPLAY_DIMENSION);
  const desiredWidth = Math.max(fitted.width, CANVAS_MEDIA_MIN_WIDTH);
  const desiredHeight = desiredWidth / aspect;
  const withinBounds =
    desiredWidth <= CANVAS_MEDIA_MAX_DISPLAY_DIMENSION &&
    desiredHeight <= CANVAS_MEDIA_MAX_DISPLAY_DIMENSION;
  const finalWidth = withinBounds ? desiredWidth : fitted.width;
  const finalHeight = finalWidth / aspect;
  return { width: Math.round(finalWidth), height: Math.round(finalHeight) };
};

/**
 * 媒体类节点尺寸：给定期望比例与兜底尺寸，按展示尺寸策略派生。
 *
 * 调用方负责解析 meta（资产原始宽高优先、节点自带 meta 次之）——
 * 尺寸来源优先级属各进程的数据解析职责，不在本函数内。
 */
export const computeCanvasMediaNodeSize = (params: {
  media: CanvasMediaMeta | null | undefined;
  defaultAspectRatio: number;
  fallback: CanvasSize;
}): CanvasSize => {
  const displaySize = computeCanvasMediaDisplaySize(params.media, params.defaultAspectRatio);
  return displaySize ?? params.fallback;
};

/**
 * audioInput 节点尺寸（分段列表全量渲染，不设内部滚动）。
 *
 * 高度 = chrome + 播放区 + 分段列表（条件）+ 编辑按钮（条件）+ 条件块间 gap。
 * 连线态隐藏编辑按钮但 Layout Model 读不到边，恒含该高度（只许偏大）。
 */
export const computeCanvasAudioNodeSize = (params: {
  segmentsCount: number;
  segmentModeEnabled: boolean;
  hasAudioUrl: boolean;
  chrome?: { overheadX: number; overheadY: number };
}): CanvasSize => {
  const chrome = params.chrome ?? AUDIO_CHROME_OVERHEAD;
  const safeCount =
    Number.isFinite(params.segmentsCount) && params.segmentsCount > 0
      ? Math.round(params.segmentsCount)
      : 0;
  const segmentListHeight =
    params.segmentModeEnabled && safeCount > 0
      ? SEGMENT_LIST_MARGIN_TOP +
        SEGMENT_HEADER_HEIGHT +
        safeCount * SEGMENT_ROW_HEIGHT +
        Math.max(0, safeCount - 1) * SEGMENT_GAP_Y
      : 0;
  const editButtonHeight = params.hasAudioUrl ? AUDIO_EDIT_BUTTON_HEIGHT : 0;
  const gapCount = (segmentListHeight > 0 ? 1 : 0) + (editButtonHeight > 0 ? 1 : 0);
  return {
    width: Math.max(AUDIO_MIN_WIDTH, chrome.overheadX),
    height:
      chrome.overheadY +
      AUDIO_AREA_HEIGHT +
      segmentListHeight +
      editButtonHeight +
      gapCount * AUDIO_CONTENT_GAP_Y,
  };
};

/**
 * 展开态容器派生 position：成员包围盒左上角 − (leftPadding, topPadding + headerHeight)。
 *
 * 空成员或无有限坐标时返回 null（调用方回落既有位置）。
 */
export const computeGroupExpandedPosition = (
  members: ReadonlyArray<CanvasMemberGeometry>,
): CanvasPoint | null => {
  if (members.length === 0) return null;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  for (const member of members) {
    if (member.position.x < minX) minX = member.position.x;
    if (member.position.y < minY) minY = member.position.y;
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;
  return {
    x: minX - GROUP_PADDING.left,
    y: minY - GROUP_PADDING.top - GROUP_HEADER_HEIGHT,
  };
};

/**
 * 展开态容器派生框：position + size（成员包围盒 + padding + header）。
 *
 * 空成员返回 null；成员尺寸缺失由调用方解析后传入（本函数不做来源回退）。
 */
export const computeGroupExpandedBox = (
  members: ReadonlyArray<CanvasMemberGeometry>,
): CanvasBox | null => {
  if (members.length === 0) return null;
  const position = computeGroupExpandedPosition(members);
  if (position === null) return null;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const member of members) {
    const left = member.position.x;
    const top = member.position.y;
    const right = left + member.size.width;
    const bottom = top + member.size.height;
    if (left < minX) minX = left;
    if (top < minY) minY = top;
    if (right > maxX) maxX = right;
    if (bottom > maxY) maxY = bottom;
  }
  if (!Number.isFinite(maxX) || !Number.isFinite(maxY)) return null;
  return {
    position,
    size: {
      width: Math.max(0, maxX - minX) + GROUP_PADDING.left + GROUP_PADDING.right,
      height:
        Math.max(0, maxY - minY) + GROUP_PADDING.top + GROUP_PADDING.bottom + GROUP_HEADER_HEIGHT,
    },
  };
};

/**
 * 折叠态卡片宽度估算：max(标题文字宽度 + 徽章 + 内边距, 最小宽度)。
 *
 * 8px/字符为保守估计，空名按 3 字符兜底；真实文字宽度由渲染期 DOM 测量补偿。
 */
export const estimateGroupCollapsedWidth = (name: string): number => {
  const charCount = name.length > 0 ? name.length : 3;
  const badgeWidth = 44;
  return Math.max(GROUP_COLLAPSED_MIN_WIDTH, charCount * 8 + badgeWidth + 56);
};

/** 折叠态卡片框：position 保持折叠前位置（不因尺寸收缩跳跃）。 */
export const computeGroupCollapsedBox = (position: CanvasPoint, name: string): CanvasBox => ({
  position: { x: position.x, y: position.y },
  size: {
    width: estimateGroupCollapsedWidth(name),
    height: GROUP_COLLAPSED_HEIGHT,
  },
});

/**
 * 容器渲染框（展开态按成员派生、折叠态按卡片估算）。
 *
 * 展开态无成员或成员几何非法时回落折叠卡片形态（与画布侧空组回落一致）。
 */
export const computeGroupRenderBox = (params: {
  collapsed: boolean;
  position: CanvasPoint;
  name: string;
  members: ReadonlyArray<CanvasMemberGeometry>;
}): CanvasBox => {
  if (params.collapsed) return computeGroupCollapsedBox(params.position, params.name);
  const expanded = computeGroupExpandedBox(params.members);
  return expanded ?? computeGroupCollapsedBox(params.position, params.name);
};

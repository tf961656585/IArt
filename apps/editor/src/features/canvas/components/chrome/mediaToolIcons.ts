import {
  IconArrowsDiagonal,
  IconBorderOuter,
  IconColorFilter,
  IconContrast,
  IconCrop,
  IconFlipHorizontal,
  IconFlipVertical,
  IconLayoutGrid,
  IconPencil,
  IconPhoto,
  IconResize,
  IconRotate,
  IconScissors,
} from '@tabler/icons-react';

import type { MediaChromeTool } from './chromeModel';

/**
 * 媒体加工工具的图标表（工具栏与画布右键菜单共用同一份）。
 *
 * 工具清单与分组的事实源是 `chromeModel.ts`（`topToolGroupsFor`），图标是呈现层资产：
 * 同一工具在工具栏、右键菜单里必须是同一枚图标，因此映射只保留这一处，
 * 新增入口直接消费本表，不得各写一份（spec：docs/editor/媒体工具加工.md「入口表面」）。
 */
export const MEDIA_TOOL_ICONS: Record<MediaChromeTool['icon'], typeof IconCrop> = {
  flipH: IconFlipHorizontal,
  flipV: IconFlipVertical,
  rotate: IconRotate,
  crop: IconCrop,
  resize: IconResize,
  grid: IconLayoutGrid,
  scissors: IconScissors,
  outpaint: IconArrowsDiagonal,
  borderOuter: IconBorderOuter,
  colorFilter: IconColorFilter,
  contrast: IconContrast,
  pencil: IconPencil,
  photo: IconPhoto,
};

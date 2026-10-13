import type { AssetNodeData } from '../../types/taskNode';
import type { MediaAsset } from '@iart/contracts';
import type { BottomBarView, AssetChromeSelection } from './chromeModel';

/**
 * 资产节点选中态 chrome 类型（设计层 node-chrome：顶栏工具 + 底栏路由动作）。
 * Props 独立文件（component-scaffold 规范）。
 */

export type AssetChromeState = {
  selection: AssetChromeSelection;
  bottomView: BottomBarView;
  /** 单选资产 data（多选/空为 null） */
  singleAsset: AssetNodeData | null;
  /** 单选资产持有可访问媒体 */
  hasMedia: boolean;
  /** 单选资产对应的 MediaAsset（加工源/扩图/下载需要） */
  singleMediaAsset: MediaAsset | null;
  /** 节点拖拽进行态：chrome 隐藏（交互期渲染降级） */
  suppress: boolean;
};

export type AssetNodeChromeProps = {
  /** 画布容器 ref（chrome 双栏绝对定位锚） */
  canvasRef: React.RefObject<HTMLDivElement | null>;
};

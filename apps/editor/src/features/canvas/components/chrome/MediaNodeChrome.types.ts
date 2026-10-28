import type { BottomBarView, MediaChromeSelection } from './chromeModel';
import type { ChromeSubject } from './mediaNodeModel';

/**
 * 媒体节点选中态 chrome 类型（设计层 node-chrome：顶栏工具 + 底栏路由动作）。
 * 资产节点与素材节点共用（D27）；差异只按来源分档。
 * Props 独立文件（component-scaffold 规范）。
 */

export type MediaChromeState = {
  selection: MediaChromeSelection;
  bottomView: BottomBarView;
  /** 单选媒体主体（多选/空为 null） */
  singleSubject: ChromeSubject | null;
  /** 单选主体的资产身份可访问（顶栏与加工入口前提） */
  hasMedia: boolean;
  /** 「用作参考」可用性：按当前模型输入能力与参考位余量预判（不可用时带原因） */
  refAction: { enabled: boolean; reason: string | null };
};

export type MediaNodeChromeProps = {
  /** 画布容器 ref（chrome 双栏绝对定位锚） */
  canvasRef: React.RefObject<HTMLDivElement | null>;
};

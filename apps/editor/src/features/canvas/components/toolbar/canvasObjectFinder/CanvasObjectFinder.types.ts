'use client';

/**
 * 画布对象查找器类型定义。
 *
 * 对应设计稿 docs/editor/画布对象查找-design.md §4「交互结构」与 §5「界面用语」。
 * 下拉条目复用引擎的 FinderEntry（快照形态），组件只补视图态（筛选/高亮）类型；
 * 视图态不持久化、不进跨进程契约，归 Editor 内部类型。
 */

import type {
  FinderEntry,
  FinderKindFilter,
  FinderStatusFilter,
} from '../../../services/finderModel';

/** 类型筛选行的档位选项（§5：全部 / 组 / Agent / 任务 / 媒体）。 */
export type FinderKindOption = {
  value: FinderKindFilter;
  label: string;
};

/** 状态筛选行的档位选项（§5：全部 / 运行中 / 失败）。 */
export type FinderStatusOption = {
  value: FinderStatusFilter;
  label: string;
};

/** useCanvasObjectFinderState 的返回值（hooks 对组件的视图态投影）。 */
export type CanvasObjectFinderState = {
  /** 查找关键词（受控 input 值，随输入实时过滤） */
  keyword: string;
  setKeyword: (next: string) => void;
  /** 类型筛选档 */
  kindFilter: FinderKindFilter;
  setKindFilter: (next: FinderKindFilter) => void;
  /** 状态筛选档 */
  statusFilter: FinderStatusFilter;
  setStatusFilter: (next: FinderStatusFilter) => void;
  /** 下拉是否打开 */
  open: boolean;
  setOpen: (next: boolean) => void;
  /**
   * 键盘/悬停共用的当前高亮下标（useListNavigation 持有；候选非空时恒在
   * [0, count-1]，打开或筛选变化时归 0 = 首项最佳匹配）。
   */
  activeIndex: number;
  /** 悬停同步入口：列表项 onPointerMove 时写入当前下标（与键盘共用同一索引）。 */
  setActiveIndex: React.Dispatch<React.SetStateAction<number>>;
  /** 逐项注册元素（滚动跟随用）：列表项 ref 回调转发给 useListNavigation.setItemRef。 */
  setItemRef: (index: number, element: HTMLElement | null) => void;
  /** 排序后的当前结果列表（查询纯函数产物） */
  results: FinderEntry[];
  /** 画布可查对象总数（空态分档判定用） */
  totalCount: number;
  /** 定位到某节点（委托统一定位入口） */
  locateNode: (nodeId: string) => void;
  /** input ref，供 Cmd/Ctrl+G 聚焦 */
  inputRef: React.RefObject<HTMLInputElement | null>;
  /** 键盘事件处理（↑↓ / Enter / Esc），挂在外部 input 上 */
  handleInputKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => void;
  /** 选择某个结果项（鼠标点击路径，与 Enter 等效） */
  selectEntry: (entry: FinderEntry) => void;
};

/**
 * CanvasObjectFinder 主组件 Props。
 *
 * 当前无外部入参，使用空对象类型而非空 interface（空 interface 会触发
 * @typescript-eslint/no-empty-object-type 规则）。未来若需从工具栏注入
 * 配置（如结果列表渲染上限），在此扩展为具体字段。
 */
export type CanvasObjectFinderProps = Record<string, never>;

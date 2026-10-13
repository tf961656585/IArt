/**
 * 「整理为网格」快速选择行类型定义。
 *
 * 行内交互态是 Editor 单进程内的派生态，不跨进程传输，归 Editor 内部类型。
 * spec：docs/editor/画布对象右键菜单.md §7.3、docs/runtime/画布自动布局算法.md「网格摆放」。
 */

/** 网格单元（行、列均从 1 起计）。 */
export type ContainerTidyGridCell = {
  row: number;
  column: number;
};

/** 网格展示范围（受成员数与菜单尺寸上限约束）。 */
export type ContainerTidyGridShape = {
  /** 参与整理的成员数 */
  memberCount: number;
  /** 网格展示行数上限 */
  rows: number;
  /** 网格展示列数上限 */
  columns: number;
};

export type ContainerTidyGridPickerProps = {
  /** 参与整理的成员数，决定网格可选范围与实际行数 */
  memberCount: number;
  /**
   * 对象词（组→「本组」、Agent 容器→「本容器」），必传字面量联合（判据唯一来源
   * `resolveContainerObjectWord`）：缺省会让 Agent 容器的无障碍名静默读成「整理本组」
   * ——事实错误且编译、测试全不报红。标题、预览与格子名是容器中性文案，不随对象词变化。
   */
  objectWord: '本组' | '本容器';
  /** 选定列数后回调（行数由成员数与列数派生，不作为入参传递） */
  onSelect: (columns: number) => void;
};

/**
 * 「整理为网格」快速选择行组件桶导出。
 *
 * 仅暴露主组件与 Props 类型；hooks 与内部类型不对外暴露
 *（遵循 component-scaffold.md 的 index.ts 规则）。
 */

export { ContainerTidyGridPicker, default } from './ContainerTidyGridPicker';
export type { ContainerTidyGridPickerProps } from './ContainerTidyGridPicker.types';

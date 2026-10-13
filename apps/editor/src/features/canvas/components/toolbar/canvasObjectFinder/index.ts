/**
 * 画布对象查找器桶导出。
 *
 * 仅暴露主组件与 Props 类型；子组件、hooks、视图态类型不对外暴露
 * （遵循 component-scaffold.md 的 index.ts 规则）。
 */

export { CanvasObjectFinder, default } from './CanvasObjectFinder';
export type { CanvasObjectFinderProps } from './CanvasObjectFinder.types';

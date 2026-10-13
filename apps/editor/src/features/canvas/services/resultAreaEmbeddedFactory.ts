/**
 * 结果区内嵌数据的工厂与默认值。
 *
 * resultArea 已从独立 GraphNode 退化为 ModelNodeData.resultArea 子结构。
 * 本模块是创建 ResultAreaEmbeddedData 的单一入口，禁止各处独立构造。
 *
 * targetKeyId 用于构造 Hub 对齐 targetKey（`result-area_<targetKeyId>_<itemId>`），
 * 它不再对应任何 GraphNode，是一个冻结的稳定标识符。
 */

import { generateNodeId } from "../types/node";
import type { ResultAreaEmbeddedData } from "../types/node";

/**
 * 创建空的结果区内嵌数据。
 * targetKeyId 在创建时生成一次，后续冻结不变（迁移场景由迁移函数写入原节点 id）。
 */
export const createDefaultResultAreaEmbeddedData = (): ResultAreaEmbeddedData => ({
  slots: [],
  outputSlotIds: [],
  collapsed: false,
  targetKeyId: generateNodeId(),
});

/**
 * createResultAreaEmbeddedData 的覆盖参数。targetKeyId 必填，
 * 其余字段为联合类型允许传入 undefined（项目禁止可选属性语法 `field?: Type`）。
 */
export type CreateResultAreaEmbeddedDataParams = {
  slots: ResultAreaEmbeddedData["slots"] | undefined;
  outputSlotIds: ResultAreaEmbeddedData["outputSlotIds"] | undefined;
  collapsed: ResultAreaEmbeddedData["collapsed"] | undefined;
  targetKeyId: string;
};

/**
 * 创建结果区内嵌数据，使用指定的 targetKeyId（迁移场景用原 resultArea 节点 id）。
 * slots/outputSlotIds/collapsed 传入 undefined 时用默认值（空数组 / false）。
 */
export const createResultAreaEmbeddedData = (
  overrides: CreateResultAreaEmbeddedDataParams,
): ResultAreaEmbeddedData => ({
  slots: Array.isArray(overrides.slots) ? overrides.slots : [],
  outputSlotIds: Array.isArray(overrides.outputSlotIds) ? overrides.outputSlotIds : [],
  collapsed: typeof overrides.collapsed === "boolean" ? overrides.collapsed : false,
  targetKeyId: overrides.targetKeyId,
});

/**
 * 确保 model 节点的 data.resultArea 子结构存在且合法。
 * 缺失时创建默认值；存在但不完整时补全字段。
 */
export const ensureResultAreaEmbeddedData = (
  data: { resultArea: ResultAreaEmbeddedData | undefined } | undefined,
): ResultAreaEmbeddedData => {
  if (data !== null && data !== undefined && data.resultArea !== null && data.resultArea !== undefined) {
    const ra = data.resultArea;
    return {
      slots: Array.isArray(ra.slots) ? ra.slots : [],
      outputSlotIds: Array.isArray(ra.outputSlotIds) ? ra.outputSlotIds : [],
      collapsed: typeof ra.collapsed === "boolean" ? ra.collapsed : false,
      targetKeyId: typeof ra.targetKeyId === "string" && ra.targetKeyId.length > 0 ? ra.targetKeyId : generateNodeId(),
    };
  }
  return createDefaultResultAreaEmbeddedData();
};

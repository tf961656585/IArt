/**
 * 旧模型节点数据的统一拒绝出口（spec PromptDock生成主链.md / 产品定位与核心动作）：
 * 打开项目时遇到旧模型节点不迁移、不恢复、不静默转换，直接拒绝打开。
 *
 * 用户可见 message 只写「发生了什么 + 能做什么」；稳定错误码与节点 id 不拼进 message——
 * 错误码落在 error.code（诊断面板「复制错误详情」读取）、节点 id 与控制台日志一并留痕，
 * 排查材料不丢，但不作为用户看到的句子。
 */
export const LEGACY_MODEL_NODE_ERROR_CODE = 'legacy-model-node';

export const LEGACY_MODEL_NODE_USER_MESSAGE =
  '这个项目里有一部分内容当前版本打不开。请新建一个项目后重新生成内容。';

/**
 * 构造拒绝打开旧模型节点的错误。
 *
 * @param nodeId 触发拒绝的旧模型节点 id（只进日志与 error.nodeId，不上界面）
 * @param source 触发位置（load / repair / normalize），只进日志用于定位
 */
export const createLegacyModelNodeRejection = (
  nodeId: string,
  source: string,
): Error => {
  console.error(
    `[canvas:load] ${LEGACY_MODEL_NODE_ERROR_CODE} 拒绝打开旧模型节点 source=${source} nodeId=${nodeId}`,
  );
  const error = new Error(LEGACY_MODEL_NODE_USER_MESSAGE);
  error.name = 'LegacyModelNodeError';
  return Object.assign(error, {
    code: LEGACY_MODEL_NODE_ERROR_CODE,
    nodeId,
  });
};

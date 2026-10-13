/**
 * 节点执行前置校验问题类型（spec：docs/editor/节点执行前置校验.md）。
 *
 * 校验项集合封闭，与 spec「校验项」表一一对应：
 * - upstream-asset-unavailable：引用资产不可用（空素材节点 / 暴露资产被移除）
 * - invalid-required-parameter：必需参数缺失或非法（含 schema 层面非法值）
 * - parameter-commit-incomplete：参数提交未完成
 * - prompt-inline-reference-invalid：prompt 内联引用失效（@ 资产引用锚点或预设 token）
 * - provider-route-unavailable：节点 model_id 没有可执行的 active deployment
 *
 * 本文件只承载类型，供校验层与反馈层（store/executionStore、节点组件）共用，
 * 避免方向颠倒的依赖。
 */

export type ExecutionPreflightIssueKind =
  | 'upstream-asset-unavailable'
  | 'invalid-required-parameter'
  | 'parameter-commit-incomplete'
  | 'prompt-inline-reference-invalid'
  | 'provider-route-unavailable';

/** 引用资产不可用；媒体工具直接作用于源资产，无消费连线概念 */
export type UpstreamAssetUnavailableIssue = {
  kind: 'upstream-asset-unavailable';
  /** 问题节点（上游空素材节点或暴露资产被移除的节点） */
  nodeId: string;
  reason: 'empty-material-node' | 'result-area-output-unavailable';
  message: string;
};

/** ③ 必需参数缺失或非法（含 schema 层面非法值，如 prompt 长度超限、必需媒体缺失） */
export type InvalidRequiredParameterIssue = {
  kind: 'invalid-required-parameter';
  nodeId: string;
  fieldKey: string | undefined;
  message: string;
};

/** ④ 参数提交未完成（参数提交已失败） */
export type ParameterCommitIncompleteIssue = {
  kind: 'parameter-commit-incomplete';
  nodeId: string;
  fieldKey: string | undefined;
  message: string;
};

/** ⑤ prompt 内联引用失效（失效判定以 docs/editor/prompt内联交互.md 为唯一口径） */
export type PromptInlineReferenceInvalidIssue = {
  kind: 'prompt-inline-reference-invalid';
  /** 问题节点（本次执行的消费节点；校验以消费节点为单位） */
  nodeId: string;
  fieldKey: string | undefined;
  /** 失效 token 在该条 prompt 文本中的序号（1-based，按文本出现顺序） */
  tokenOrdinal: number;
  /** 所属 prompt 序号（多 prompt 场景 1-based；单 prompt 为 undefined） */
  promptIndex: number | undefined;
  message: string;
};

/** ⑥ active deployment / connection 不可执行。 */
export type ProviderRouteUnavailableIssue = {
  kind: 'provider-route-unavailable';
  nodeId: string;
  modelId: string;
  reason: 'missing-active-deployment' | 'deployment-mismatch' | 'connection-unavailable' | 'credential-unavailable';
  message: string;
};

/** Legacy issue shapes retained only for isolated compatibility tests. */
export type OverrideNotFoundIssue = { kind: 'override-not-found'; nodeId: string; modelId: string; currentOverrideId: string; message: string };
export type OverrideProviderUnavailableIssue = { kind: 'override-provider-unavailable'; nodeId: string; modelId: string; providerId: string; message: string };
export type OverrideKeyInvalidIssue = { kind: 'override-key-invalid'; nodeId: string; modelId: string; keyId: string; message: string };

export type ExecutionPreflightIssue =
  | UpstreamAssetUnavailableIssue
  | InvalidRequiredParameterIssue
  | ParameterCommitIncompleteIssue
  | PromptInlineReferenceInvalidIssue
  | ProviderRouteUnavailableIssue
  | OverrideNotFoundIssue
  | OverrideProviderUnavailableIssue
  | OverrideKeyInvalidIssue;

/** 稳定的空数组引用，供 store selector 缺省返回，避免每次渲染生成新引用 */
export const EMPTY_PREFLIGHT_ISSUES: ExecutionPreflightIssue[] = [];

/**
 * 已闭合 ProtocolAdapter 的模型族识别（docs/provider-remote-apis/README.md 现役 model_id 清单）。
 *
 * 通用 Provider 可执行目录只呈现已闭合能力（spec 45 §1 / spec 03 §1）；本注册表把已安装的
 * model_id 映射到其唯一协议变体适配器。不命中任何族的模型（TTS / 文本等）
 * 不进可提交目录。Seedance 2.5 单独排除（spec 45 §1：契约闭合前不可提交）。
 *
 * 本模块是族匹配的唯一事实源：可执行目录路由与诊断入口（`diagnose:model-catalog`）共用它，
 * 不得在任一侧复制正则——两份正则会随族口径演进静默漂移。声明族来自
 * `custom-generation-model-store`（经参数注入，本模块不反向依赖存储）；正则仍是唯一族常量事实源。
 */
export type ClosedFamilyAdapterId =
  | 'openai-image-v1'
  | 'gemini-image-interactions-v1'
  | 'seedance-2-0-v1'
  | 'veo-v1'
  | 'kling-v1';

export type ClosedFamilyAdapter = {
  adapterId: ClosedFamilyAdapterId;
  match: (modelId: string) => boolean;
};

export const CLOSED_FAMILY_ADAPTERS: ReadonlyArray<ClosedFamilyAdapter> = [
  { adapterId: 'openai-image-v1', match: (modelId) => /^gpt-image-/i.test(modelId) },
  { adapterId: 'gemini-image-interactions-v1', match: (modelId) => /^gemini-.*-image/i.test(modelId) && !/^gemini-.*-image-preview$/i.test(modelId) },
  { adapterId: 'seedance-2-0-v1', match: (modelId) => /^doubao-seedance-2-0/i.test(modelId) },
  { adapterId: 'veo-v1', match: (modelId) => /^veo/i.test(modelId) },
  // 可灵官方「新设计标准」（版本在 path，无 /v1 前缀；spec docs/provider-remote-apis/07-Kling-视频生成接口.md §5）。
  // 只按新标准三个视频端点的产品 model_id 精确匹配，不用 `kling` 前缀泛匹配：
  // 前缀泛匹配会把非新标准口径的同名族模型误判进来。
  { adapterId: 'kling-v1', match: (modelId) => /^kling-v3-(?:text2video|image2video|omni-video)$/i.test(modelId) },
];

export const resolveClosedFamilyAdapter = (modelId: string): ClosedFamilyAdapterId | null => {
  for (const family of CLOSED_FAMILY_ADAPTERS) {
    if (family.match(modelId)) return family.adapterId;
  }
  return null;
};

/**
 * 用户自建生成模型的「model_id → 声明族」映射（生成模型自建声明试点 §3.5）。
 *
 * 由调用方从 `custom-generation-model-store` 构建后注入，本模块不反向依赖存储——
 * 注册表保持零 IO，正则仍是唯一族常量事实源。
 */
export type DeclaredGenerationFamily = ReadonlyMap<string, ClosedFamilyAdapterId>;

/**
 * 解析 model_id 的族归属（生成模型自建声明试点 §3.5 的 resolveFamily）：
 * 正则命中优先；未命中且存在声明 → 用声明族；否则 null。
 *
 * `resolveClosedFamilyAdapter` 保持原样（纯正则单查）——它服务于「只认已装包」的
 * 既有判定（如可执行目录的闭合族筛选），本函数才承载「声明也是族来源」的两来源语义。
 */
export const resolveModelFamilyAdapter = (
  modelId: string,
  declared?: DeclaredGenerationFamily,
): ClosedFamilyAdapterId | null => {
  const regexFamily = resolveClosedFamilyAdapter(modelId);
  if (regexFamily) return regexFamily;
  const declaredFamily = declared?.get(modelId);
  return declaredFamily !== undefined ? declaredFamily : null;
};

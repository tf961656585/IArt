import type { ParameterOverrides } from '@iart/contracts';
import * as loggingModule from './logging.cts';
import { isObjectRecord } from './model-package-catalog.shared.cts';
import type { GenerationFamilyTemplateSources } from './generation-family-templates.cts';

/**
 * 默认关闭的取值（`opt_in`）在未显式启用时的收口（2026-11-06）。
 *
 * 接口格式可以声明 `opt_in: true` 的枚举取值：值本身随格式分发，但模型目录、创作面、
 * CLI 与执行表单默认不出现；只有模型记录的参数覆盖显式把该值加入 `enum_options`，
 * 它才进入合成结果。典型场景是 OpenAI 图片格式的 gif / svg：官方支持这两类形态，但服务商侧
 * 另有权限与额外约束（GIF 需账号侧预览权限、SVG 只在纯生成端点可用且不接受压缩等参数），
 * 默认可见会把不具备该能力的模型带进必然失败的提交。
 *
 * - 只裁剪枚举取值，不改取值本身：显式启用后该取值原样出现在合成结果里。
 * - 默认值若恰好是 opt-in 取值则保留（否则提交默认值时无值可选）；属于格式作者
 *   自行声明默认开启，按显式启用处理。
 * - 纯函数，原地裁剪已合成的 sources（compose 每次产出新对象，不跨调用共享）。
 */
export const applyOptInEnumDefaults = (
  sources: GenerationFamilyTemplateSources,
  overrides: ParameterOverrides,
): GenerationFamilyTemplateSources => {
  const runtimeModel = sources.runtimeModel;
  if (!isObjectRecord(runtimeModel)) return sources;
  const parameterSchema = runtimeModel.parameter_schema;
  if (!isObjectRecord(parameterSchema) || !Array.isArray(parameterSchema.fields)) return sources;
  const defaults = isObjectRecord(parameterSchema.default_values)
    ? parameterSchema.default_values
    : null;
  const explicitlyEnabledByField = new Map<string, Set<string>>();
  for (const entry of overrides.official) {
    if (entry.enum_options === undefined) continue;
    explicitlyEnabledByField.set(entry.field_key, new Set(entry.enum_options.map(String)));
  }
  for (const rawField of parameterSchema.fields) {
    if (!isObjectRecord(rawField)) continue;
    const fieldKey = typeof rawField.field_key === 'string' ? rawField.field_key : '';
    if (!fieldKey) continue;
    // 显式给了 enum_options 的字段由 applyParameterOverrides 重写成启用清单，不再按默认裁剪。
    if (explicitlyEnabledByField.has(fieldKey)) continue;
    const options = Array.isArray(rawField.enum_options) ? rawField.enum_options : null;
    if (options === null) continue;
    const defaultValue =
      rawField.default_value !== undefined
        ? rawField.default_value
        : defaults === null
          ? undefined
          : defaults[fieldKey];
    const kept = options.filter((option) => {
      if (!isObjectRecord(option)) return true;
      if (option.opt_in !== true) return true;
      if (defaultValue !== undefined && option.value === defaultValue) return true;
      loggingModule.logDebug('[generation-parameter-opt-in] opt-in option hidden by default', {
        fieldKey,
        value: option.value,
      });
      return false;
    });
    if (kept.length !== options.length) rawField.enum_options = kept;
  }
  return sources;
};

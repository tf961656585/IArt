import { normalizeString } from './shared';
import type { ValidatedPackage } from './types';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/**
 * 校验 display 区域中 variant 相关字段的结构。
 * 如果 variant_group 存在（非空字符串），则 variant_order（数值）必须存在。
 * variant_label 与 variant_default 都只作为历史兼容字段存在，不再是 grouped 主链必填。
 * 这些字段为可选，无 variant_group 的包不触发校验。
 */
export const validateVariantDisplayFields = (
  display: Record<string, unknown> | null,
): void => {
  if (display === null) return;

  const variantGroup = display['variant_group'];
  if (variantGroup === undefined || variantGroup === null || variantGroup === '') return;

  if (typeof variantGroup !== 'string') {
    throw new Error('runtime_model.display.variant_group_invalid: must be a non-empty string');
  }

  const variantOrder = display['variant_order'];
  if (typeof variantOrder !== 'number' || !Number.isFinite(variantOrder)) {
    throw new Error('runtime_model.display.variant_order_invalid: must be a finite number when variant_group is present');
  }

  const variantDefault = display['variant_default'];
  if (variantDefault !== undefined && typeof variantDefault !== 'boolean') {
    throw new Error('runtime_model.display.variant_default_invalid: must be a boolean when present');
  }
};

/**
 * 从已校验的 runtimeModel display 区域提取 variant 元数据。
 */
export const extractVariantMeta = (
  runtimeModel: unknown,
): ValidatedPackage['variantMeta'] => {
  const runtimeRecord = isRecord(runtimeModel) ? runtimeModel : null;
  if (runtimeRecord === null) return undefined;
  const display = isRecord(runtimeRecord['display']) ? runtimeRecord['display'] : null;
  if (display === null) return undefined;
  const groupKey = normalizeString(display['variant_group']);
  if (!groupKey) return undefined;
  const isDefault = display['variant_default'] === true;
  return { group_key: groupKey, is_default: isDefault };
};

/**
 * 历史兼容诊断：同 variant_group 内 variant_default=true 的分布。
 * 新 grouped 主链默认规则不再依赖该字段，因此仅在仍有多个 legacy true 时提示潜在双真相。
 */
export const validateVariantGroupDefaults = (
  packages: ValidatedPackage[],
): string[] => {
  const warnings: string[] = [];
  const groupMap = new Map<string, ValidatedPackage[]>();

  for (const pkg of packages) {
    if (pkg.variantMeta === undefined) continue;
    const existing = groupMap.get(pkg.variantMeta.group_key);
    if (existing !== undefined) {
      existing.push(pkg);
    } else {
      groupMap.set(pkg.variantMeta.group_key, [pkg]);
    }
  }

  for (const [groupKey, groupPackages] of groupMap) {
    const defaultPackages = groupPackages.filter(
      (pkg) => pkg.variantMeta !== undefined && pkg.variantMeta.is_default,
    );
    if (defaultPackages.length > 1) {
      warnings.push(
        `variant_group="${groupKey}": multiple packages have legacy variant_default=true. ` +
        `Current grouped default is derived from variant_order. Packages: ${defaultPackages.map((p) => p.packageId).join(', ')}`,
      );
    }
  }

  return warnings;
};

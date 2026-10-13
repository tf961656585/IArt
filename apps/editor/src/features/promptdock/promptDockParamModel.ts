import type { ExecutableCatalogParameterField } from '@iart/contracts';
import type { PromptDockCatalogEntry } from '@/client/api/promptDockApi';

/**
 * PromptDock 参数呈现模型（spec docs/editor/节点参数呈现分层.md）。
 *
 * 两层承载的唯一派生点：
 * - inline 层：按固定规则从参数 schema 派生高频子集（硬上限 4），排除媒体上传字段
 *   （imageUpload 由参考区承载，不在参数行重复呈现）；
 * - 完整参数面板（Sheet）：全量参数（同样排除 imageUpload 的表单呈现，但其可达性
 *   由参考区承担）。
 * 两层共用本文件的字段视图模型与 imageSize 组合，条件呈现判据天然一致。
 *
 * labels/选项文案是 Runtime Backend 下发的 `model-asset/<pkg>:<key>` i18n 键，
 * Editor 通过已注册的语言包 bundle 解析，缺失时回退到可读片段。
 */

export const INLINE_HARD_LIMIT = 4;

/** 媒体上传组件不进参数行/参数面板（参考区是唯一承载位）。小写比较。 */
const MEDIA_UPLOAD_COMPONENTS: ReadonlySet<string> = new Set(['imageupload', 'file']);

export const isMediaUploadField = (field: ExecutableCatalogParameterField): boolean =>
  MEDIA_UPLOAD_COMPONENTS.has(field.component.toLowerCase());

/** 可进参数承载层的字段（排除媒体上传）。 */
export const paramFormFields = (
  entry: PromptDockCatalogEntry | null | undefined,
): ExecutableCatalogParameterField[] =>
  (entry?.parameter_schema.fields ?? []).filter((f) => !isMediaUploadField(f));

/**
 * inline 层字段：参数表单字段按 schema 顺序取前 4 个（硬上限）。
 * 满足「inline 层必须是完整参数集合的真子集」：字段数 ≤4 时只取 n-1，
 * 至少留 1 项在完整面板（≤1 个字段时无 inline 层，只有 Sheet 承载）。
 */
export const inlineFields = (
  entry: PromptDockCatalogEntry | null | undefined,
): ExecutableCatalogParameterField[] => {
  const fields = paramFormFields(entry);
  if (fields.length <= INLINE_HARD_LIMIT) {
    return fields.slice(0, Math.max(fields.length - 1, 0));
  }
  return fields.slice(0, INLINE_HARD_LIMIT);
};

// ---------------------------------------------------------------------------
// 文案解析（i18n 键 → 可读文本）
// ---------------------------------------------------------------------------

export type ParamTranslate = (key: string | undefined, fallback: string) => string;

/** 从 `model-asset/<pkg>:fields.size.sizeLevels.1k.label` 提取末段作为回退文本。 */
export const localizationKeyTail = (key: string): string => {
  const afterNs = key.includes(':') ? key.slice(key.indexOf(':') + 1) : key;
  const segments = afterNs.split('.').filter(Boolean);
  const withoutLabelSuffix = segments.filter((s) => s !== 'label');
  return withoutLabelSuffix[withoutLabelSuffix.length - 1] ?? afterNs;
};

/** 解析 Backend 透传的 label（i18n 键或裸文本）。 */
export const resolveParamLabel = (
  translate: ParamTranslate,
  label: string | undefined,
  fallback: string,
): string => {
  const raw = (label ?? '').trim();
  if (!raw) return fallback;
  if (raw.includes(':')) return translate(raw, localizationKeyTail(raw));
  return raw;
};

// ---------------------------------------------------------------------------
// imageSize（constrainedResolution）→ 可枚举档位
// ---------------------------------------------------------------------------

export type ImageSizeChoice = {
  /** 提交值：'auto' 或 `WxH`（后端 payload_rules 直接映射 body.size） */
  value: string;
  /** 显示文案（已解析） */
  label: string;
};

type RawOption = { value?: unknown; id?: unknown; label?: unknown; ratio?: unknown; pixelBudget?: unknown };

const asRecordArray = (value: unknown): RawOption[] =>
  Array.isArray(value)
    ? value.filter((item): item is RawOption => typeof item === 'object' && item !== null)
    : [];

const asNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value)
    ? value
    : typeof value === 'string' && value.trim() && Number.isFinite(Number(value))
      ? Number(value)
      : null;

const roundToMultiple = (value: number, multiple: number): number =>
  Math.max(multiple, Math.round(value / multiple) * multiple);

/**
 * 由比例（ratio=w/h）与像素档（pixelBudget）推导 WxH：
 * W = round(sqrt(budget*ratio)) 对齐维度倍数，H = budget/W 对齐倍数。
 */
export const computeImageSize = (
  ratio: number,
  pixelBudget: number,
  dimensionMultiple: number,
): { width: number; height: number } => {
  const multiple = dimensionMultiple > 0 ? dimensionMultiple : 16;
  const width = roundToMultiple(Math.sqrt(pixelBudget * ratio), multiple);
  const height = roundToMultiple(pixelBudget / width, multiple);
  return { width, height };
};

/**
 * 把 imageSize 组件的 constrainedResolution 属性投影成扁平可枚举档位：
 * presetOptions（auto 等直接值）+ 每个比例 × 每个分辨率档的组合（WxH）。
 * props 缺失/形态不符时返回 null（调用方回退为不可呈现字段）。
 */
export const buildImageSizeChoices = (
  field: ExecutableCatalogParameterField,
  translate: ParamTranslate,
): ImageSizeChoice[] | null => {
  const props = field.componentProps as
    | {
        mode?: unknown;
        sizeLevels?: unknown;
        aspectPresets?: unknown;
        presetOptions?: unknown;
        constraints?: unknown;
      }
    | undefined;
  if (!props || props.mode !== 'constrainedResolution') return null;
  const constraints = (typeof props.constraints === 'object' && props.constraints !== null
    ? props.constraints
    : {}) as { dimensionMultiple?: unknown };
  const dimensionMultiple = asNumber(constraints.dimensionMultiple) ?? 16;
  const choices: ImageSizeChoice[] = [];
  for (const preset of asRecordArray(props.presetOptions)) {
    const value = typeof preset.value === 'string' ? preset.value.trim() : '';
    if (!value) continue;
    choices.push({
      value,
      label: resolveParamLabel(translate, typeof preset.label === 'string' ? preset.label : undefined, value),
    });
  }
  const levels = asRecordArray(props.sizeLevels);
  const aspects = asRecordArray(props.aspectPresets);
  if (levels.length === 0 || aspects.length === 0) {
    return choices.length > 0 ? choices : null;
  }
  for (const aspect of aspects) {
    const ratio = asNumber(aspect.ratio);
    const aspectId = typeof aspect.id === 'string' ? aspect.id.trim() : '';
    if (ratio === null || ratio <= 0 || !aspectId) continue;
    const aspectLabel = resolveParamLabel(
      translate,
      typeof aspect.label === 'string' ? aspect.label : undefined,
      aspectId,
    );
    for (const level of levels) {
      const pixelBudget = asNumber(level.pixelBudget);
      const levelId = typeof level.id === 'string' ? level.id.trim() : '';
      if (pixelBudget === null || pixelBudget <= 0 || !levelId) continue;
      const levelLabel = resolveParamLabel(
        translate,
        typeof level.label === 'string' ? level.label : undefined,
        levelId.toUpperCase(),
      );
      const { width, height } = computeImageSize(ratio, pixelBudget, dimensionMultiple);
      choices.push({
        value: `${width}x${height}`,
        label: `${aspectLabel} · ${levelLabel}（${width}×${height}）`,
      });
    }
  }
  return choices.length > 0 ? choices : null;
};

/** select 字段的选项解析（值 + 已解析文案）。 */
export type ParamSelectOption = { value: string; label: string };

export const buildSelectOptions = (
  field: ExecutableCatalogParameterField,
  translate: ParamTranslate,
): ParamSelectOption[] =>
  (field.enumOptions ?? []).map((option) => ({
    value: String(option.value),
    label: resolveParamLabel(
      translate,
      typeof option.label === 'string' ? option.label : undefined,
      String(option.value),
    ),
  }));

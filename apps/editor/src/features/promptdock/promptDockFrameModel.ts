import type { ExecutableCatalogParameterField } from '@iart/contracts';

import type { DynamicPayload } from '@/client/api/clientTypes';
import type { PromptDockCatalogEntry } from '@/client/api/promptDockApi';

import { computeImageSize } from './promptDockParamModel';

/**
 * PromptDock 画幅域呈现模型（原型 prototypes/shared/promptdock-frame.js 的 Editor 落地）。
 *
 * 画幅是把「比例 + 分辨率/尺寸」两轴收敛为一个 chip + popover 的组合参数控件；
 * 写回不建新参数事实源，仍落 draft.arguments 既有 param key（提交值格式不变）。
 * 形态派生只依据运行时下发的参数 schema（可执行目录契约），不按 model_id/家族硬编码：
 *
 * - constrained：单 imageSize 字段承载两轴（componentProps.mode = constrainedResolution，
 *   aspectPresets × sizeLevels，提交值扁平 string 'auto' | 'WxH'）→
 *   popover 三模式（预设档 / 比例×总像素档合成 / 自定义 W×H）；
 * - combo：ratio 族 select + size 族 select 两个独立字段 →
 *   popover 比例网格 + 档位段控，分别写回两个字段。
 *
 * 不派生形态（保持既有通用控件）：seedream 的 sizeOptions×aspectField 形态、
 * 单 ratio 或单 size 字段、text 组件的 ratio/resolution。
 * 设计红线对齐原型：auto/adaptive 不伪造精确像素（画框 = 虚线方框），
 * 视频模型不下发像素表时 foot 不展示输出像素。
 */

// ---------------------------------------------------------------------------
// 形态派生
// ---------------------------------------------------------------------------

/** ratio 轴字段 key 族（可执行目录投影 fieldKey，camelCase/snake_case 并存）。 */
const RATIO_FIELD_KEYS: ReadonlySet<string> = new Set(['aspect_ratio', 'aspectratio', 'ratio']);
/** size 轴字段 key 族。 */
const SIZE_FIELD_KEYS: ReadonlySet<string> = new Set(['image_size', 'imagesize', 'resolution', 'size']);

/** imageSize constrainedResolution 组件属性的画幅视图（已收窄校验）。 */
export type FrameConstrainedProps = {
  /** 预设档（auto 等直传值）；value 即提交值 */
  presetOptions: { value: string; label?: string }[];
  /** 自定义 W×H 模式的常见宽高预设（value = 提交值 'WxH'）；空 = 不渲染预设入口 */
  customPresets: { value: string; label?: string }[];
  /** 总像素档（K 档重锚口径：pixelBudget = 总像素预算，非长边） */
  sizeLevels: { id: string; label?: string; pixelBudget: number }[];
  /** 比例预设（ratio = w/h 数值，id 约定 'W:H'） */
  aspectPresets: { id: string; label?: string; ratio: number }[];
  constraints: {
    dimensionMultiple: number;
    maxLongEdge: number;
    minPixels: number;
    maxPixels: number;
    maxAspectRatio: number;
  };
};

export type FrameComboSpec = {
  kind: 'combo';
  ratioField: ExecutableCatalogParameterField;
  sizeField: ExecutableCatalogParameterField;
};

export type FrameConstrainedSpec = {
  kind: 'constrained';
  field: ExecutableCatalogParameterField;
  props: FrameConstrainedProps;
};

export type FrameSpec = FrameComboSpec | FrameConstrainedSpec;

// ---------------------------------------------------------------------------
// constrainedResolution 组件属性原始形态（外部边界：字段存在性与类型未验证，
// 逐字段运行时收窄后才进入 FrameConstrainedProps）
// ---------------------------------------------------------------------------

type FramePresetOptionRaw = { value?: unknown; label?: unknown };
type FrameSizeLevelRaw = { id?: unknown; label?: unknown; pixelBudget?: unknown };
type FrameAspectPresetRaw = { id?: unknown; label?: unknown; ratio?: unknown };
type FrameConstraintsRaw = {
  dimensionMultiple?: unknown;
  maxLongEdge?: unknown;
  minPixels?: unknown;
  maxPixels?: unknown;
  maxAspectRatio?: unknown;
};
type FrameComponentPropsRaw = {
  mode?: unknown;
  presetOptions?: unknown;
  customPresets?: unknown;
  sizeLevels?: unknown;
  aspectPresets?: unknown;
  constraints?: unknown;
};

const asRawArray = <T,>(value: unknown): T[] =>
  Array.isArray(value)
    ? value.filter((item): item is T => typeof item === 'object' && item !== null)
    : [];

const asString = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value.trim() : undefined);

const asNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value)
    ? value
    : typeof value === 'string' && value.trim() && Number.isFinite(Number(value))
      ? Number(value)
      : null;

/**
 * 解析 imageSize 字段的 constrainedResolution 属性为画幅两轴视图。
 * 形态不符（缺 aspectPresets/sizeLevels，如 seedream sizeOptions 形态）返回 null。
 */
export const parseFrameConstrainedProps = (
  field: ExecutableCatalogParameterField,
): FrameConstrainedProps | null => {
  const raw = field.componentProps as FrameComponentPropsRaw | undefined;
  if (!raw || raw.mode !== 'constrainedResolution') return null;

  const presetOptions: FrameConstrainedProps['presetOptions'] = [];
  for (const item of asRawArray<FramePresetOptionRaw>(raw.presetOptions)) {
    const value = asString(item.value);
    if (value === undefined) continue;
    const label = asString(item.label);
    presetOptions.push(label === undefined ? { value } : { value, label });
  }
  const customPresets: FrameConstrainedProps['customPresets'] = [];
  for (const item of asRawArray<FramePresetOptionRaw>(raw.customPresets)) {
    const value = asString(item.value);
    // 常见宽高必须是具体 'WxH' 尺寸；auto 等非尺寸值丢弃（auto 由 presetOptions 承载）
    if (value === undefined || parseDimsValue(value) === null) continue;
    const label = asString(item.label);
    customPresets.push(label === undefined ? { value } : { value, label });
  }
  const sizeLevels: FrameConstrainedProps['sizeLevels'] = [];
  for (const item of asRawArray<FrameSizeLevelRaw>(raw.sizeLevels)) {
    const id = asString(item.id);
    const pixelBudget = asNumber(item.pixelBudget);
    if (id === undefined || pixelBudget === null || pixelBudget <= 0) continue;
    const label = asString(item.label);
    sizeLevels.push(label === undefined ? { id, pixelBudget } : { id, pixelBudget, label });
  }
  const aspectPresets: FrameConstrainedProps['aspectPresets'] = [];
  for (const item of asRawArray<FrameAspectPresetRaw>(raw.aspectPresets)) {
    const id = asString(item.id);
    const ratio = asNumber(item.ratio);
    if (id === undefined || ratio === null || ratio <= 0) continue;
    const label = asString(item.label);
    aspectPresets.push(label === undefined ? { id, ratio } : { id, ratio, label });
  }

  const constraintsRaw = (typeof raw.constraints === 'object' && raw.constraints !== null
    ? raw.constraints
    : {}) as FrameConstraintsRaw;
  const dimensionMultiple = asNumber(constraintsRaw.dimensionMultiple);
  const maxLongEdge = asNumber(constraintsRaw.maxLongEdge);
  const minPixels = asNumber(constraintsRaw.minPixels);
  const maxPixels = asNumber(constraintsRaw.maxPixels);
  const maxAspectRatio = asNumber(constraintsRaw.maxAspectRatio);
  if (
    dimensionMultiple === null || dimensionMultiple <= 0 ||
    maxLongEdge === null || maxLongEdge <= 0 ||
    minPixels === null || minPixels <= 0 ||
    maxPixels === null || maxPixels < minPixels ||
    maxAspectRatio === null || maxAspectRatio <= 0
  ) {
    return null;
  }

  if (sizeLevels.length === 0 || aspectPresets.length === 0) return null;
  return {
    presetOptions,
    customPresets,
    sizeLevels,
    aspectPresets,
    constraints: {
      dimensionMultiple,
      maxLongEdge,
      minPixels,
      maxPixels,
      maxAspectRatio,
    },
  };
};

/**
 * 从可执行目录条目派生画幅形态；不构成画幅两轴时返回 null（调用方保持通用控件）。
 * constrained 优先：单字段承载两轴的模型不重复匹配 combo。
 */
export const deriveFrameSpec = (entry: PromptDockCatalogEntry | null | undefined): FrameSpec | null => {
  const fields = entry?.parameter_schema.fields ?? [];

  for (const field of fields) {
    if (field.component.toLowerCase() !== 'imagesize') continue;
    const props = parseFrameConstrainedProps(field);
    if (props !== null) return { kind: 'constrained', field, props };
  }

  const selectsWithOptions = fields.filter(
    (field) => field.component.toLowerCase() === 'select' && (field.enumOptions?.length ?? 0) > 0,
  );
  const ratioField = selectsWithOptions.find((field) => RATIO_FIELD_KEYS.has(field.fieldKey.toLowerCase()));
  const sizeField = selectsWithOptions.find((field) => SIZE_FIELD_KEYS.has(field.fieldKey.toLowerCase()));
  if (ratioField && sizeField) return { kind: 'combo', ratioField, sizeField };

  return null;
};

/** 画幅 chip 接管呈现与写回的参数 key（inline 行不再为这些 key 渲染通用控件）。 */
export const frameConsumedKeys = (spec: FrameSpec): string[] =>
  spec.kind === 'constrained'
    ? [spec.field.fieldKey]
    : [spec.ratioField.fieldKey, spec.sizeField.fieldKey];

// ---------------------------------------------------------------------------
// 比例工具（对齐原型 frameParseRatio / frameParseDims / frameRatioFraction / frameGridSortKey）
// ---------------------------------------------------------------------------

/** '16:9' -> [16, 9]；auto/adaptive 等非比例值 -> null */
export const parseRatioValue = (value: string): [number, number] | null => {
  const match = /^(\d+):(\d+)$/.exec(value);
  return match ? [Number(match[1]), Number(match[2])] : null;
};

/** '1024x1024'（提交值尺寸串）-> [1024, 1024] */
export const parseDimsValue = (value: string): [number, number] | null => {
  const match = /^(\d+)x(\d+)$/.exec(value);
  return match ? [Number(match[1]), Number(match[2])] : null;
};

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

/** 约分比例（'1360x768' 视图 -> '85:48'）；非法宽高返回 null。 */
export const ratioFraction = (w: number, h: number): string | null => {
  if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0) return null;
  return `${w / gcd(w, h)}:${h / gcd(w, h)}`;
};

/** 网格序：auto/adaptive（无 dims）最前；其后按比例极值升序、同极值横版在前。 */
export const compareFrameGridOptions = (
  a: { dims: [number, number] | null },
  b: { dims: [number, number] | null },
): number => {
  const keyOf = (dims: [number, number] | null): [number, number] => {
    if (!dims) return [-1, 0];
    const [w, h] = dims;
    return [Math.max(w / h, h / w), w >= h ? 0 : 1];
  };
  const ka = keyOf(a.dims);
  const kb = keyOf(b.dims);
  return ka[0] - kb[0] || ka[1] - kb[1];
};

// ---------------------------------------------------------------------------
// constrained：合成与官方约束校验（对应原型 gpt2Compose / checkGpt2Size）
// ---------------------------------------------------------------------------

/** 比例 × 总像素档合成 WxH（档位 = 总像素预算，对齐维度倍数）。 */
export const composeConstrainedSize = (
  props: FrameConstrainedProps,
  aspectId: string,
  levelId: string,
): { width: number; height: number } | null => {
  const aspect = props.aspectPresets.find((item) => item.id === aspectId);
  const level = props.sizeLevels.find((item) => item.id === levelId);
  if (!aspect || !level) return null;
  return computeImageSize(aspect.ratio, level.pixelBudget, props.constraints.dimensionMultiple);
};

/** 官方约束校验（16 倍数 / 比例上界 / 长边上界 / 像素区间），返回违例文案列表（空 = 合法）。 */
export const checkConstrainedDims = (
  width: number,
  height: number,
  constraints: FrameConstrainedProps['constraints'],
): string[] => {
  const errors: string[] = [];
  if (width % constraints.dimensionMultiple !== 0 || height % constraints.dimensionMultiple !== 0) {
    errors.push(`宽和高都要能被 ${constraints.dimensionMultiple} 整除`);
  }
  if (width <= 0 || height <= 0) {
    errors.push('宽和高都要大于 0');
    return errors;
  }
  const extremity = Math.max(width / height, height / width);
  if (extremity > constraints.maxAspectRatio) {
    errors.push(`比例要在 1:${constraints.maxAspectRatio} 到 ${constraints.maxAspectRatio}:1 之间`);
  }
  if (Math.max(width, height) > constraints.maxLongEdge) {
    errors.push(`最长边不能超过 ${constraints.maxLongEdge}`);
  }
  const pixels = width * height;
  if (pixels < constraints.minPixels || pixels > constraints.maxPixels) {
    errors.push(
      `总像素要在 ${constraints.minPixels.toLocaleString('en-US')}–${constraints.maxPixels.toLocaleString('en-US')} 之间`,
    );
  }
  return errors;
};

/** 约束摘要（自定义模式 foot 提示，格式对齐原型 steady hint）。 */
export const formatConstraintSummary = (constraints: FrameConstrainedProps['constraints']): string =>
  `宽和高要能被 ${constraints.dimensionMultiple} 整除，最长边不超过 ${constraints.maxLongEdge}，比例不超过 ${constraints.maxAspectRatio}:1，总像素在 ${constraints.minPixels.toLocaleString('en-US')}–${constraints.maxPixels.toLocaleString('en-US')} 之间`;

// ---------------------------------------------------------------------------
// constrained：当前提交值 -> popover 交互态反推
// ---------------------------------------------------------------------------

export type FrameConstrainedMode = 'preset' | 'ratio' | 'custom';

export type FrameConstrainedState = {
  mode: FrameConstrainedMode;
  /** mode='preset' 时的提交值（如 'auto'） */
  presetValue: string | null;
  ratioId: string | null;
  levelId: string | null;
  /** mode='custom' 的自由输入初值（提交值不可解析时为 null，输入框留空） */
  customWidth: number | null;
  customHeight: number | null;
};

/**
 * 由当前提交值反推 popover 初始交互态：
 * 命中预设档 -> preset；能精确反解为 比例×档位 合成值 -> ratio；否则 custom。
 */
export const resolveConstrainedState = (
  value: unknown,
  props: FrameConstrainedProps,
): FrameConstrainedState => {
  const raw = typeof value === 'string' ? value.trim() : '';
  const preset = props.presetOptions.find((item) => item.value === raw);
  if (preset) {
    return {
      mode: 'preset',
      presetValue: preset.value,
      ratioId: props.aspectPresets[0]?.id ?? null,
      levelId: props.sizeLevels[0]?.id ?? null,
      customWidth: null,
      customHeight: null,
    };
  }

  const dims = raw ? parseDimsValue(raw) : null;
  if (dims) {
    for (const aspect of props.aspectPresets) {
      for (const level of props.sizeLevels) {
        const composed = composeConstrainedSize(props, aspect.id, level.id);
        if (composed && composed.width === dims[0] && composed.height === dims[1]) {
          return {
            mode: 'ratio',
            presetValue: null,
            ratioId: aspect.id,
            levelId: level.id,
            customWidth: dims[0],
            customHeight: dims[1],
          };
        }
      }
    }
    return {
      mode: 'custom',
      presetValue: null,
      ratioId: props.aspectPresets[0]?.id ?? null,
      levelId: props.sizeLevels[0]?.id ?? null,
      customWidth: dims[0],
      customHeight: dims[1],
    };
  }

  return {
    mode: props.presetOptions.length > 0 ? 'preset' : 'ratio',
    presetValue: props.presetOptions[0]?.value ?? null,
    ratioId: props.aspectPresets[0]?.id ?? null,
    levelId: props.sizeLevels[0]?.id ?? null,
    customWidth: null,
    customHeight: null,
  };
};

// ---------------------------------------------------------------------------
// chip 文案
// ---------------------------------------------------------------------------

/** size 轴档位文案解析（i18n 键 -> 可读文本），由组件层注入。 */
export type FrameOptionLabelResolver = (field: ExecutableCatalogParameterField, value: string) => string;

/** 画幅 chip 当前值文案（对齐原型 frameChipText：ratio 模式显示选中比例，自定义显示约分比例）。 */
export const frameChipText = (
  spec: FrameSpec,
  args: DynamicPayload,
  resolveOptionLabel: FrameOptionLabelResolver,
): string => {
  if (spec.kind === 'constrained') {
    const rawValue = args[spec.field.fieldKey];
    const raw = typeof rawValue === 'string' ? rawValue : '';
    const state = resolveConstrainedState(raw, spec.props);
    if (state.mode === 'preset' && state.presetValue !== null) return state.presetValue;
    const dims = raw ? parseDimsValue(raw) : null;
    if (!dims) return raw;
    if (state.mode === 'ratio' && state.ratioId !== null) return `${state.ratioId} · ${dims[0]}×${dims[1]}`;
    const fraction = ratioFraction(dims[0], dims[1]);
    return fraction ? `${fraction} · ${dims[0]}×${dims[1]}` : `${dims[0]}×${dims[1]}`;
  }

  const ratioValue = args[spec.ratioField.fieldKey];
  const sizeValue = args[spec.sizeField.fieldKey];
  const ratioText = ratioValue === undefined || ratioValue === null ? '' : String(ratioValue);
  const sizeText =
    sizeValue === undefined || sizeValue === null
      ? ''
      : resolveOptionLabel(spec.sizeField, String(sizeValue));
  return `${ratioText} · ${sizeText}`;
};

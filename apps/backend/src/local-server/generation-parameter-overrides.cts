import {
  GENERATION_WIRE_NAME_PATTERN,
  cloneJsonValue,
  formatInterfaceFormatBindingTarget,
  normalizeHeaderName,
  parseInterfaceFormatRuleTarget,
  type CustomParameterField,
  type OfficialParameterOverride,
  type ParameterOverrides,
  type ParameterOverridesValue,
} from '@iart/contracts';
import type { ModelAssetLocalizationResourceMap } from '@iart/contracts/model-asset-contract';
import * as loggingModule from './logging.cts';
import { isObjectRecord } from './model-package-catalog.shared.cts';
import type { LocaleResources } from './model-package-catalog.localization.cts';
import {
  aliasHitsReservedName,
  collectReservedWireNames,
  collectWireNamesByFieldKey,
  isSameWireName,
  ownedFieldKeyOfRule,
  validateAliasName,
  wireNameConflicts,
  type FieldWireFact,
  type FieldWireLocation,
  type ReservedWireNames,
} from './generation-wire-names.cts';
import { validateParameterSchema } from './model-package-catalog.parameter-schema.cts';
import { validatePayloadRuleFieldKeysForParts } from './model-package-catalog.payload-rule-validation.cts';
import { classifyDisabledFieldTargets } from './model-package-catalog.payload-rule-references.cts';
import type { JsonObject } from './model-package-catalog.types.cts';
import type { GenerationFamilyTemplateSources } from './generation-family-templates.cts';

/**
 * 生成模型参数高级自定义：声明覆盖层 × 族模板的校验与合成（纯函数，无 IO）。
 *
 * 设计事实源：docs/custom-providers/生成模型参数高级自定义-design.md §3.3/§3.5。
 *
 * - **校验唯一实现**：`validateParameterOverrides` 是 §3.5 清单的唯一实现——保存路径
 *   （POST/PUT 路由）与投影合成路径（`applyParameterOverrides` 内置前置校验 + 终检）
 *   调用同一套函数；非法覆盖在保存时即被拒绝并给可读原因，不让必败配置进运行时。
 * - **合成顺序固定**（§3.3，顺序即语义，先减后改后增）：①禁用 ②别名 ③合法值与默认值
 *   ④新增自定义字段 ⑤终检（现有投影校验器 + 本模块覆盖校验）。
 * - **族无关**：函数只消费 `GenerationFamilyTemplateSources` 的 JSON 形状
 *   （parameter_schema.fields / default_values / runtime.payload_rules / runtime.schema_defaults），
 *   适用性判定基于组件类型（select / imageSize / 素材位上传组件），不写死任何族的字段名。
 * - **缺显示设置时读取降级**（设计 §3.5.1）：字段缺 `component_props` 时只跳过该字段这一次
 *   「张数与多选 / 档位与比例收窄」写入并写 debug 留痕，其余字段照常合成、整份投影照常返回。
 *   这是本模块唯一的 IO（条件跳过必须留痕）；生产模板的显示设置由一致性门禁钉死，降级兜的是
 *   内置模板漂移，不给用户加永远修不了的保存错误。
 * - 空覆盖快速路径：official 与 custom 都为空时原样返回入参对象（同一引用），
 *   保证「无覆盖声明与现状行为完全一致」（S8）。
 */

export type ParameterOverrideViolation = {
  code: string;
  message: string;
};

/** 自定义参数数量上限（设计 §3.4/§3.5）。 */
export const MAX_CUSTOM_PARAMETER_FIELDS = 8;

/**
 * 素材位字段的组件名（小写）：模板里承载素材输入的系统模态字段。
 *
 * 素材位**清单与启用**由记录上的 `accepted_media_slots` 管控；参数层只开放两个维度——
 * `wire_name`（服务商字段名）与 `media_max_files`（最多几张）。禁用、枚举、预设、默认值
 * 对素材位一律拒绝（启用归勾选清单，其余维度对素材输入无意义）。判定按**组件类型**而不是
 * `image` 这个字面量：素材位词表里有图片、视频、音频等多种素材位，各族模板会用不同组件名
 * 承载，只认 `image` 会把其它族的素材字段误判成可覆盖。
 */
const MEDIA_SLOT_COMPONENTS: ReadonlySet<string> = new Set([
  'imageupload',
  'videoupload',
  'audioupload',
  'file',
]);

/**
 * 某个组件名是否承载素材位（大小写不敏感）。
 *
 * 导出给族模板参数描述符的通用构建复用：素材位字段的判定必须与校验端同一份集合，
 * 不得在描述符侧另认一遍组件名。
 */
export const isMediaSlotComponentName = (component: string): boolean =>
  MEDIA_SLOT_COMPONENTS.has(component.toLowerCase());

/** 空覆盖（与契约缺省同口径）：不改变模板的任何内容。 */
export const EMPTY_PARAMETER_OVERRIDES: ParameterOverrides = { official: [], custom: [] };

/** 参数覆盖值域的运行时判定（标量三态）；导出给族模板描述符构建复用。 */
export const isScalarParameterValue = (value: unknown): value is ParameterOverridesValue =>
  typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';

const readRecord = (value: unknown): JsonObject | null => (isObjectRecord(value) ? value : null);

const readString = (value: unknown): string | null => (typeof value === 'string' ? value : null);

const readNonNegativeNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;

const readRecordOrThrow = (value: unknown, errorCode: string): JsonObject => {
  const record = readRecord(value);
  if (record === null) {
    throw new Error(errorCode);
  }
  return record;
};

/**
 * 读取字段的显示设置（`component_props`）用于写入；缺失时返回 null 并写 debug 留痕。
 *
 * 缺显示设置只影响**这一个字段**的这一次写入（素材位张数与多选 / 画幅档位与比例收窄），
 * 不得让整份模型列表投影抛错：历史实现直接抛错，一条记录踩中就让该服务商下所有模型都读不出来，
 * 且没有任何原因提示（设计 §3.5.1「读取降级」）。生产模板的显示设置由一致性门禁钉死
 * （`generation-family-template-consistency.test.ts`），这里兜的是内置模板漂移。
 */
const readComponentPropsForWrite = (
  record: JsonObject,
  context: { modelId: string | null; fieldKey: string; skippedWrite: string },
): JsonObject | null => {
  const props = readRecord(record.component_props);
  if (props === null) {
    loggingModule.logDebug('[generation-parameter-overrides] component_props missing, override write skipped', {
      modelId: context.modelId,
      fieldKey: context.fieldKey,
      component: readString(record.component) ?? '',
      skippedWrite: context.skippedWrite,
    });
  }
  return props;
};

/**
 * 按点号路径在本地化资源里取文案；取不到返回 null（调用方回退）。
 *
 * 校验错误文案用它把内部键名解析成用户能懂的中文显示名；族模板的参数描述符构建
 * 复用同一份实现（GET 描述符端点的 label 解析），不得另写第二份。
 */
export const resolveLocaleText = (resources: unknown, path: string): string | null => {
  let current: unknown = resources;
  for (const segment of path.split('.')) {
    if (!isObjectRecord(current)) return null;
    current = current[segment];
  }
  return typeof current === 'string' && current.length > 0 ? current : null;
};

// ---------------------------------------------------------------------------
// 模板事实提取（校验与合成共用的只读视图）
// ---------------------------------------------------------------------------

type ImageSizeLevelFact = { id: string; pixelBudget: number };
type AspectPresetFact = { id: string; ratio: number };

type TemplateFieldFacts = {
  fieldKey: string;
  /**
   * 参数的中文显示名：来自模板 locales 的 `fields.<key>.label`（zh-CN）；
   * 解析不可得时回退 field_key。校验错误文案用它拼句（不向用户上屏内部键名）。
   */
  displayName: string;
  /** 小写化后的组件名（'select' | 'imagesize' | 'imageupload' | ...）。 */
  component: string;
  /** 该字段是否承载素材位（组件名判定，与保留键/描述符共用同一份集合）。 */
  isMediaSlot: boolean;
  /** 素材位当前默认张数（`component_props.maxFiles`）；非素材位或未声明时为 null。 */
  maxFiles: number | null;
  enumValues: ParameterOverridesValue[];
  visibleWhenField: string | null;
  sizeLevels: ImageSizeLevelFact[];
  aspectPresets: AspectPresetFact[];
  presetOptionValues: string[];
  customPresetValues: string[];
  dimensionMultiple: number;
};

type TemplateOverrideFacts = {
  fields: TemplateFieldFacts[];
  fieldsByKey: Map<string, TemplateFieldFacts>;
  payloadRules: JsonObject | null;
  /** 按命名空间拆分的已占用线路名称（请求体 / 查询参数 / 请求头）。 */
  reservedWireNames: ReservedWireNames;
  /** 每个字段当前的发出位置与名称：判断「改成的名字是否只是它原有的名字」。 */
  wireFactByFieldKey: ReadonlyMap<string, FieldWireFact>;
};

const collectScalarValues = (options: unknown): ParameterOverridesValue[] => {
  const values: ParameterOverridesValue[] = [];
  if (!Array.isArray(options)) return values;
  for (const option of options) {
    const record = readRecord(option);
    if (record === null) continue;
    const value = record.value;
    if (isScalarParameterValue(value)) values.push(value);
  }
  return values;
};

const collectTemplateOverrideFacts = (sources: GenerationFamilyTemplateSources): TemplateOverrideFacts => {
  const runtimeModel = sources.runtimeModel;
  const parameterSchema = readRecordOrThrow(runtimeModel.parameter_schema, 'generation_parameter_overrides_template_schema_missing');
  const fields: TemplateFieldFacts[] = [];
  const fieldsByKey = new Map<string, TemplateFieldFacts>();
  const rawFields = parameterSchema.fields;
  if (!Array.isArray(rawFields)) {
    throw new Error('generation_parameter_overrides_template_fields_missing');
  }
  for (const rawField of rawFields) {
    const field = readRecord(rawField);
    if (field === null) {
      throw new Error('generation_parameter_overrides_template_field_invalid');
    }
    const fieldKey = readString(field.field_key);
    const component = readString(field.component);
    if (fieldKey === null || component === null) {
      throw new Error('generation_parameter_overrides_template_field_invalid');
    }
    const lowerComponent = component.toLowerCase();
    const props = readRecord(field.component_props);
    const sizeLevels: ImageSizeLevelFact[] = [];
    const aspectPresets: AspectPresetFact[] = [];
    const presetOptionValues: string[] = [];
    const customPresetValues: string[] = [];
    let dimensionMultiple = 16;
    if (props !== null) {
      if (Array.isArray(props.sizeLevels)) {
        for (const item of props.sizeLevels) {
          const record = readRecord(item);
          if (record === null) continue;
          const id = readString(record.id);
          const pixelBudget = readNonNegativeNumber(record.pixelBudget);
          if (id !== null && pixelBudget !== null) sizeLevels.push({ id, pixelBudget });
        }
      }
      if (Array.isArray(props.aspectPresets)) {
        for (const item of props.aspectPresets) {
          const record = readRecord(item);
          if (record === null) continue;
          const id = readString(record.id);
          const ratio = readNonNegativeNumber(record.ratio);
          if (id !== null && ratio !== null) aspectPresets.push({ id, ratio });
        }
      }
      if (Array.isArray(props.presetOptions)) {
        for (const item of props.presetOptions) {
          const record = readRecord(item);
          if (record === null) continue;
          const value = record.value;
          if (typeof value === 'string') presetOptionValues.push(value);
        }
      }
      if (Array.isArray(props.customPresets)) {
        for (const item of props.customPresets) {
          const record = readRecord(item);
          if (record === null) continue;
          const value = record.value;
          if (typeof value === 'string') customPresetValues.push(value);
        }
      }
      const constraints = readRecord(props.constraints);
      const multiple = constraints === null ? null : readNonNegativeNumber(constraints.dimensionMultiple);
      if (multiple !== null) dimensionMultiple = multiple;
    }
    const visibleWhen = readRecord(field.visible_when);
    // 显示名：模板 locales 的 zh-CN `fields.<key>.label`；解析不可得回退 field_key。
    const labelKey = readString(field.label) ?? `fields.${fieldKey}.label`;
    const displayName = resolveLocaleText(sources.localizationResources['zh-CN'], labelKey) ?? fieldKey;
    const isMediaSlot = MEDIA_SLOT_COMPONENTS.has(lowerComponent);
    const maxFiles = props === null ? null : readNonNegativeNumber(props.maxFiles);
    const facts: TemplateFieldFacts = {
      fieldKey,
      displayName,
      component: lowerComponent,
      isMediaSlot,
      maxFiles,
      enumValues: collectScalarValues(field.enum_options),
      visibleWhenField: visibleWhen === null ? null : readString(visibleWhen.field),
      sizeLevels,
      aspectPresets,
      presetOptionValues,
      customPresetValues,
      dimensionMultiple,
    };
    fields.push(facts);
    fieldsByKey.set(fieldKey, facts);
  }
  const runtime = readRecord(runtimeModel.runtime);
  const payloadRules = runtime === null ? null : readRecord(runtime.payload_rules);
  return {
    fields,
    fieldsByKey,
    payloadRules,
    reservedWireNames: collectReservedWireNames(payloadRules),
    wireFactByFieldKey: collectWireNamesByFieldKey(payloadRules),
  };
};

// ---------------------------------------------------------------------------
// 合法值集合（default_value 校验依据）
// ---------------------------------------------------------------------------

/** 与 Editor computeImageSize 同式的 WxH 推导（promptDockParamModel.ts roundToMultiple）。 */
const roundToMultiple = (value: number, multiple: number): number =>
  Math.max(multiple, Math.round(value / multiple) * multiple);

type PresetSubset = { resolutionKeys: ReadonlySet<string> | null; aspectKeys: ReadonlySet<string> | null };

/**
 * imageSize 字段在档位/比例收窄后的合法值集合：
 * presetOptions 直传值（auto 等，不受收窄影响）∪ customPresets 值 ∪ 保留档位×保留比例合成的 'WxH'。
 */
const computeImageSizeLegalValues = (facts: TemplateFieldFacts, subset: PresetSubset): Set<ParameterOverridesValue> => {
  const legal = new Set<ParameterOverridesValue>();
  for (const value of facts.presetOptionValues) legal.add(value);
  for (const value of facts.customPresetValues) legal.add(value);
  const levels = facts.sizeLevels.filter((level) => subset.resolutionKeys === null || subset.resolutionKeys.has(level.id));
  const aspects = facts.aspectPresets.filter((aspect) => subset.aspectKeys === null || subset.aspectKeys.has(aspect.id));
  for (const level of levels) {
    for (const aspect of aspects) {
      const width = roundToMultiple(Math.sqrt(level.pixelBudget * aspect.ratio), facts.dimensionMultiple);
      const height = roundToMultiple(level.pixelBudget / width, facts.dimensionMultiple);
      legal.add(`${width}x${height}`);
    }
  }
  return legal;
};

/**
 * 字段在覆盖生效后的合法值集合；返回 null 表示该组件类型不支持默认值覆盖。
 * select 类：替换后的枚举（未替换则模板枚举）；imageSize 类：收窄后的合法集。
 */
const legalValueSetFor = (facts: TemplateFieldFacts, entry: OfficialParameterOverride): Set<ParameterOverridesValue> | null => {
  if (facts.component === 'select') {
    return new Set(entry.enum_options !== undefined ? entry.enum_options : facts.enumValues);
  }
  if (facts.component === 'imagesize') {
    return computeImageSizeLegalValues(facts, {
      resolutionKeys: entry.resolution_preset_keys === undefined ? null : new Set(entry.resolution_preset_keys),
      aspectKeys: entry.aspect_preset_keys === undefined ? null : new Set(entry.aspect_preset_keys),
    });
  }
  return null;
};

// ---------------------------------------------------------------------------
// 校验（§3.5 清单，唯一实现）
// ---------------------------------------------------------------------------

/**
 * 校验声明覆盖能否安全应用到模板上（设计 §3.5）。
 *
 * 返回逐条可读原因的数组；空数组 = 可以应用。校验不修改任何输入。
 */
export const validateParameterOverrides = (
  templateSources: GenerationFamilyTemplateSources,
  overrides: ParameterOverrides,
): ParameterOverrideViolation[] => {
  const facts = collectTemplateOverrideFacts(templateSources);
  const violations: ParameterOverrideViolation[] = [];
  const aliasByFieldKey = new Map<string, FieldWireFact>();
  const disabledFieldKeys = new Set<string>();
  const seenOfficialKeys = new Set<string>();

  for (const entry of overrides.official) {
    const fieldKey = entry.field_key;
    const fieldFacts = facts.fieldsByKey.get(fieldKey);
    // 错误文案面向最终用户（Hub 弹层原样透传）：用中文显示名拼句，不解析时回退内部键名，
    // 禁止「发出键名/别名/覆盖/模板/字段」这类内部术语上屏。
    const shownName = fieldFacts?.displayName ?? fieldKey;
    if (seenOfficialKeys.has(fieldKey)) {
      violations.push({
        code: 'official_field_duplicate',
        message: `参数「${shownName}」设置了两条重复的修改，请删掉多余的一条再保存。`,
      });
      continue;
    }
    seenOfficialKeys.add(fieldKey);
    if (fieldFacts === undefined) {
      violations.push({
        code: 'official_field_unknown',
        message: `没有找到名为「${fieldKey}」的官方参数，请刷新页面后重试，或删除这条修改再保存。`,
      });
      continue;
    }
    // 素材位只开放两个维度：发送名称（服务商字段名）与最多几张。启用与否归记录上的
    // `accepted_media_slots` 勾选清单——两处都能改会造出「勾选清单说不要、覆盖里说启用」
    // 的二义。其余维度（枚举/预设/默认值）由下面的通用分支按组件类型拒绝。
    if (fieldFacts.isMediaSlot && entry.enabled === false) {
      violations.push({
        code: 'media_slot_toggle_not_allowed',
        message: `「${shownName}」是素材输入，要不要用它请在素材位清单里勾选；这里只能改发送名称和最多几张。`,
      });
      continue;
    }
    if (entry.media_max_files !== undefined) {
      if (!fieldFacts.isMediaSlot) {
        violations.push({
          code: 'media_max_files_not_allowed',
          message: `「${shownName}」不是素材输入，不能设置最多张数。`,
        });
      } else if (!Number.isInteger(entry.media_max_files) || entry.media_max_files < 1) {
        violations.push({
          code: 'media_max_files_invalid',
          message: `「${shownName}」的最多张数要填 1 或更大的整数。`,
        });
      }
    }
    if (entry.enabled === false) {
      // 禁用时其余维度无意义（合成第 1 步先整体移除），不再校验其合法性。
      disabledFieldKeys.add(fieldKey);
      continue;
    }
    if (entry.wire_name !== undefined) {
      const wire = entry.wire_name;
      // 字段当前的落点决定别名的命名空间与名称规则：别名只改这个落点内的名称，不改变落点。
      const currentFact = facts.wireFactByFieldKey.get(fieldKey) ?? null;
      const location: FieldWireLocation = currentFact?.wire_location ?? 'body';
      const aliasFact: FieldWireFact = { wire_location: location, wire_name: wire };
      const nameIssue = validateAliasName(wire, location, shownName);
      if (nameIssue !== null) {
        violations.push(nameIssue);
      } else if (currentFact !== null && isSameWireName(wire, currentFact.wire_name, location)) {
        // 「改成本来就叫这个名字」等于没改：不登记别名，也不参与重名判定。
      } else if (aliasHitsReservedName(wire, location, currentFact, facts.reservedWireNames)) {
        violations.push({
          code: 'wire_name_reserved',
          message: `发送名称「${wire}」和这个模型自带的参数重名了，请换一个名称再保存。`,
        });
      } else if (
        [...aliasByFieldKey].some(
          ([otherFieldKey, otherFact]) => otherFieldKey !== fieldKey && wireNameConflicts(aliasFact, otherFact),
        ) ||
        [...facts.wireFactByFieldKey].some(([otherFieldKey, otherFact]) => {
          if (otherFieldKey === fieldKey || aliasByFieldKey.has(otherFieldKey)) return false;
          if (disabledFieldKeys.has(otherFieldKey)) return false;
          return wireNameConflicts(aliasFact, otherFact);
        })
      ) {
        violations.push({
          code: 'wire_name_conflict',
          message: `有两个参数都用了发送名称「${wire}」，请把它们改成不同的名称。`,
        });
      } else {
        aliasByFieldKey.set(fieldKey, aliasFact);
      }
    }
    if (entry.enum_options !== undefined) {
      if (fieldFacts.component !== 'select') {
        violations.push({
          code: 'enum_options_not_allowed',
          message: `参数「${shownName}」不是下拉选择的参数，不能修改它的可选项，请去掉可选项的修改再保存。`,
        });
      } else if (entry.enum_options.length === 0) {
        violations.push({
          code: 'enum_options_empty',
          message: `参数「${shownName}」的可选项不能是空的，请至少保留一个选项。`,
        });
      }
    }
    if (entry.resolution_preset_keys !== undefined) {
      if (fieldFacts.component !== 'imagesize') {
        violations.push({
          code: 'preset_keys_not_allowed',
          message: `参数「${shownName}」不是画幅尺寸参数，不能调整它的分辨率档位，请去掉档位的修改再保存。`,
        });
      } else {
        const unknownKeys = entry.resolution_preset_keys.filter((key) => !fieldFacts.sizeLevels.some((level) => level.id === key));
        if (unknownKeys.length > 0) {
          violations.push({
            code: 'preset_key_unknown',
            message: `参数「${shownName}」没有这些分辨率档位：${unknownKeys.join('、')}。请从现有档位里选择。`,
          });
        }
      }
    }
    if (entry.aspect_preset_keys !== undefined) {
      if (fieldFacts.component !== 'imagesize') {
        violations.push({
          code: 'preset_keys_not_allowed',
          message: `参数「${shownName}」不是画幅尺寸参数，不能调整它的比例预设，请去掉比例的修改再保存。`,
        });
      } else {
        const unknownKeys = entry.aspect_preset_keys.filter((key) => !fieldFacts.aspectPresets.some((aspect) => aspect.id === key));
        if (unknownKeys.length > 0) {
          violations.push({
            code: 'preset_key_unknown',
            message: `参数「${shownName}」没有这些比例预设：${unknownKeys.join('、')}。请从现有比例里选择。`,
          });
        }
      }
    }
    if (entry.default_value !== undefined) {
      const legal = legalValueSetFor(fieldFacts, entry);
      if (legal === null) {
        violations.push({
          code: 'default_value_not_allowed',
          message: `参数「${shownName}」这种类型不支持设置默认值，请清掉默认值的修改再保存。`,
        });
      } else if (!legal.has(entry.default_value)) {
        violations.push({
          code: 'default_value_not_in_legal_set',
          message: `参数「${shownName}」的默认值不在当前可选项里，请从可选项里重新选择一个。`,
        });
      }
    }
  }

  // 禁用字段被别的字段或请求构造规则引用时拒绝（防止悬空引用与请求体静默变形）。
  // 判定口径与合成期裁剪**共用同一份实现**（model-package-catalog.payload-rule-references）：
  // 保存期放行的禁用，合成期必然能安全裁剪；反之保存期拒绝，合成期根本不会发生。
  if (disabledFieldKeys.size > 0) {
    const { blockingTargets } = classifyDisabledFieldTargets(facts.payloadRules, disabledFieldKeys);
    const referencedInBlockingTarget = new Set<string>();
    for (const fieldKeys of blockingTargets.values()) {
      for (const fieldKey of fieldKeys) referencedInBlockingTarget.add(fieldKey);
    }
    for (const key of disabledFieldKeys) {
      const disabledName = facts.fieldsByKey.get(key)?.displayName ?? key;
      if (referencedInBlockingTarget.has(key)) {
        violations.push({
          code: 'disabled_field_referenced',
          message: `参数「${disabledName}」正在参与决定生成请求怎么发送，暂时不能关闭；如需简化参数，请改为修改它的选项或默认值。`,
        });
      }
      for (const other of facts.fields) {
        if (other.fieldKey === key || disabledFieldKeys.has(other.fieldKey)) continue;
        if (other.visibleWhenField === key) {
          violations.push({
            code: 'disabled_field_referenced',
            message: `参数「${disabledName}」被参数「${other.displayName}」的显示条件用到，关闭它会让那个参数无法正常显示；请先调整对方的显示条件，或保持这个参数开启。`,
          });
        }
      }
    }
    // 全部参数都被禁用会让合成投影的参数表单为空（投影校验器拒绝空 fields）。
    const survivingCount = facts.fields.filter((field) => !disabledFieldKeys.has(field.fieldKey)).length + overrides.custom.length;
    if (survivingCount === 0) {
      violations.push({ code: 'all_fields_disabled', message: '不能关闭全部参数，请至少保留一个参数。' });
    }
  }

  // 自定义参数区。
  if (overrides.custom.length > MAX_CUSTOM_PARAMETER_FIELDS) {
    violations.push({
      code: 'custom_limit_exceeded',
      message: `自定义参数最多能添加 ${MAX_CUSTOM_PARAMETER_FIELDS} 个（当前 ${overrides.custom.length} 个），请删掉一些后再保存。`,
    });
  }
  const customWireNames = new Set<string>();
  // 官方参数覆盖生效后的最终请求体名称（禁用字段已释放其键名）。
  // **只看请求体命名空间**：新增自定义参数仍只发请求体（记录级参数覆盖不承担传输职责，
  // 查询参数 / 请求头的落点由接口格式自己的参数定义决定），因此不与那两处的名称互相占用。
  const finalOfficialBodyNames = new Set<string>();
  for (const field of facts.fields) {
    if (disabledFieldKeys.has(field.fieldKey)) continue;
    const fact = aliasByFieldKey.get(field.fieldKey) ?? facts.wireFactByFieldKey.get(field.fieldKey);
    if (fact !== undefined && fact.wire_location === 'body') finalOfficialBodyNames.add(fact.wire_name);
  }
  for (const custom of overrides.custom) {
    const wire = custom.wire_name;
    if (!GENERATION_WIRE_NAME_PATTERN.test(wire)) {
      violations.push({
        code: 'wire_name_format',
        message: `自定义参数「${custom.label}」的发送名称「${wire}」格式不对：请以小写字母开头，只用小写字母、数字和下划线。`,
      });
    } else if (facts.reservedWireNames.body.has(wire)) {
      violations.push({
        code: 'wire_name_reserved',
        message: `自定义参数的发送名称「${wire}」和这个模型自带的参数重名了，请换一个名称再保存。`,
      });
    } else if (customWireNames.has(wire)) {
      violations.push({
        code: 'wire_name_conflict',
        message: `有两个自定义参数都用了发送名称「${wire}」，请把它们改成不同的名称。`,
      });
    } else if (finalOfficialBodyNames.has(wire)) {
      violations.push({
        code: 'wire_name_conflict',
        message: `自定义参数的发送名称「${wire}」和已有参数的发送名称重复了，请换一个名称再保存。`,
      });
    } else {
      customWireNames.add(wire);
    }
    if (custom.value_type === 'enum') {
      if (custom.enum_options === undefined || custom.enum_options.length === 0) {
        violations.push({
          code: 'custom_enum_options_required',
          message: `自定义参数「${custom.label}」选择了选项类型，请至少填写一个可选项。`,
        });
      } else if (custom.default_value !== undefined && !custom.enum_options.includes(custom.default_value)) {
        violations.push({
          code: 'default_value_not_in_legal_set',
          message: `自定义参数「${custom.label}」的默认值不在它的可选项里，请从可选项里重新选择一个。`,
        });
      }
    } else if (custom.enum_options !== undefined) {
      violations.push({
        code: 'custom_enum_options_not_allowed',
        message: `自定义参数「${custom.label}」不是选项类型，请清掉可选项列表，或把类型改为选项。`,
      });
    }
  }
  return violations;
};

// ---------------------------------------------------------------------------
// 合成（§3.3 固定顺序）
// ---------------------------------------------------------------------------

const componentForValueType = (valueType: CustomParameterField['value_type']): string => {
  if (valueType === 'enum') return 'select';
  if (valueType === 'boolean') return 'switch';
  if (valueType === 'number') return 'number';
  return 'text';
};

const isRecordComponent = (record: JsonObject, component: string): boolean => {
  const value = readString(record.component);
  return value !== null && value.toLowerCase() === component;
};

/**
 * 把自定义参数显示名按「用户文本即译文」注册进一个语言域的资源表，返回该语言域资源。
 *
 * 语言域资源缺 `fields` 容器时补建；语言域资源本身不是对象时抛错（模板畸形，fail-loud，
 * 不静默丢语言域）。返回类型是契约的宽松资源表（Record<string, unknown>），由调用方按
 * LocaleResources 形状逐语言域组装。
 */
const registerCustomLabelEntries = (
  resource: unknown,
  entries: ReadonlyArray<{ wire: string; label: string }>,
): ModelAssetLocalizationResourceMap => {
  const resourceRecord = readRecord(resource);
  if (resourceRecord === null) {
    throw new Error('generation_parameter_overrides_localization_resources_invalid');
  }
  const fieldsContainer = readRecord(resourceRecord.fields) ?? {};
  for (const entry of entries) {
    fieldsContainer[entry.wire] = { label: entry.label };
  }
  resourceRecord.fields = fieldsContainer;
  return resourceRecord;
};

/**
 * 判断克隆后的本地化资源是否具备 LocaleResources 的两个语言域键。
 *
 * 收窄优于放宽：守卫通过后 `en` 走点访问（LocaleResources 已声明该固定字段）；`zh-CN`
 * 含连字符不是合法标识符键，只能括号访问（stable 守卫只拦标识符形状的字符串字面量键）。
 * 语言域「值」的形状由 registerCustomLabelEntries 逐域校验（非对象即抛错），两层合起来
 * 对 LocaleResources 的运行时形状是完备的。
 */
const isLocaleResourcesShaped = (value: unknown): value is LocaleResources =>
  isObjectRecord(value) && 'zh-CN' in value && 'en' in value;

/**
 * 把声明覆盖按固定顺序应用到模板 sources 上，返回合成后的新 sources（输入不被修改）。
 *
 * 空覆盖原样返回入参（同一引用，S8 在役回归的硬保证）；非法覆盖抛错——保存路径已用
 * `validateParameterOverrides` 拒绝，这里的抛错属防御纵深（理论不可达，红即 bug）。
 */
export const applyParameterOverrides = (
  templateSources: GenerationFamilyTemplateSources,
  overrides: ParameterOverrides,
): GenerationFamilyTemplateSources => {
  if (overrides.official.length === 0 && overrides.custom.length === 0) {
    return templateSources;
  }
  const violations = validateParameterOverrides(templateSources, overrides);
  if (violations.length > 0) {
    throw new Error(`parameter_overrides_invalid: ${violations.map((violation) => violation.message).join('; ')}`);
  }

  const runtimeModel = readRecordOrThrow(
    cloneJsonValue(templateSources.runtimeModel),
    'generation_parameter_overrides_clone_invalid',
  );
  // 留痕用的模型身份：模板构建器把 model_id 写在 runtimeModel 顶层（各族同形）。
  const modelId = readString(runtimeModel.model_id);
  const parameterSchema = readRecordOrThrow(runtimeModel.parameter_schema, 'generation_parameter_overrides_template_schema_missing');
  const rawFields = parameterSchema.fields;
  if (!Array.isArray(rawFields)) {
    throw new Error('generation_parameter_overrides_template_fields_missing');
  }
  const defaultValues = readRecordOrThrow(parameterSchema.default_values, 'generation_parameter_overrides_template_defaults_missing');
  const runtime = readRecordOrThrow(runtimeModel.runtime, 'generation_parameter_overrides_template_runtime_missing');
  const payloadRules = readRecordOrThrow(runtime.payload_rules, 'generation_parameter_overrides_template_payload_rules_missing');
  const schemaDefaults = readRecordOrThrow(runtime.schema_defaults, 'generation_parameter_overrides_template_schema_defaults_missing');

  const facts = collectTemplateOverrideFacts(templateSources);
  const disabledFieldKeys = new Set<string>();
  const aliasByFieldKey = new Map<string, FieldWireFact>();
  const mediaMaxFilesByFieldKey = new Map<string, number>();
  for (const entry of overrides.official) {
    const fieldFacts = facts.fieldsByKey.get(entry.field_key);
    if (fieldFacts === undefined) continue;
    // 素材位的启用与否归记录上的 accepted_media_slots 勾选清单；合成只处理它开放的两个
    // 维度（保存期已拒绝其余维度，这里不需要二次判定）。
    if (entry.enabled === false && !fieldFacts.isMediaSlot) {
      disabledFieldKeys.add(entry.field_key);
      continue;
    }
    if (entry.wire_name !== undefined) {
      // 别名只改字段**当前落点内**的名称：落点（请求体 / 查询参数 / 请求头）保持不变。
      const current = facts.wireFactByFieldKey.get(entry.field_key);
      const location: FieldWireLocation = current?.wire_location ?? 'body';
      if (current === undefined || !isSameWireName(entry.wire_name, current.wire_name, location)) {
        aliasByFieldKey.set(entry.field_key, { wire_location: location, wire_name: entry.wire_name });
      }
    }
    if (fieldFacts.isMediaSlot && entry.media_max_files !== undefined) {
      mediaMaxFilesByFieldKey.set(entry.field_key, entry.media_max_files);
    }
  }

  // ① 禁用：移除字段 + default_values 键 + 「只承载被禁用字段自身」的 payload_rules 目标。
  const keptFieldRecords: JsonObject[] = [];
  for (const rawField of rawFields) {
    const record = readRecord(rawField);
    if (record === null) {
      throw new Error('generation_parameter_overrides_template_field_invalid');
    }
    const fieldKey = readString(record.field_key);
    if (fieldKey !== null && disabledFieldKeys.has(fieldKey)) continue;
    keptFieldRecords.push(record);
  }
  for (const key of disabledFieldKeys) {
    delete defaultValues[key];
    delete schemaDefaults[key];
  }
  // 裁剪判据与保存期拒绝判据共用同一份实现，不允许各写一份：保存期已拒绝「移除会改变请求
  // 体契约」的禁用（blockingTargets 非空），这里能裁剪的都是安全目标。若仍出现不可裁剪目标，
  // 说明保存期漏判——抛错兜底，绝不静默删掉整条目标（历史缺陷：`body.response_format`
  // 因 mimeType 被禁用而整条消失，请求体缺字段、上游按默认档生成）。
  const { prunableTargets, blockingTargets } = classifyDisabledFieldTargets(payloadRules, disabledFieldKeys);
  if (blockingTargets.size > 0) {
    throw new Error(
      `parameter_overrides_disabled_field_referenced: ${[...blockingTargets.keys()].join('; ')}`,
    );
  }
  const prunedRules: JsonObject = {};
  for (const [targetPath, rule] of Object.entries(payloadRules)) {
    if (rule === undefined || rule === null) continue;
    if (prunableTargets.has(targetPath)) continue;
    prunedRules[targetPath] = rule;
  }

  // ② 别名：改写该字段**当前落点内**的名称（保持条目顺序与落点命名空间）。
  //    归属判定与描述符共用 `ownedFieldKeyOfRule`——条件/断言包裹的规则同样要改名，
  //    否则保存期放行、运行时仍发旧字段名（静默不生效）。落点由 target 前缀决定：
  //    `body.<路径>` / `api.query.<名称>` / `api.headers.<名称>`，别名不跨命名空间搬移。
  const rewrittenRules: JsonObject = {};
  for (const [targetPath, rule] of Object.entries(prunedRules)) {
    const parsed = parseInterfaceFormatRuleTarget(targetPath);
    const fieldKey =
      parsed.kind === 'body_field' || parsed.kind === 'query' || parsed.kind === 'header'
        ? ownedFieldKeyOfRule(rule)
        : null;
    const alias = fieldKey === null ? undefined : aliasByFieldKey.get(fieldKey);
    const current = fieldKey === null ? undefined : facts.wireFactByFieldKey.get(fieldKey);
    if (alias === undefined || fieldKey === null || current === undefined) {
      rewrittenRules[targetPath] = rule;
      continue;
    }
    if (current.wire_location !== alias.wire_location) {
      // 别名只属于字段当前落点；其它命名空间里的同字段规则原样保留。
      rewrittenRules[targetPath] = rule;
      continue;
    }
    const isCurrentName =
      parsed.kind === 'body_field'
        ? parsed.path === current.wire_name
        : parsed.kind === 'query'
          ? parsed.name === current.wire_name
          : parsed.kind === 'header'
            ? normalizeHeaderName(parsed.name) === normalizeHeaderName(current.wire_name)
            : false;
    if (!isCurrentName) {
      rewrittenRules[targetPath] = rule;
      continue;
    }
    const nextTarget = formatInterfaceFormatBindingTarget(
      alias.wire_location === 'body'
        ? { location: 'body', path: alias.wire_name }
        : alias.wire_location === 'query'
          ? { location: 'query', name: alias.wire_name }
          : { location: 'header', name: alias.wire_name },
    );
    if (nextTarget in rewrittenRules) {
      throw new Error(`parameter_overrides_rule_target_conflict: ${nextTarget}`);
    }
    rewrittenRules[nextTarget] = rule;
  }

  // ③ 合法值与默认值：select 替换枚举；imageSize 收窄档位/比例；默认值落到 field 与两处默认表。
  const survivingFields = new Map<string, JsonObject>();
  for (const record of keptFieldRecords) {
    const fieldKey = readString(record.field_key);
    if (fieldKey !== null) survivingFields.set(fieldKey, record);
  }
  for (const entry of overrides.official) {
    const record = survivingFields.get(entry.field_key);
    if (record === undefined) continue; // 已禁用字段：第①步已处理
    if (entry.enum_options !== undefined && isRecordComponent(record, 'select')) {
      record.enum_options = entry.enum_options.map((value): JsonObject => ({ value }));
    }
    if (isRecordComponent(record, 'imagesize')) {
      const wantsPresetNarrowing =
        entry.resolution_preset_keys !== undefined || entry.aspect_preset_keys !== undefined;
      const props = wantsPresetNarrowing
        ? readComponentPropsForWrite(record, {
          modelId,
          fieldKey: entry.field_key,
          skippedWrite: 'size_presets',
        })
        : null;
      if (props !== null && entry.resolution_preset_keys !== undefined) {
        const keys = entry.resolution_preset_keys;
        props.sizeLevels = (Array.isArray(props.sizeLevels) ? props.sizeLevels : []).filter((item) => {
          const level = readRecord(item);
          const id = level === null ? null : readString(level.id);
          return id !== null && keys.includes(id);
        });
      }
      if (props !== null && entry.aspect_preset_keys !== undefined) {
        const keys = entry.aspect_preset_keys;
        props.aspectPresets = (Array.isArray(props.aspectPresets) ? props.aspectPresets : []).filter((item) => {
          const aspect = readRecord(item);
          const id = aspect === null ? null : readString(aspect.id);
          return id !== null && keys.includes(id);
        });
      }
    }
    if (entry.default_value !== undefined) {
      record.default_value = entry.default_value;
      defaultValues[entry.field_key] = entry.default_value;
      schemaDefaults[entry.field_key] = entry.default_value;
    }
  }

  // ③b 素材位张数：表单可附件数、是否允许多选、画布输入端口可连数必须同值。
  //     只改一处会造出「表单让传 3 张而画布只让连 1 个」（或反之）的错位。
  //     「产品侧不校验上限」只针对**张数取值本身**（真实上限属服务商接口事实，超限由上游拒绝）；
  //     它不等于允许字段结构缺失——字段缺 component_props 时这一维写入整体跳过（§3.5.1），
  //     端口与能力声明随同一跳过，避免造出「表单没改、画布被改」的新错位。
  const skippedComponentPropsFieldKeys = new Set<string>();
  for (const [fieldKey, maxFiles] of mediaMaxFilesByFieldKey) {
    const record = survivingFields.get(fieldKey);
    if (record === undefined) continue;
    const props = readComponentPropsForWrite(record, { modelId, fieldKey, skippedWrite: 'media_max_files' });
    if (props === null) {
      skippedComponentPropsFieldKeys.add(fieldKey);
      continue;
    }
    props.maxFiles = maxFiles;
    props.allowMultiple = maxFiles > 1;
  }
  // 实际写入成功的张数：端口与能力声明只跟随这一份（跳过的字段不进）。
  const appliedMediaMaxFilesByFieldKey = new Map(
    [...mediaMaxFilesByFieldKey].filter(([fieldKey]) => !skippedComponentPropsFieldKeys.has(fieldKey)),
  );

  // ④ 新增自定义字段：field_key = wire_name；控件按 value_type 派生；
  //    在模板现存的每个 endpoint 分支各追加一条 body.<wire_name> 规则（payload_rules 是
  //    分支无关的扁平规则表，字段规则对 generations 与 edits 两分支同样生效）。
  //    label 值是 locales 键 `fields.<wire>.label`（与模板字段同构），用户文本注册为译文（④b）。
  const customLabelEntries: Array<{ wire: string; label: string }> = [];
  for (const custom of overrides.custom) {
    const wire = custom.wire_name;
    const fieldRecord: JsonObject = {
      field_key: wire,
      label: `fields.${wire}.label`,
      required: custom.required,
      validation_rules: [],
      layout: { colSpan: 1 },
      component: componentForValueType(custom.value_type),
      component_props: {},
    };
    if (custom.value_type === 'enum' && custom.enum_options !== undefined) {
      fieldRecord.enum_options = custom.enum_options.map((value): JsonObject => ({ value }));
    }
    if (custom.default_value !== undefined) {
      fieldRecord.default_value = custom.default_value;
      defaultValues[wire] = custom.default_value;
      schemaDefaults[wire] = custom.default_value;
    }
    keptFieldRecords.push(fieldRecord);
    rewrittenRules[`body.${wire}`] = { kind: 'field', field_key: wire };
    customLabelEntries.push({ wire, label: custom.label });
  }
  parameterSchema.fields = keptFieldRecords;
  runtime.payload_rules = rewrittenRules;

  // ④b 自定义参数的显示名注册进模板 locales（zh-CN/en 同文）：合成投影走与已装包相同的
  // 本地化路径，parameter_schema 的每个 label 值都必须是 locales 里可解析的键——字段
  // label 写为 `fields.<wire>.label`，用户文本按「用户文本即译文」注册为该键的译文，
  // 否则合成投影会被 validateLocalizationTargets 拒掉（localization.field_label_missing）。
  let localizationResources = templateSources.localizationResources;
  if (customLabelEntries.length > 0) {
    const clonedResources = cloneJsonValue(localizationResources);
    if (!isLocaleResourcesShaped(clonedResources)) {
      throw new Error('generation_parameter_overrides_localization_resources_invalid');
    }
    localizationResources = {
      'zh-CN': registerCustomLabelEntries(clonedResources['zh-CN'], customLabelEntries),
      en: registerCustomLabelEntries(clonedResources.en, customLabelEntries),
    };
  }

  // ⑤ 终检：现有投影校验器 + 字段键引用校验（与投影管线同一实现）。
  validateParameterSchema(parameterSchema);
  validatePayloadRuleFieldKeysForParts(
    keptFieldRecords.map((record) => record.field_key),
    runtime.payload_rules,
  );

  // ⑤b 画布输入端口与能力声明跟随素材位张数：端口 `field_key` 与素材位字段键同源，
  //     多张时端口必须允许多连，否则创作面只能接一个资产、提交时凑不满张数。
  //     `supports_multi_image` 只升不降——族模板可能已因其它素材位声明为多图。
  //     只跟随**真的写进表单**的张数（appliedMediaMaxFilesByFieldKey）：表单那一维被降级跳过时，
  //     端口与能力声明必须保持模板原样，否则两处不同值。
  const node = cloneJsonValue(templateSources.node);
  if (Array.isArray(node.input_ports)) {
    for (const rawPort of node.input_ports) {
      const port = readRecord(rawPort);
      if (port === null) continue;
      const portFieldKey = readString(port.field_key);
      const maxFiles = portFieldKey === null ? undefined : appliedMediaMaxFilesByFieldKey.get(portFieldKey);
      if (maxFiles === undefined) continue;
      port.multiple = maxFiles > 1;
      port.max_connections = maxFiles;
    }
  }
  if ([...appliedMediaMaxFilesByFieldKey.values()].some((maxFiles) => maxFiles > 1)) {
    const capability = readRecord(runtimeModel.capability);
    if (capability !== null) capability.supports_multi_image = true;
  }

  if (!isObjectRecord(runtimeModel)) {
    throw new Error('generation_parameter_overrides_clone_invalid');
  }
  return {
    runtimeModel,
    node,
    localizationResources,
  };
};

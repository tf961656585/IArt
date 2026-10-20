import {
  GENERATION_MEDIA_SLOT_IDS,
  GENERATION_WIRE_NAME_PATTERN,
  cloneJsonValue,
  type CustomParameterField,
  type OfficialParameterOverride,
  type ParameterOverrides,
  type ParameterOverridesValue,
} from '@iart/contracts';
import type { ModelAssetLocalizationResourceMap } from '@iart/contracts/model-asset-contract';
import { isObjectRecord } from './model-package-catalog.shared.cts';
import type { LocaleResources } from './model-package-catalog.localization.cts';
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
 * 素材位归属由记录上的 `accepted_media_slots` 管控，参数层永不开放——这类字段既不能被
 * 别名改写、也不能被禁用或改默认值。判定按**组件类型**而不是 `image` 这个字面量：
 * 素材位词表里有图片、视频、音频等多种素材位，各族模板会用不同组件名承载，只认 `image`
 * 会把其它族的素材字段误判成可覆盖。
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
 * 导出给族模板参数描述符的通用构建复用：素材位字段不出现在参数编辑器官方区（归属由记录上的
 * `accepted_media_slots` 管控），判定必须与校验端同一份集合，不得在描述符侧另认一遍组件名。
 */
export const isMediaSlotComponentName = (component: string): boolean =>
  MEDIA_SLOT_COMPONENTS.has(component.toLowerCase());

/**
 * 系统注入/模态保留的发出键名：任何别名与自定义参数都不得占用。
 *
 * `model` 由 remote_model_id 注入；`prompt`/`input` 是提示词系统键；素材位词表里的每个 id
 * 都保留（它们会作为请求体键或 form 字段名出现，参数层永不开放）。素材位 id 从 contracts
 * 的受控词表派生，不在这里另写一份清单——词表扩容时保留键自动跟随。
 */
const SYSTEM_RESERVED_WIRE_NAMES: ReadonlySet<string> = new Set([
  'model',
  'prompt',
  'input',
  ...GENERATION_MEDIA_SLOT_IDS,
]);

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
  reservedWireNames: ReadonlySet<string>;
};

/**
 * 收集 payload_rules 已占用的发出键名：`body.<键>` 的键段 + 无点号的顶层键（提示词系统键），
 * 叠加系统保留键。保留键从模板 sources 计算，不硬编码字段清单（设计 §3.5）。
 *
 * 导出给族模板的参数描述符构建复用（GET /api/generation-family-templates/:familyAdapterId），
 * 与校验共用同一份保留键事实，不得另写第二份。
 */
export const collectReservedWireNames = (payloadRules: JsonObject | null): Set<string> => {
  const reserved = new Set<string>();
  for (const name of SYSTEM_RESERVED_WIRE_NAMES) {
    reserved.add(name);
  }
  if (payloadRules === null) return reserved;
  for (const targetPath of Object.keys(payloadRules)) {
    if (!targetPath.includes('.')) {
      reserved.add(targetPath);
      continue;
    }
    const second = targetPath.split('.')[1];
    if (targetPath.startsWith('body.') && second !== undefined && second.length > 0) {
      reserved.add(second);
    }
  }
  return reserved;
};

/**
 * 收集每个已声明字段当前的发出键名：来自 payload_rules 的 `body.<键>` target
 * （kind='field' 且 field_key 命中）。展示名与 wire 名分离靠 target 路径承载（设计 §1.2）。
 * 导出给族模板的参数描述符构建复用，与校验共用同一份 wire 名事实。
 */
export const collectWireNamesByFieldKey = (payloadRules: JsonObject | null): Map<string, string> => {
  const wireNameByFieldKey = new Map<string, string>();
  if (payloadRules === null) return wireNameByFieldKey;
  for (const [targetPath, rule] of Object.entries(payloadRules)) {
    if (!targetPath.startsWith('body.')) continue;
    const record = readRecord(rule);
    if (record === null || record.kind !== 'field') continue;
    const fieldKey = readString(record.field_key);
    if (fieldKey === null || wireNameByFieldKey.has(fieldKey)) continue;
    const keySegment = targetPath.slice('body.'.length).split('.')[0];
    if (keySegment !== undefined && keySegment.length > 0) {
      wireNameByFieldKey.set(fieldKey, keySegment);
    }
  }
  return wireNameByFieldKey;
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
    const facts: TemplateFieldFacts = {
      fieldKey,
      displayName,
      component: lowerComponent,
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
  const aliasWireNames = new Set<string>();
  const aliasByFieldKey = new Map<string, string>();
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
    if (MEDIA_SLOT_COMPONENTS.has(fieldFacts.component)) {
      violations.push({
        code: 'official_field_media_slot_not_overridable',
        message: `「${shownName}」是模型自带的素材输入，不能在这里关闭或修改。`,
      });
      continue;
    }
    if (entry.enabled === false) {
      // 禁用时其余维度无意义（合成第 1 步先整体移除），不再校验其合法性。
      disabledFieldKeys.add(fieldKey);
      continue;
    }
    if (entry.wire_name !== undefined) {
      const wire = entry.wire_name;
      if (!GENERATION_WIRE_NAME_PATTERN.test(wire)) {
        violations.push({
          code: 'wire_name_format',
          message: `参数「${shownName}」的发送名称「${wire}」格式不对：请以小写字母开头，只用小写字母、数字和下划线。`,
        });
      } else if (facts.reservedWireNames.has(wire)) {
        violations.push({
          code: 'wire_name_reserved',
          message: `发送名称「${wire}」和这个模型自带的参数重名了，请换一个名称再保存。`,
        });
      } else if (aliasWireNames.has(wire)) {
        violations.push({
          code: 'wire_name_conflict',
          message: `有两个参数都用了发送名称「${wire}」，请把它们改成不同的名称。`,
        });
      } else {
        aliasWireNames.add(wire);
      }
      aliasByFieldKey.set(fieldKey, wire);
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
  // 官方参数覆盖生效后的最终发出键名（禁用字段已释放其键名）。
  const currentWireNameByFieldKey = collectWireNamesByFieldKey(facts.payloadRules);
  const finalOfficialWireNames = new Set<string>();
  for (const field of facts.fields) {
    if (disabledFieldKeys.has(field.fieldKey)) continue;
    finalOfficialWireNames.add(aliasByFieldKey.get(field.fieldKey) ?? currentWireNameByFieldKey.get(field.fieldKey) ?? field.fieldKey);
  }
  for (const custom of overrides.custom) {
    const wire = custom.wire_name;
    if (!GENERATION_WIRE_NAME_PATTERN.test(wire)) {
      violations.push({
        code: 'wire_name_format',
        message: `自定义参数「${custom.label}」的发送名称「${wire}」格式不对：请以小写字母开头，只用小写字母、数字和下划线。`,
      });
    } else if (facts.reservedWireNames.has(wire)) {
      violations.push({
        code: 'wire_name_reserved',
        message: `自定义参数的发送名称「${wire}」和这个模型自带的参数重名了，请换一个名称再保存。`,
      });
    } else if (customWireNames.has(wire)) {
      violations.push({
        code: 'wire_name_conflict',
        message: `有两个自定义参数都用了发送名称「${wire}」，请把它们改成不同的名称。`,
      });
    } else if (aliasWireNames.has(wire) || finalOfficialWireNames.has(wire)) {
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
  const aliasByFieldKey = new Map<string, string>();
  for (const entry of overrides.official) {
    const fieldFacts = facts.fieldsByKey.get(entry.field_key);
    // 素材位字段不参与合成：归属由记录上的 accepted_media_slots 管控（保存期已拒绝）。
    if (fieldFacts === undefined || MEDIA_SLOT_COMPONENTS.has(fieldFacts.component)) continue;
    if (entry.enabled === false) {
      disabledFieldKeys.add(entry.field_key);
      continue;
    }
    if (entry.wire_name !== undefined) {
      aliasByFieldKey.set(entry.field_key, entry.wire_name);
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

  // ② 别名：改写该 field_key 的 payload_rule 的 body.<键> 键段（保持条目顺序）。
  const rewrittenRules: JsonObject = {};
  for (const [targetPath, rule] of Object.entries(prunedRules)) {
    const record = readRecord(rule);
    const fieldKey = record !== null && record.kind === 'field' ? readString(record.field_key) : null;
    const alias = fieldKey !== null ? aliasByFieldKey.get(fieldKey) : undefined;
    if (alias !== undefined && targetPath.startsWith('body.')) {
      const rest = targetPath.slice('body.'.length);
      const dotIndex = rest.indexOf('.');
      const nextTarget = dotIndex === -1 ? `body.${alias}` : `body.${alias}${rest.slice(dotIndex)}`;
      rewrittenRules[nextTarget] = rule;
      continue;
    }
    rewrittenRules[targetPath] = rule;
  }

  // ③ 合法值与默认值：select 替换枚举；imageSize 收窄档位/比例；默认值落到 field 与两处默认表。
  const survivingFields = new Map<string, JsonObject>();
  for (const record of keptFieldRecords) {
    const fieldKey = readString(record.field_key);
    if (fieldKey !== null) survivingFields.set(fieldKey, record);
  }
  for (const entry of overrides.official) {
    const record = survivingFields.get(entry.field_key);
    if (record === undefined) continue; // 禁用或不可覆盖字段：第①步已处理
    if (entry.enum_options !== undefined && isRecordComponent(record, 'select')) {
      record.enum_options = entry.enum_options.map((value): JsonObject => ({ value }));
    }
    if (isRecordComponent(record, 'imagesize')) {
      const props = readRecord(record.component_props);
      if (props === null) {
        throw new Error('generation_parameter_overrides_template_component_props_missing');
      }
      if (entry.resolution_preset_keys !== undefined) {
        const keys = entry.resolution_preset_keys;
        props.sizeLevels = (Array.isArray(props.sizeLevels) ? props.sizeLevels : []).filter((item) => {
          const level = readRecord(item);
          const id = level === null ? null : readString(level.id);
          return id !== null && keys.includes(id);
        });
      }
      if (entry.aspect_preset_keys !== undefined) {
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

  if (!isObjectRecord(runtimeModel)) {
    throw new Error('generation_parameter_overrides_clone_invalid');
  }
  return {
    runtimeModel,
    node: templateSources.node,
    localizationResources,
  };
};

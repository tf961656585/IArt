import type {
  FamilyTemplateParameterDescriptor,
  GenerationFamilyAdapterId,
  GenerationMediaSlotId,
  ParameterOverrides,
} from '@iart/contracts';
import type { LocaleResources } from './model-package-catalog.localization.cts';
import { isObjectRecord } from './model-package-catalog.shared.cts';
import type { CatalogRawObject, JsonObject } from './model-package-catalog.types.cts';
import {
  collectReservedWireNames,
  collectWireNamesByFieldKey,
  isMediaSlotComponentName,
  isScalarParameterValue,
  resolveLocaleText,
} from './generation-parameter-overrides.cts';

/**
 * 生成族模板的**共享契约**（docs/custom-providers/生成模型自建声明试点-design.md §3.3）。
 *
 * 用户自建生成模型没有模型能力包：记录只携带模型属性，协议语义与默认参数表单由 Runtime
 * Backend 内置的族模板承载，二者合成为内存态虚拟能力包投影。
 *
 * 2026-10-19 起接口类型由 1 个扩到 7 个（`GENERATION_FAMILY_ADAPTER_IDS`），族模板从
 * 「本模块里的一份 openai-image 实现」改为「一族一份实现 + 注册表分发」：
 * - 本模块只承载跨族共用的类型与形状工具，**不含任何一族的规则**；
 * - 每族实现独立成文件（`generation-family-templates.openai-image.cts` 为已就绪族）；
 * - 注册表在 `generation-family-templates.registry.cts`，按 `family_adapter_id` 分发，
 *   并用 `Record<GenerationFamilyAdapterId, ...>` 在编译期钉住 7 个键齐全。
 *
 * 模板是 Runtime Backend 内置资源：不进 contracts、不落任何安装目录；合成投影
 * 是纯内存态（模型包目录零写入）。
 */

/** 族模板来源：交给 buildProjectionFromPackageSources 走与已装包相同的投影路径。 */
export type GenerationFamilyTemplateSources = {
  runtimeModel: CatalogRawObject;
  node: CatalogRawObject;
  localizationResources: LocaleResources;
};

/**
 * 合成一份族模板所需要的记录侧输入（所有族共用同一形状）。
 *
 * `acceptedMediaSlots` 取代了试点期的 `supportsReferenceImage` 布尔：素材位是受控词表
 * （`GENERATION_MEDIA_SLOT_IDS`），各族的模板据此决定「有没有该素材位的表单字段、走哪个
 * 请求分支」。某族模板不认识的素材位不会传进来（写入侧按该族 `supportsMediaSlots` 拦；
 * 投影侧再按同一份能力过滤并留痕）。
 *
 * `parameterOverrides` 可省略，省略即空覆盖：空覆盖时合成函数原样返回基础模板（同一引用），
 * 行为与无覆盖完全一致（设计 S8）。
 */
export type GenerationFamilyTemplateOptions = {
  acceptedMediaSlots: readonly GenerationMediaSlotId[];
  parameterOverrides?: ParameterOverrides;
};

/** 一族的「基础模板构建器」：不含记录覆盖，纯由 model_id 与接受的素材位决定。 */
export type GenerationFamilyTemplateBuilder = (
  modelId: string,
  options: GenerationFamilyTemplateOptions,
) => GenerationFamilyTemplateSources;

/**
 * 合成投影的虚拟包身份（本地化命名空间 `model-asset/<packageId>` 的载体）。
 *
 * 按族派生而不是全局单值：7 族并存后，声明投影的本地化命名空间必须能区分「这条投影属于
 * 哪个族的模板」，否则两族的文案会在同一命名空间里互相覆盖。openai-image-v1 派生结果与
 * 试点期常量 `declared-openai-image-v1` 完全一致，存量投影身份零变化。
 */
export const declaredGenerationPackageId = (familyAdapterId: GenerationFamilyAdapterId): string =>
  `declared-${familyAdapterId}`;

/**
 * JsonObject 字面量 → CatalogRawObject 的边界收窄（仓库惯用的 isObjectRecord 运行时守卫，
 * 不用类型断言：CatalogRawObject 的读侧属性是「必需但可 undefined」，弱类型检查不接受
 * 无索引签名的字面量直赋）。
 */
export const toCatalogRawObject = (value: JsonObject): CatalogRawObject => {
  if (!isObjectRecord(value)) {
    throw new Error('generation_family_template_source_invalid');
  }
  return value;
};

// ---------------------------------------------------------------------------
// 族模板参数描述（GET /api/generation-family-templates/:familyAdapterId 的通用构建）
// ---------------------------------------------------------------------------

/**
 * 从一份族模板 sources 构建参数描述（各 ready 族共用，族与族之间只差 sources）。
 *
 * 口径（生成模型参数高级自定义设计 §3.4）：
 * - 官方参数区**排除素材位字段**（组件名判定与覆盖校验共用同一份集合），素材位的归属由记录上
 *   的 `accepted_media_slots` 管控，参数层永不开放；
 * - `wire_name` 从 payload_rules 的 `body.<键>` target 提取，与校验共用同一份 wire 名事实；
 * - `label` 用模板 locales 中文解析（读端拿到即可展示，编辑器不做翻译）；
 * - 预设从 component_props 提取（档位/auto/自定义预设全量可选键）；
 * - `reserved_wire_names` = 基线 sources 的 payload_rules ∪ `extraPayloadRuleSets`（各族把
 *   自己其余请求分支也传进来，见 openai-image 的 i2i 分支）。
 *
 * 点号路径取文案的实现唯一承载在 generation-parameter-overrides.resolveLocaleText，此处不另写。
 */
export const buildFamilyTemplateParameterDescriptorFromSources = ({
  familyAdapterId,
  baselineSources,
  extraPayloadRuleSets = [],
}: {
  familyAdapterId: string;
  baselineSources: GenerationFamilyTemplateSources;
  /**
   * 基线 sources 覆盖不到的其它请求分支 payload_rules（可省略）。
   *
   * 例：openai-image-v1 的基线是不接受素材位的 t2i 形态，必须在保留键里并入 i2i 分支，
   * 否则声明接受参考图后 `image` 等键会被参数编辑器当成可占用名。
   */
  extraPayloadRuleSets?: readonly JsonObject[];
}): FamilyTemplateParameterDescriptor => {
  const runtimeModel = baselineSources.runtimeModel;
  const zhResources = baselineSources.localizationResources['zh-CN'];
  const parameterSchema = toCatalogRawObject(
    isObjectRecord(runtimeModel.parameter_schema) ? runtimeModel.parameter_schema : {},
  );
  const runtime = toCatalogRawObject(isObjectRecord(runtimeModel.runtime) ? runtimeModel.runtime : {});
  const payloadRules = isObjectRecord(runtime.payload_rules) ? runtime.payload_rules : null;
  const wireNameByFieldKey = collectWireNamesByFieldKey(payloadRules);
  const reservedWireNames = collectReservedWireNames(payloadRules);
  for (const extraRules of extraPayloadRuleSets) {
    for (const name of collectReservedWireNames(extraRules)) {
      reservedWireNames.add(name);
    }
  }
  const rawFields = Array.isArray(parameterSchema.fields) ? parameterSchema.fields : [];
  const officialFields: FamilyTemplateParameterDescriptor['official_fields'] = [];
  for (const rawField of rawFields) {
    if (!isObjectRecord(rawField)) continue;
    const fieldKey = typeof rawField.field_key === 'string' ? rawField.field_key : null;
    if (fieldKey === null) continue;
    const component = typeof rawField.component === 'string' ? rawField.component : '';
    // 素材位字段不可覆盖，不在编辑器出现
    if (isMediaSlotComponentName(component)) continue;
    const labelKey = typeof rawField.label === 'string' && rawField.label ? rawField.label : `fields.${fieldKey}.label`;
    const label = resolveLocaleText(zhResources, labelKey) ?? fieldKey;
    const wireName = wireNameByFieldKey.get(fieldKey) ?? fieldKey;
    const defaultValue = isScalarParameterValue(rawField.default_value) ? rawField.default_value : null;
    const enumOptions: FamilyTemplateParameterDescriptor['official_fields'][number]['enum_options'] = [];
    if (Array.isArray(rawField.enum_options)) {
      for (const option of rawField.enum_options) {
        if (!isObjectRecord(option)) continue;
        if (isScalarParameterValue(option.value)) enumOptions.push(option.value);
      }
    }
    const labelPrefix = labelKey.endsWith('.label') ? labelKey.slice(0, -'.label'.length) : labelKey;
    const resolutionPresets: FamilyTemplateParameterDescriptor['official_fields'][number]['resolution_presets'] = [];
    const aspectPresets: FamilyTemplateParameterDescriptor['official_fields'][number]['aspect_presets'] = [];
    if (isObjectRecord(rawField.component_props)) {
      const props = rawField.component_props;
      if (Array.isArray(props.sizeLevels)) {
        for (const item of props.sizeLevels) {
          if (!isObjectRecord(item) || typeof item.id !== 'string') continue;
          resolutionPresets.push({
            key: item.id,
            label: resolveLocaleText(zhResources, `${labelPrefix}.sizeLevels.${item.id}.label`) ?? item.id,
          });
        }
      }
      if (Array.isArray(props.aspectPresets)) {
        for (const item of props.aspectPresets) {
          if (!isObjectRecord(item) || typeof item.id !== 'string') continue;
          // 比例预设 id 形如 '1:1'，locales 键用下划线形态（'1_1'）。
          const localeKey = item.id.replace(/:/g, '_');
          aspectPresets.push({
            key: item.id,
            label: resolveLocaleText(zhResources, `${labelPrefix}.aspectPresets.${localeKey}.label`) ?? item.id,
          });
        }
      }
    }
    officialFields.push({
      field_key: fieldKey,
      label,
      component,
      wire_name: wireName,
      required: rawField.required === true,
      default_value: defaultValue,
      enum_options: enumOptions,
      resolution_presets: resolutionPresets,
      aspect_presets: aspectPresets,
    });
  }
  return {
    family_adapter_id: familyAdapterId,
    official_fields: officialFields,
    reserved_wire_names: [...reservedWireNames].sort(),
    // 族能力事实的唯一来源是注册表条目的 `supportsMediaSlots`，本通用构建不掌握它，
    // 由注册表的 `buildFamilyTemplateParameterDescriptor` 统一填入（单源填充，各族文件
    // 不各自声明一份，避免注册表与描述符两侧漂移）。
    supports_media_slots: [],
    required_media_slots: [],
  };
};

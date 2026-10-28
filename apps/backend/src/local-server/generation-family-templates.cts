import type {
  FamilyTemplateOfficialField,
  FamilyTemplateParameterDescriptor,
  GenerationMediaSlotId,
  InterfaceRecipe,
  ParameterOverrides,
} from '@iart/contracts';
import type { LocaleResources } from './model-package-catalog.localization.cts';
import { isObjectRecord } from './model-package-catalog.shared.cts';
import type { CatalogRawObject, JsonObject } from './model-package-catalog.types.cts';
import { isMediaSlotComponentName, isScalarParameterValue, resolveLocaleText } from './generation-parameter-overrides.cts';
import {
  collectReservedWireNames,
  collectWireNamesByFieldKey,
  mergeReservedWireNames,
} from './generation-wire-names.cts';

/**
 * 生成族模板的**共享契约**（docs/custom-providers/生成模型自建声明试点-design.md §3.3）。
 *
 * 用户自建生成模型没有模型能力包：记录只携带模型属性，协议语义与默认参数表单由 Runtime
 * Backend 内置的族模板承载，二者合成为内存态虚拟能力包投影。
 *
 * 2026-10-19 起接口类型由 1 个扩到 7 个（`GENERATION_FAMILY_ADAPTER_IDS`），族模板从
 * 「本模块里的一份 openai-image 实现」改为「一族一份实现 + 注册表分发」；2026-10-26 起
 * 运行时事实源再下沉一层——「接口类型 → 协议语义」由**接口格式实体**（随软件分发的预设）
 * 承载，`generation-family-templates.registry.cts` 降级为实体门面（导出名与形状不变）：
 * - 本模块只承载跨族共用的类型与形状工具，**不含任何一族的规则**；
 * - 族的协议语义在 `interface-format/presets/*.json`（实体 schema 见 `interface-format/schema.cts`）；
 * - 门面在 `generation-family-templates.registry.cts`，按 `family_adapter_id` 查实体注册表；
 *   逐族的 `generation-family-templates.<family>.cts` 旧实现已于 2026-10-26 删除，等价性由
 *   `interface-format/__tests__/interface-format.golden.test.ts` 的 golden hash 接替保护。
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
  /**
   * 记录引用的接口配方（`docs/custom-providers/接口配方-design.md` §6/§7）。
   *
   * 缺省 / null = 使用该族模板的内置默认判定与结果形态（行为与引入配方前完全一致）。
   * 出现时在参数覆盖之后合入 sources；族一致性由写入侧保证，投影侧对不匹配的引用回落默认
   * 并留痕（不阻断该记录的投影）。
   */
  recipe?: InterfaceRecipe | null;
};

/** 一族的「基础模板构建器」：不含记录覆盖，纯由 model_id 与接受的素材位决定。 */
export type GenerationFamilyTemplateBuilder = (
  modelId: string,
  options: GenerationFamilyTemplateOptions,
) => GenerationFamilyTemplateSources;

/**
 * 合成投影的虚拟包身份（本地化命名空间 `model-asset/<packageId>` 的载体）。
 *
 * 按格式 id 派生而不是全局单值：多格式并存时，声明投影的本地化命名空间必须能区分
 * 「这条投影属于哪个格式的模板」，否则两族的文案会在同一命名空间里互相覆盖。
 * openai-image-v1 派生结果与试点期常量 `declared-openai-image-v1` 完全一致，存量投影身份零变化。
 *
 * 入参是 `string`（2026-10-26 起 id 值域由接口格式实体注册表裁定，contracts 只约束形状）：
 * 记录里的 `family_adapter_id` 不再有封闭枚举类型，本函数只做模板字符串拼接，不做校验。
 */
export const declaredGenerationPackageId = (familyAdapterId: string): string =>
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
 * - 官方参数区**不含素材位字段**（组件名判定与覆盖校验共用同一份集合）：基线是「不接受任何
 *   素材位」的形态，素材位行由注册表在描述符分发处用全部素材位的 sources 补齐（
 *   `collectMediaSlotOfficialFields`）。描述符是**族级事实**（该族一共能表达哪几行），不含
 *   某条记录勾了哪些位；「当前该显示哪几行」由消费端（Hub 弹层）按勾选清单过滤；
 * - `wire_name` / `wire_location` 从 payload_rules 的 target（`body.<路径>` / `api.query.<名>` /
 *   `api.headers.<名>`）提取，与校验共用同一份 wire 名事实；
 * - `label` 用模板 locales 中文解析（读端拿到即可展示，编辑器不做翻译）；
 * - 预设从 component_props 提取（档位/auto/自定义预设全量可选键）；
 * - `reserved_wire_names` = 基线 sources 的 payload_rules ∪ `extraPayloadRuleSets`（各族把
 *   自己其余请求分支也传进来，见 openai-image 的 i2i 分支），按请求体 / 查询参数 / 请求头三个
 *   命名空间分别给出（同名在不同命名空间是不同字段）。
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
  // 「字段 → 当前落点与发出名」与保留键都只用一份实现（generation-parameter-overrides）：
  // 描述符、保存期校验与合并期别名共用同一套 target 解析，不在这里另写一份。
  const wireFactByFieldKey = collectWireNamesByFieldKey(payloadRules);
  const reservedWireNames = collectReservedWireNames(payloadRules);
  for (const extraRules of extraPayloadRuleSets) {
    mergeReservedWireNames(reservedWireNames, collectReservedWireNames(extraRules));
    for (const [fieldKey, fact] of collectWireNamesByFieldKey(extraRules)) {
      if (!wireFactByFieldKey.has(fieldKey)) wireFactByFieldKey.set(fieldKey, fact);
    }
  }
  const rawFields = Array.isArray(parameterSchema.fields) ? parameterSchema.fields : [];
  const officialFields: FamilyTemplateParameterDescriptor['official_fields'] = [];
  for (const rawField of rawFields) {
    if (!isObjectRecord(rawField)) continue;
    const fieldKey = typeof rawField.field_key === 'string' ? rawField.field_key : null;
    if (fieldKey === null) continue;
    const component = typeof rawField.component === 'string' ? rawField.component : '';
    // 素材位字段不进基线官方区：素材位行由注册表按全部素材位的 sources 补齐。
    if (isMediaSlotComponentName(component)) continue;
    const labelKey = typeof rawField.label === 'string' && rawField.label ? rawField.label : `fields.${fieldKey}.label`;
    const label = resolveLocaleText(zhResources, labelKey) ?? fieldKey;
    const wireFact = wireFactByFieldKey.get(fieldKey);
    const wireName = wireFact?.wire_name ?? fieldKey;
    const wireLocation: FamilyTemplateOfficialField['wire_location'] = wireFact?.wire_location ?? 'body';
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
      wire_location: wireLocation,
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
    // 三个命名空间各自的保留键：请求体含系统注入键，查询参数/请求头只含规则树里出现过的名字。
    reserved_wire_names: {
      body: [...reservedWireNames.body].sort(),
      query: [...reservedWireNames.query].sort(),
      header: [...reservedWireNames.header].sort(),
    },
    // 族能力事实的唯一来源是注册表条目的 `supportsMediaSlots`，本通用构建不掌握它，
    // 由注册表的 `buildFamilyTemplateParameterDescriptor` 统一填入（单源填充，各族文件
    // 不各自声明一份，避免注册表与描述符两侧漂移）。
    supports_media_slots: [],
    required_media_slots: [],
  };
};

/**
 * 从一份**含全部素材位**的族模板 sources 收集素材位参数描述（描述符官方区里的素材位行）。
 *
 * 为什么单独一个入口：族描述符的基线是「不接受任何素材位」的形态（素材位字段不进基线，
 * 否则文生基线也会出现用不上的输入行）。素材位行只能在全部素材位的 sources 上取，且
 * 位置与命名必须与覆盖校验共用同一份事实（locales label、payload_rules 的 wire 名、
 * `component_props.maxFiles`），因此在同一个模块里实现，不在注册表侧重写一遍。
 *
 * 反向映射由调用方传入（注册表条目的 `mediaSlotFieldKeys` 是唯一出口）：字段键 → 位标识
 * 只有那一份事实，本函数不另建映射。
 */
export const collectMediaSlotOfficialFields = (
  sources: GenerationFamilyTemplateSources,
  mediaSlotFieldKeys: Readonly<Partial<Record<GenerationMediaSlotId, string>>>,
): FamilyTemplateOfficialField[] => {
  const slotIdByFieldKey = new Map<string, GenerationMediaSlotId>();
  for (const [slotId, fieldKey] of Object.entries(mediaSlotFieldKeys)) {
    if (typeof fieldKey === 'string' && fieldKey.length > 0) {
      slotIdByFieldKey.set(fieldKey, slotId as GenerationMediaSlotId);
    }
  }
  const runtimeModel = sources.runtimeModel;
  const zhResources = sources.localizationResources['zh-CN'];
  const parameterSchema = toCatalogRawObject(
    isObjectRecord(runtimeModel.parameter_schema) ? runtimeModel.parameter_schema : {},
  );
  const runtime = toCatalogRawObject(isObjectRecord(runtimeModel.runtime) ? runtimeModel.runtime : {});
  const payloadRules = isObjectRecord(runtime.payload_rules) ? runtime.payload_rules : null;
  const wireFactByFieldKey = collectWireNamesByFieldKey(payloadRules);
  const rawFields = Array.isArray(parameterSchema.fields) ? parameterSchema.fields : [];
  const mediaFields: FamilyTemplateOfficialField[] = [];
  for (const rawField of rawFields) {
    if (!isObjectRecord(rawField)) continue;
    const fieldKey = typeof rawField.field_key === 'string' ? rawField.field_key : null;
    if (fieldKey === null) continue;
    const component = typeof rawField.component === 'string' ? rawField.component : '';
    if (!isMediaSlotComponentName(component)) continue;
    const slotId = slotIdByFieldKey.get(fieldKey);
    if (slotId === undefined) continue;
    const labelKey = typeof rawField.label === 'string' && rawField.label ? rawField.label : `fields.${fieldKey}.label`;
    const props = isObjectRecord(rawField.component_props) ? rawField.component_props : null;
    const rawMaxFiles = props === null ? null : props.maxFiles;
    const maxFiles = typeof rawMaxFiles === 'number' && Number.isInteger(rawMaxFiles) && rawMaxFiles >= 1
      ? rawMaxFiles
      : null;
    mediaFields.push({
      field_key: fieldKey,
      label: resolveLocaleText(zhResources, labelKey) ?? fieldKey,
      component,
      wire_name: wireFactByFieldKey.get(fieldKey)?.wire_name ?? fieldKey,
      // 素材位只能发到请求体（契约禁止 query/header 素材位）。
      wire_location: 'body',
      required: rawField.required === true,
      // 素材位没有标量默认值：它的默认值是空数组，不参与官方参数区的默认值语义。
      default_value: null,
      enum_options: [],
      resolution_presets: [],
      aspect_presets: [],
      media_slot_id: slotId,
      ...(maxFiles === null ? {} : { media_max_files: maxFiles }),
    });
  }
  return mediaFields;
};

import {
  ChatModelDirectoryEntrySchema,
  ExecutableModelDirectoryEntrySchema,
  ExecutableModelFailureCodeSchema,
  GenerationMediaSlotIdSchema,
  canAdapterExpressThinkingTier,
  type ChatModelDirectoryEntry,
  type ExecutableCatalogMediaSlot,
  type ExecutableModelDirectoryEntry,
  type ExecutableModelFailureCode,
} from '@iart/contracts';
import * as loggingModule from './logging.cts';
import { buildDeclaredGenerationProjection, resolveReferencedRecipe } from './generation-declaration-projection.cts';
import { getInterfaceFormat } from './interface-format/registry.cts';
import { collectMediaSlotOfficialFields } from './generation-family-templates.cts';
import {
  getFamilyTemplate,
  type GenerationFamilyTemplateEntry,
} from './generation-family-templates.registry.cts';
import {
  getCustomGenerationModelByRecordId,
  listCustomGenerationModels,
} from './provider-connection/custom-generation-model-store.cts';
import {
  getActiveDeploymentId,
  resolveActiveTarget,
  type ActiveRouteTarget,
} from './provider-connection/active-route-store.cts';
import { getCustomChatModel } from './provider-connection/custom-chat-model-store.cts';
import { getConnection } from './provider-connection/connection-store.cts';
import { getAdapter } from './protocol-adapter/adapter-registry.cts';

/**
 * 目录投影里标记「这是一个对话模型」的执行驱动值。
 *
 * 现在它只出现在**用户自建模型的目录投影**上（见本文件 `projectCustomChatModelToCatalogItem`），
 * 不再是模型能力包可声明的驱动——对话模型不再由包承载。读侧靠它把自建模型认成对话模型。
 */
export const CHAT_STREAMING_DRIVER = 'chat_streaming';

/**
 * 模型目录条目投影（spec 45 §1/§3、spec 03 §6）。
 *
 * 可执行模型目录（GET /api/executable-model-catalog）与对话模型目录
 * （GET /api/chat-model-catalog）的条目投影形状相同，本模块是它的唯一构建点：
 * 两个端点只在「选哪些已装模型」上不同，字段投影与可执行性判定不得各自复制一份。
 */

const CATALOG_MODEL_VERSION = '1.0.0';

/** 开放结构的本地投影容器（稳定业务区：隐藏裸 Record<string, unknown> 边界命名）。 */
type CatalogOpenMap = Record<string, unknown>;

type ExecutabilityJudgement = {
  hasActiveDeployment: boolean;
  activeDeploymentId: string | null;
  deployable: boolean;
  failureCode: ExecutableModelFailureCode;
};

/**
 * 判定单个 model_id 当前的可执行性（spec 45 §3 / spec 03 §6）。
 *
 * 判定顺序与 spec 45 §3 一行对应，code 稳定可测试；不回退、不补选。
 * active 目标是该模型的**用户模型记录**（spec 03 §6.2）：解析出记录后走连接/凭证/协议判定。
 *
 * 协议判定按来源分族（2026-10-27）：
 * - 生成记录：协议是**接口格式 id**。判定格式是否存在、是否就绪；用户自建格式还必须能解析到
 *   一份接口配方（自建格式没有内置行为默认，缺配方即不可提交，接口配方-design §8.4）。
 *   不再查代码适配器——生成侧内置适配器已退场。
 * - 对话记录：协议是内置对话适配器 id，仍走适配器注册表。
 */
const judgeExecutability = (modelId: string): ExecutabilityJudgement => {
  const activeDeploymentId = getActiveDeploymentId(modelId);
  if (!activeDeploymentId) {
    return {
      hasActiveDeployment: false,
      activeDeploymentId: null,
      deployable: false,
      failureCode: 'no_active_deployment',
    };
  }
  const access: ActiveRouteTarget | null = resolveActiveTarget(modelId);
  if (!access) {
    return {
      hasActiveDeployment: true,
      activeDeploymentId,
      deployable: false,
      failureCode: 'connection_missing',
    };
  }
  const connection = getConnection(access.connection_id);
  if (!connection) {
    return {
      hasActiveDeployment: true,
      activeDeploymentId,
      deployable: false,
      failureCode: 'connection_missing',
    };
  }
  if (connection.lifecycle !== 'enabled') {
    const failureCode: ExecutableModelFailureCode =
      connection.lifecycle === 'retired' ? 'connection_retired' : 'connection_disabled';
    return {
      hasActiveDeployment: true,
      activeDeploymentId,
      deployable: false,
      failureCode,
    };
  }
  if (!connection.has_credential || !connection.credential_ref) {
    return {
      hasActiveDeployment: true,
      activeDeploymentId,
      deployable: false,
      failureCode: 'credential_missing',
    };
  }
  const protocolId = access.protocol_adapter_id;
  if (access.source === 'custom_generation') {
    const formatLookup = getInterfaceFormat(protocolId);
    if (formatLookup.kind === 'unknown') {
      return {
        hasActiveDeployment: true,
        activeDeploymentId,
        deployable: false,
        failureCode: 'format_missing',
      };
    }
    if (formatLookup.kind === 'pending') {
      return {
        hasActiveDeployment: true,
        activeDeploymentId,
        deployable: false,
        failureCode: 'format_not_ready',
      };
    }
    if (formatLookup.format.origin === 'user') {
      const record = getCustomGenerationModelByRecordId(access.target_id);
      if (record === null || resolveReferencedRecipe(record) === null) {
        return {
          hasActiveDeployment: true,
          activeDeploymentId,
          deployable: false,
          failureCode: 'recipe_missing',
        };
      }
    }
  } else if (!protocolId || !getAdapter(protocolId)) {
    return {
      hasActiveDeployment: true,
      activeDeploymentId,
      deployable: false,
      failureCode: 'adapter_missing',
    };
  }
  if (!access.remote_model_id.trim()) {
    return {
      hasActiveDeployment: true,
      activeDeploymentId,
      deployable: false,
      failureCode: 'remote_model_id_empty',
    };
  }
  return {
    hasActiveDeployment: true,
    activeDeploymentId,
    deployable: true,
    failureCode: 'none',
  };
};

const projectParameterFields = (projection: unknown): ExecutableModelDirectoryEntry['parameter_schema'] => {
  const p = (projection ?? {}) as {
    parameter_schema?: {
      fields?: unknown[];
      required_fields?: unknown;
      default_values?: unknown;
    };
  };
  const schema = p.parameter_schema ?? {};
  const fields = Array.isArray(schema.fields)
    ? schema.fields.map((raw) => {
        const f = raw as {
          field_key?: unknown;
          label?: unknown;
          description?: unknown;
          component?: unknown;
          required?: unknown;
          default_value?: unknown;
          enum_options?: unknown;
          data_source?: unknown;
          component_props?: unknown;
          visible_when?: unknown;
          metadata?: unknown;
        };
        return {
          fieldKey: typeof f.field_key === 'string' && f.field_key.trim() ? f.field_key.trim() : '',
          label: typeof f.label === 'string' ? f.label : '',
          component: typeof f.component === 'string' ? f.component : '',
          description: typeof f.description === 'string' ? f.description : undefined,
          required: f.required === true,
          defaultValue: f.default_value,
          enumOptions: Array.isArray(f.enum_options)
            ? (f.enum_options as Array<{ value?: unknown; label?: unknown }>).flatMap((opt) => {
                if (
                  typeof opt.value !== 'string' &&
                  typeof opt.value !== 'number' &&
                  typeof opt.value !== 'boolean'
                ) {
                  loggingModule.logDebug('[model-catalog] drop non-primitive enum option value', {
                    valueType: opt.value === null ? 'null' : typeof opt.value,
                  });
                  return [];
                }
                return [{
                  value: opt.value,
                  ...(typeof opt.label === 'string' ? { label: opt.label } : {}),
                }];
              })
            : undefined,
          dataSource: f.data_source === 'connection' || f.data_source === 'form' || f.data_source === 'both'
            ? (f.data_source as 'connection' | 'form' | 'both')
            : undefined,
          componentProps: f.component_props !== undefined && f.component_props !== null && typeof f.component_props === 'object' && !Array.isArray(f.component_props)
            ? (f.component_props as CatalogOpenMap)
            : undefined,
          visibleWhen: f.visible_when !== undefined && f.visible_when !== null && typeof f.visible_when === 'object' && !Array.isArray(f.visible_when)
            ? (f.visible_when as CatalogOpenMap)
            : undefined,
          metadata: f.metadata !== undefined && f.metadata !== null && typeof f.metadata === 'object' && !Array.isArray(f.metadata)
            ? (f.metadata as CatalogOpenMap)
            : undefined,
        };
      })
    : [];
  const requiredFields = Array.isArray(schema.required_fields)
    ? schema.required_fields.filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
    : [];
  const defaultValues = schema.default_values !== null && schema.default_values !== undefined && typeof schema.default_values === 'object' && !Array.isArray(schema.default_values)
    ? (schema.default_values as CatalogOpenMap)
    : undefined;
  return {
    fields: fields.filter((field) => field.fieldKey && field.component),
    required_fields: requiredFields,
    default_values: defaultValues,
  };
};

/**
 * 素材位的中文显示名（字段键 → 名字），按族缓存一次。
 *
 * 为什么绕到族模板而不是直接读参数 schema 的 `label`：投影后的 `label` 是本地化键
 * （形如 `model-asset/<pkg>:fields.inputReference.label`），按「末段」取会把内部字段键
 * 当成显示名上屏（`inputReference` / `lastFrame`），契约要求这里是中文名、缺失给空串。
 * 解析实现只有参数描述符那一份（`collectMediaSlotOfficialFields`），这里复用，不另写。
 *
 * 模板是随代码固定的事实，缓存无需失效；一次构建只发生在该族首次投影时。
 */
const mediaSlotLabelsByFamily = new Map<string, ReadonlyMap<string, string>>();

const mediaSlotLabelsOf = (
  familyAdapterId: string,
  entry: Extract<GenerationFamilyTemplateEntry, { status: 'ready' }>,
): ReadonlyMap<string, string> => {
  const cached = mediaSlotLabelsByFamily.get(familyAdapterId);
  if (cached !== undefined) return cached;
  const labels = new Map<string, string>();
  const fields = collectMediaSlotOfficialFields(
    entry.buildBaseSources('catalog-media-labels', { acceptedMediaSlots: entry.supportsMediaSlots }),
    entry.mediaSlotFieldKeys,
  );
  for (const field of fields) {
    // 解析不到时 `collectMediaSlotOfficialFields` 回落字段键；契约口径是空串，交给消费端回退。
    if (field.label !== field.field_key) labels.set(field.field_key, field.label);
  }
  mediaSlotLabelsByFamily.set(familyAdapterId, labels);
  return labels;
};

/**
 * 媒体素材位投影：给 Editor 渲染「参考区用途」选项用。
 *
 * 事实源两处合一，都来自既有权威，不新建表：
 * - 位与字段键的对应：族模板注册表条目的 `mediaSlotFieldKeys`（各族的唯一跨族出口）；
 * - 记录实际启用了哪些位：记录上的 `accepted_media_slots`。
 *
 * 必填口径与 `parameter_schema.required_fields` 同源（某字段键在其中即 required），不另算一套。
 * 中文名取族模板的 zh-CN 本地化资源（与参数描述符共用同一份解析实现），解析不到给空串由
 * 消费端回退——不在后端硬编码中文，也不把本地化键末段（内部字段键）当显示名。
 */
const projectMediaSlots = (options: {
  familyAdapterId: string;
  acceptedMediaSlots: readonly string[];
  parameterSchema: ExecutableModelDirectoryEntry['parameter_schema'];
}): ExecutableCatalogMediaSlot[] => {
  const entry = getFamilyTemplate(options.familyAdapterId);
  if (entry === null || entry.status !== 'ready') return [];
  const labelsByFieldKey = mediaSlotLabelsOf(options.familyAdapterId, entry);
  const accepted = new Set(options.acceptedMediaSlots);
  const required = new Set(options.parameterSchema.required_fields);
  const byFieldKey = new Map(options.parameterSchema.fields.map((field) => [field.fieldKey, field]));
  const slots: ExecutableCatalogMediaSlot[] = [];
  for (const [slotId, fieldKey] of Object.entries(entry.mediaSlotFieldKeys)) {
    if (fieldKey === undefined || fieldKey.length === 0) continue;
    // 只下发记录实际勾选的位：未勾选的位不出现在用途候选里。
    if (!accepted.has(slotId)) continue;
    const field = byFieldKey.get(fieldKey);
    if (field === undefined) {
      // 族登记了位但该记录合成后的参数 schema 里没有对应字段：口径不一致，留痕并跳过，
      // 不下发一个点不出来的用途。
      loggingModule.logDebug('[model-catalog] media slot has no matching parameter field', {
        slotId,
        fieldKey,
      });
      continue;
    }
    const parsedSlotId = GenerationMediaSlotIdSchema.safeParse(slotId);
    if (!parsedSlotId.success) {
      loggingModule.logDebug('[model-catalog] drop media slot with unknown slot id', { slotId });
      continue;
    }
    const mediaKind = ((): 'image' | 'video' | 'audio' => {
      const component = field.component.toLowerCase();
      if (component === 'videoupload') return 'video';
      if (component === 'audioupload') return 'audio';
      return 'image';
    })();
    // 可放张数取该字段声明（多张参考位 > 1）；未声明按 1。
    const declaredMax = field.componentProps?.maxFiles;
    const maxFiles =
      typeof declaredMax === 'number' && Number.isFinite(declaredMax) && declaredMax >= 1
        ? Math.floor(declaredMax)
        : 1;
    slots.push({
      slotId: parsedSlotId.data,
      fieldKey,
      required: required.has(fieldKey),
      maxFiles,
      mediaKind,
      label: labelsByFieldKey.get(fieldKey) ?? '',
    });
  }
  return slots;
};

/**
 * 该模型当前可被选择的思考档位（spec 06「服务行的「思考」只列该模型在主窗口被启用的档位」）。
 *
 * 档位启用关系随自建对话模型记录走（spec 37 v4.0.0：原 ModelDeployment 上的档位字段已退役）；
 * 可表达性按**记录自带的协议**判定（2026-09-26 起协议归属模型级，协议创建后不可变，写入侧
 * 已按协议校验过可表达性——这里保留过滤作为读侧兜底，旧数据里协议表达不了的档位不外露）。
 * 「不思考」（`off`）恒定可用，不属于本字段。
 */
const resolveUsableThinkingTiers = (modelId: string): string[] => {
  const access: ActiveRouteTarget | null = resolveActiveTarget(modelId);
  if (!access) return [];
  const record = getCustomChatModel(modelId);
  if (!record) return [];
  const adapter = getAdapter(record.protocol_adapter_id);
  if (!adapter || adapter.family !== 'chat') return [];
  // 顺序即用户在记录上排的顺序（spec 37「思考档位」）：这里只过滤，不重排
  return record.enabled_thinking_tiers.filter((tier) =>
    canAdapterExpressThinkingTier(adapter, tier),
  );
};

/**
 * 该模型投影给创作面的默认档位（spec 37「思考档位」）。
 *
 * 只有落在**当前可选档位**内的默认值才投影出去：档位被摘掉之后，原默认档位可能已经
 * 发不出去，此时按「没有默认」处理，创作面因此不会预选一个发不出去的档位。
 */
const resolveUsableDefaultThinkingTier = (modelId: string, usableTiers: string[]): string | null => {
  const access: ActiveRouteTarget | null = resolveActiveTarget(modelId);
  if (!access) return null;
  const record = getCustomChatModel(modelId);
  if (!record) return null;
  const declared = record.default_thinking_tier;
  if (declared === null) return null;
  return usableTiers.includes(declared) ? declared : null;
};

/**
 * 把一个已装模型投影成目录条目；投影无法通过契约校验时返回 null（调用方跳过并已记日志）。
 *
 * 本函数不做「该模型属于哪个目录」的筛选：筛选由各端点自己负责。
 */
const buildCatalogEntry = (item: {
  modelId: string;
  projection: unknown;
  /**
   * 该模型的族适配器 id 与记录启用的素材位（可选）。
   *
   * 只有需要下发素材位清单时才传：对话目录也复用本函数，而对话模型没有素材位。
   * 不传即视为「无素材位」，输出空数组。
   */
  mediaSlotSource?: { familyAdapterId: string; acceptedMediaSlots: readonly string[] };
  /**
   * 记录合成失败的兜底原因码（可选）。
   *
   * 只在 `judgeExecutability` 判为可执行时生效：格式就绪、配方可解析，但投影构建失败
   * （记录被外部改坏）时用它把状态降级为 `deployment_invalid`，而不是让模型从目录里消失。
   * 更具体的原因（连接、凭证、格式缺失等）优先，不被覆盖。
   */
  executabilityFallback?: ExecutableModelFailureCode;
}): ExecutableModelDirectoryEntry | null => {
  const modelId = item.modelId;
  const projection = item.projection as {
    capability?: {
      input_modalities?: unknown;
      output_modalities?: unknown;
      supports_multi_image?: unknown;
      supports_reference_media?: unknown;
    };
    /** 运行时资产投影：默认任务类型用于 Hub 模型绑定页按用途分组 */
    runtime?: { default_task_type?: unknown; execution_driver?: unknown };
    /** 展示投影：排序权重用于 Hub 模型清单稳定排序 */
    visibility?: { order?: unknown };
  };
  const capability = projection.capability ?? {};
  const modality = (value: unknown): Array<'text' | 'image' | 'video' | 'audio'> => {
    if (!Array.isArray(value)) return [];
    return value.filter((v): v is 'text' | 'image' | 'video' | 'audio' => v === 'text' || v === 'image' || v === 'video' || v === 'audio');
  };
  const judged = judgeExecutability(modelId);
  const judgement: ExecutabilityJudgement =
    judged.failureCode === 'none' && item.executabilityFallback !== undefined
      ? { ...judged, deployable: false, failureCode: item.executabilityFallback }
      : judged;
  // 展示分组 / 排序取运行时资产已声明的投影值，不在消费端从模态反推、也不新增模型包字段。
  const defaultTaskType =
    typeof projection.runtime?.default_task_type === 'string' ? projection.runtime.default_task_type : '';
  const rawOrder = projection.visibility?.order;
  const displayOrder = typeof rawOrder === 'number' && Number.isFinite(rawOrder) ? rawOrder : undefined;
  // 参数 schema 只投影一次：素材位清单的必填判据与字段查找都消费同一份结果。
  const parameterSchema = projectParameterFields(item.projection);
  const candidate = {
    model_id: modelId,
    model_version: CATALOG_MODEL_VERSION,
    default_task_type: defaultTaskType,
    ...(displayOrder === undefined ? {} : { display_order: displayOrder }),
    capability: {
      input_modalities: modality(capability.input_modalities),
      output_modalities: modality(capability.output_modalities),
      supports_multi_image: capability.supports_multi_image === true ? true : undefined,
      supports_reference_media: capability.supports_reference_media === true ? true : undefined,
    },
    parameter_schema: parameterSchema,
    media_slots:
      item.mediaSlotSource === undefined
        ? []
        : projectMediaSlots({
            familyAdapterId: item.mediaSlotSource.familyAdapterId,
            acceptedMediaSlots: item.mediaSlotSource.acceptedMediaSlots,
            parameterSchema,
          }),
    deployment: {
      has_active_deployment: judgement.hasActiveDeployment,
      active_deployment_id: judgement.activeDeploymentId,
      deployable: judgement.deployable,
      failure_code: ExecutableModelFailureCodeSchema.parse(judgement.failureCode),
    },
  };
  const parsed = ExecutableModelDirectoryEntrySchema.safeParse(candidate);
  if (!parsed.success) {
    loggingModule.logDebug('[model-catalog] drop invalid catalog entry', {
      modelId,
      error: parsed.error.message,
    });
    return null;
  }
  return parsed.data;
};

/**
 * 对话目录条目：可执行目录条目 + 该模型的思考档位投影（spec 37「思考档位」）。
 *
 * 只有对话目录用本函数——档位是对话模型独有的维度；生成条目携带该字段会被
 * `ExecutableModelDirectoryEntrySchema` 的 strict 校验收掉。
 */
const buildChatCatalogEntry = (item: {
  modelId: string;
  projection: unknown;
}): ChatModelDirectoryEntry | null => {
  const base = buildCatalogEntry(item);
  if (base === null) return null;
  const thinkingTiers = resolveUsableThinkingTiers(item.modelId);
  const parsed = ChatModelDirectoryEntrySchema.safeParse({
    ...base,
    thinking_tiers: thinkingTiers,
    default_thinking_tier: resolveUsableDefaultThinkingTier(item.modelId, thinkingTiers),
  });
  if (!parsed.success) {
    loggingModule.logDebug('[model-catalog] drop invalid chat catalog entry', {
      modelId: item.modelId,
      error: parsed.error.message,
    });
    return null;
  }
  return parsed.data;
};

/**
 * 把用户自建对话模型投影成目录条目的输入形状（spec 37「对话模型的唯一来源」）。
 *
 * 自建模型没有模型能力包，能力按纯文本对话缺省：输入输出模态都只有文本，无生成参数、
 * 无媒体准备（因此不参与 public relay 路由）。上下文窗口不从投影读——执行链直接读声明本身，
 * 本投影只承载「它是个对话模型」这一件事，避免同一值出现第二个读取点。
 */
const projectCustomChatModelToCatalogItem = (model: {
  model_id: string;
}): { modelId: string; projection: unknown } => ({
  modelId: model.model_id,
  projection: {
    capability: {
      input_modalities: ['text'],
      output_modalities: ['text'],
    },
    runtime: {
      execution_driver: CHAT_STREAMING_DRIVER,
      default_task_type: 'text',
    },
    parameter_schema: { fields: [], required_fields: [] },
  },
});

/**
 * 可执行目录条目列表（spec 45 §1/§3、spec 03 §6.1/PC-15）：呈现哪些模型只有一个来源——
 * **用户模型记录 × 该接口格式的合成投影**。软件不内置任何具体模型，因此本函数不扫描模型包
 * 目录、也不按 `model_id` 名称/正则推断族归属（AGENTS.md「禁止按名称推断适配器」）。
 *
 * 2026-10-27 起**记录一律进目录**，可执行性只由 `deployable` + `failure_code` 表达：
 * 格式被删除或未就绪时记录仍在列表里，状态显式标为 `format_missing` / `format_not_ready`，
 * 用户能看到「哪条模型挂了、去哪修」——此前这类记录被整条跳过，界面只剩「状态未知」。
 * 这类条目没有参数表单与传输规则，因此 capability / parameter_schema 为空投影，`deployable`
 * 恒为 false，PromptDock 据此禁用并展示原因。
 *
 * 「没有记录就没有模型」：目录为空即模型为空，不存在任何绕过记录进入目录的路径。
 *
 * 消费方：GET /api/executable-model-catalog 路由与 agent 工具注册表（同一投影，不复制过滤口径）。
 */
const EMPTY_DECLARATION_PROJECTION = {
  capability: { input_modalities: [], output_modalities: [] },
  runtime: { default_task_type: '' },
  parameter_schema: { fields: [], required_fields: [] },
} as const;

const listExecutableCatalogEntries = (): ExecutableModelDirectoryEntry[] => {
  const entries: ExecutableModelDirectoryEntry[] = [];
  for (const record of listCustomGenerationModels()) {
    const mediaSlotSource = {
      familyAdapterId: record.family_adapter_id,
      acceptedMediaSlots: record.accepted_media_slots,
    };
    // 格式就绪是合成前提（契约值域已保证 family_adapter_id 合法，这里只判就绪与否）。
    const template = getFamilyTemplate(record.family_adapter_id);
    if (template === null || template.status !== 'ready') {
      loggingModule.logDebug('[model-catalog] include record whose family template is not ready (marked invalid)', {
        modelId: record.model_id,
        familyAdapterId: record.family_adapter_id,
        templateStatus: template === null ? 'unknown' : template.status,
      });
      const entry = buildCatalogEntry({
        modelId: record.model_id,
        projection: EMPTY_DECLARATION_PROJECTION,
        mediaSlotSource,
      });
      if (entry !== null) entries.push(entry);
      continue;
    }
    const built = buildDeclaredGenerationProjection(record);
    if (built === null) {
      // 格式就绪但投影构建失败：记录被外部改坏，仍进目录并标为配置不完整，不让它静默消失。
      const entry = buildCatalogEntry({
        modelId: record.model_id,
        projection: EMPTY_DECLARATION_PROJECTION,
        mediaSlotSource,
        executabilityFallback: 'deployment_invalid',
      });
      if (entry !== null) entries.push(entry);
      continue;
    }
    const entry = buildCatalogEntry({
      modelId: record.model_id,
      projection: built.projection,
      mediaSlotSource,
    });
    if (entry !== null) entries.push(entry);
  }
  return entries;
};

export { buildCatalogEntry, buildChatCatalogEntry, projectCustomChatModelToCatalogItem, listExecutableCatalogEntries };

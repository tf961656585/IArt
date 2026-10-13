import {
  ChatModelDirectoryEntrySchema,
  ExecutableModelDirectoryEntrySchema,
  ExecutableModelFailureCodeSchema,
  canAdapterExpressThinkingTier,
  type ChatModelDirectoryEntry,
  type ExecutableModelDirectoryEntry,
  type ExecutableModelFailureCode,
} from '@iart/contracts';
import * as loggingModule from './logging.cts';
import { expandVariantGroupMembers, listBindableModelProjections } from './model-package-catalog.cts';
import {
  resolveModelFamilyAdapter,
  type ClosedFamilyAdapterId,
  type DeclaredGenerationFamily,
} from './model-family-registry.cts';
import { listCustomGenerationModels } from './provider-connection/custom-generation-model-store.cts';
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
 * active 目标是「接入记录」双查形态（已装包 deployment 或自建模型记录，见
 * active-route-store）：两类记录投影为同一形状后走同一套连接/凭证/适配器判定。
 * 协议由模型自带（2026-09-26 起协议归属模型级；2026-09-29 起连接不再承载接口类型预选）：
 * 自建记录携带协议字段、已装包模型在 active-route 解析时按正则表回填；记录无协议即判
 * adapter_missing——连接遗留键不再是协议来源。
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
  const protocolAdapterId = access.protocol_adapter_id;
  const adapter = protocolAdapterId ? getAdapter(protocolAdapterId) : null;
  if (!adapter) {
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
  const judgement = judgeExecutability(modelId);
  // 展示分组 / 排序取运行时资产已声明的投影值，不在消费端从模态反推、也不新增模型包字段。
  const defaultTaskType =
    typeof projection.runtime?.default_task_type === 'string' ? projection.runtime.default_task_type : '';
  const rawOrder = projection.visibility?.order;
  const displayOrder = typeof rawOrder === 'number' && Number.isFinite(rawOrder) ? rawOrder : undefined;
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
    parameter_schema: projectParameterFields(item.projection),
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
 * 可执行目录条目列表（spec 45 §1/§3）：只呈现已闭合生成族的模型——Seedance 2.5 契约未闭合、
 * 非生成族（TTS / 文本等）不进可提交目录。对话模型（用户自建声明）不走本入口。
 *
 * 变体组壳先展开为成员 model_id 条目（expandVariantGroupMembers）：闭合族判定按成员身份
 * 进行，组内闭合成员各自成为独立条目，组壳身份不作为可执行条目输出。
 *
 * 消费方：GET /api/executable-model-catalog 路由与 agent 工具注册表（同一投影，不复制过滤口径）。
 */
const isSeedance25 = (modelId: string): boolean =>
  /^doubao-seedance-2-5/i.test(modelId) || /seedance[-_.]?2[-_.]?5/i.test(modelId);

/** 「model_id → 声明族」映射（族常量事实源仍是 model-family-registry，声明查询经注入接入）。 */
const buildDeclaredGenerationFamily = (): DeclaredGenerationFamily => {
  const declared = new Map<string, ClosedFamilyAdapterId>();
  for (const model of listCustomGenerationModels()) {
    declared.set(model.model_id, model.family_adapter_id);
  }
  return declared;
};

const listExecutableCatalogEntries = (): ExecutableModelDirectoryEntry[] => {
  const entries: ExecutableModelDirectoryEntry[] = [];
  const declaredGenerationFamily = buildDeclaredGenerationFamily();
  for (const item of expandVariantGroupMembers(listBindableModelProjections({ baseDir: undefined }))) {
    const modelId = item.modelId;
    if (!modelId) continue;
    if (isSeedance25(modelId)) {
      loggingModule.logDebug('[model-catalog] exclude Seedance 2.5 (contract not closed)', { modelId });
      continue;
    }
    // 族判定两来源（生成模型自建声明试点 §3.5）：正则命中（已装包）优先，其次声明族——
    // 自建生成模型的合成投影经目录第二来源进入本循环，靠声明族通过闭合族筛选。
    if (!resolveModelFamilyAdapter(modelId, declaredGenerationFamily)) {
      // 非四类已闭合能力的模型（TTS / 对话 / 其他）不进通用 Provider 可提交目录。
      loggingModule.logDebug('[model-catalog] skip model outside closed family', {
        modelId,
      });
      continue;
    }
    const entry = buildCatalogEntry(item);
    if (entry !== null) entries.push(entry);
  }
  return entries;
};

export { buildCatalogEntry, buildChatCatalogEntry, projectCustomChatModelToCatalogItem, listExecutableCatalogEntries };

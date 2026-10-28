import type {
  FamilyTemplateParameterDescriptor,
  GenerationMediaSlotId,
  InterfaceRecipe,
  ParameterOverrides,
} from '@iart/contracts';
import { listInterfaceFormats } from '../provider-connection/interface-format-store.cts';
import { buildFamilyTemplateParameterDescriptorFromSources } from '../generation-family-templates.cts';
import type { GenerationFamilyTemplateSources } from '../generation-family-templates.cts';
import { isObjectRecord } from '../model-package-catalog.shared.cts';
import type { JsonObject } from '../model-package-catalog.types.cts';
import * as loggingModule from '../logging.cts';
import { composeInterfaceFormatSources } from './compose.cts';
import manifestJson from './presets/manifest.json';
import geminiImageInteractionsV1Json from './presets/gemini-image-interactions-v1.json';
import klingImage2VideoV1Json from './presets/kling-image2video-v1.json';
import klingOmniVideoV1Json from './presets/kling-omni-video-v1.json';
import klingText2VideoV1Json from './presets/kling-text2video-v1.json';
import openAiImageV1Json from './presets/openai-image-v1.json';
import openAiVideoV1Json from './presets/openai-video-v1.json';
import seedance20V1Json from './presets/seedance-2-0-v1.json';
import veoV1Json from './presets/veo-v1.json';
import { InterfaceFormatManifestSchema, InterfaceFormatSchema, type InterfaceFormat } from './schema.cts';

/**
 * 接口格式预设的加载与分发（**运行时唯一事实源**；2026-10-26 起接入生产）。
 *
 * 2026-10-26 批次 B5a 起本模块同时承载**用户自建格式**的合并：`loadPresetFormats()` 仍只返回
 * 随软件分发的 8 条预设（矩阵/等价测试以此为基准），`loadUserFormats()` 读用户库，
 * `loadAllFormats()` 把两者按 `order` 升序合并（id 冲突预设优先）。生产查询入口
 * （`getInterfaceFormat` / `composeFormatSources` / `buildFormatParameterDescriptor`）一律走
 * `loadAllFormats()`，因此用户格式与预设对消费方没有区别。
 *
 * 生产消费方经 `generation-family-templates.registry.cts` 这个门面访问本模块（导出名与形状
 * 保持旧注册表不变）；门面之外不得再有一份「接口类型 → 协议语义」的
 * 代码实现。
 *
 * 为什么预设用静态 `import` 而不是运行时读文件：
 * - 后端构建是纯 `tsc`。`resolveJsonModule` 下被 import 的 JSON 会随编译产物一起落到
 *   `apps/backend/dist`（本批已实测，见交接说明），因此不需要额外的构建拷贝步骤；
 * - 运行时 `readFileSync(__dirname/...)` 依赖目录布局与打包形态，属于「产物形态类改动」，
 *   需要真实消费者跑一次才可信。静态 import 把「文件存在」交给编译期。
 *
 * manifest 仍是格式注册与加载顺序的唯一事实源：`PRESET_MODULE_MAP` 只负责「按 id 找到那份
 * JSON」，逐条 `safeParse` 失败即丢弃该条并留痕（不因一份坏预设整族不可用），manifest 与
 * 预设声明的 `format_id` / `order` 不一致同样丢弃并留痕。
 */

/**
 * 预置 id → 随软件分发的只读 JSON 模块（safeParse 前的原始形状）。
 *
 * 命名表达边界：这里承载的是**未校验的 JSON 模块**，形状由各自的预设 schema 裁定，
 * 本层不做字段建模（`*Map` 后缀是稳定业务类型门禁认可的开放结构命名）。
 */
type PresetModuleMap = Record<string, unknown>;

/** 预置 id → 随软件分发的只读 JSON（新增格式时同时登记 manifest 与这里）。 */
const PRESET_MODULE_MAP: Readonly<PresetModuleMap> = {
  'openai-image-v1': openAiImageV1Json,
  'openai-video-v1': openAiVideoV1Json,
  'gemini-image-interactions-v1': geminiImageInteractionsV1Json,
  'seedance-2-0-v1': seedance20V1Json,
  'veo-v1': veoV1Json,
  'kling-text2video-v1': klingText2VideoV1Json,
  'kling-image2video-v1': klingImage2VideoV1Json,
  'kling-omni-video-v1': klingOmniVideoV1Json,
};

/**
 * 参数描述符基线用的合成模型 id（与既有族实现同值）。
 *
 * 描述符里不含 model_id，用固定基线 id 是为了让「描述符与记录无关」这件事在合成期可见：
 * 任何与 model_id 相关的差异都会在等价性测试里变成红灯。
 */
const DESCRIPTOR_BASELINE_MODEL_ID = 'descriptor-baseline';

let cachedPresetFormats: readonly InterfaceFormat[] | null = null;

/**
 * 加载全部预置格式（单条失败即丢弃该条并 debug 留痕）。
 *
 * 失败原因分三类且都留痕：模块未打包、schema 不合规、manifest 与预设声明不一致。
 * 静默丢弃会让「某格式在界面上不存在」变成无法解释的现象（条件跳过必须留痕）。
 */
export const loadPresetFormats = (): readonly InterfaceFormat[] => {
  if (cachedPresetFormats !== null) return cachedPresetFormats;
  const manifest = InterfaceFormatManifestSchema.parse(manifestJson);
  const loaded: InterfaceFormat[] = [];
  for (const entry of manifest.formats) {
    const presetModule = PRESET_MODULE_MAP[entry.format_id];
    if (presetModule === undefined) {
      loggingModule.logDebug('[interface-format] preset module not bundled, skipped', {
        formatId: entry.format_id,
        file: entry.file,
      });
      continue;
    }
    const parsed = InterfaceFormatSchema.safeParse(presetModule);
    if (!parsed.success) {
      loggingModule.logDebug('[interface-format] preset failed schema validation, skipped', {
        formatId: entry.format_id,
        file: entry.file,
        issues: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
      });
      continue;
    }
    if (parsed.data.format_id !== entry.format_id || parsed.data.order !== entry.order) {
      loggingModule.logDebug('[interface-format] preset identity mismatch with manifest, skipped', {
        formatId: entry.format_id,
        manifestOrder: entry.order,
        presetFormatId: parsed.data.format_id,
        presetOrder: parsed.data.order,
      });
      continue;
    }
    loaded.push(parsed.data);
  }
  cachedPresetFormats = loaded;
  return loaded;
};

/**
 * 加载用户自建格式（`config/interface-formats.json`，2026-10-26 批次 B5a）。
 *
 * 用户库与预设**物理分离**：预设随软件分发、只读；用户格式由 Hub 提交草稿经
 * `draft-synthesis.cts` 合成后落在本机配置。本函数只做读取与排序，不做过滤——
 * 坏条丢弃与 `origin/status` 归一在 store 的读盘路径里（唯一实现）。
 *
 * 不在这里再缓存一份：store 自身已缓存，重复缓存会让「写入后读到的还是旧集合」变成
 * 一个需要额外失效回调才能修好的陷阱。
 */
export const loadUserFormats = (): readonly InterfaceFormat[] =>
  [...listInterfaceFormats()].sort((left, right) => left.order - right.order);

/**
 * 加载全部格式（预设 + 用户），按 `order` 升序。
 *
 * id 冲突时**预设优先**并留痕：预设是随软件分发的只读事实，用户库出现同名 id 属于
 * 磁盘被手工改写，此时让用户条遮蔽内置格式会让内置能力整体消失。
 */
export const loadAllFormats = (): readonly InterfaceFormat[] => {
  const presets = loadPresetFormats();
  const presetIds = new Set(presets.map((format) => format.format_id));
  const users = loadUserFormats().filter((format) => {
    if (!presetIds.has(format.format_id)) return true;
    loggingModule.logDebug('[interface-format] user format id conflicts with preset, preset wins', {
      formatId: format.format_id,
    });
    return false;
  });
  return [...presets, ...users].sort(
    (left, right) => left.order - right.order || left.format_id.localeCompare(right.format_id),
  );
};

/** 按 id 查格式：未知 id（未登记）与 pending（登记但未就绪）必须可区分。 */
export type InterfaceFormatLookupResult =
  | { kind: 'ready'; format: InterfaceFormat }
  | { kind: 'pending'; formatId: string }
  | { kind: 'unknown' };

export const getInterfaceFormat = (formatId: string): InterfaceFormatLookupResult => {
  const format = loadAllFormats().find((item) => item.format_id === formatId);
  if (format === undefined) return { kind: 'unknown' };
  if (format.status === 'pending') return { kind: 'pending', formatId: format.format_id };
  return { kind: 'ready', format };
};

/** 合成格式 sources 的记录侧输入（与 `GenerationFamilyTemplateOptions` 同形）。 */
export type InterfaceFormatSourcesOptions = {
  acceptedMediaSlots: readonly GenerationMediaSlotId[];
  parameterOverrides?: ParameterOverrides;
  recipe?: InterfaceRecipe | null;
};

/** 格式 sources 的合成结果（与族模板注册表同构的错误分支，不回落任何别的格式）。 */
export type ComposeFormatSourcesResult =
  | { kind: 'ready'; formatId: string; sources: GenerationFamilyTemplateSources }
  | { kind: 'pending'; formatId: string }
  | { kind: 'unknown' }
  | {
      kind: 'unsupported_media_slots';
      formatId: string;
      unsupportedMediaSlots: readonly GenerationMediaSlotId[];
    };

/**
 * 合成一份格式的 sources。
 *
 * 素材位越界不抛错而是显式返回 `unsupported_media_slots`：调用方（写入侧守卫 / 投影侧过滤）
 * 需要「拒绝了哪几位」这个信息来留痕与提示，抛错会把它压成一句字符串。
 */
export const composeFormatSources = (
  formatId: string,
  modelId: string,
  options: InterfaceFormatSourcesOptions,
): ComposeFormatSourcesResult => {
  const lookup = getInterfaceFormat(formatId);
  if (lookup.kind !== 'ready') return lookup;
  const supported = new Set<string>(lookup.format.media.supports);
  const unsupportedMediaSlots = options.acceptedMediaSlots.filter((slotId) => !supported.has(slotId));
  if (unsupportedMediaSlots.length > 0) {
    loggingModule.logDebug('[interface-format] media slots not expressible by the format, refused', {
      formatId: lookup.format.format_id,
      modelId,
      acceptedMediaSlots: options.acceptedMediaSlots,
      supportsMediaSlots: lookup.format.media.supports,
    });
    return {
      kind: 'unsupported_media_slots',
      formatId: lookup.format.format_id,
      unsupportedMediaSlots,
    };
  }
  return {
    kind: 'ready',
    formatId: lookup.format.format_id,
    sources: composeInterfaceFormatSources({
      format: lookup.format,
      modelId,
      acceptedMediaSlots: options.acceptedMediaSlots,
      ...(options.parameterOverrides === undefined
        ? {}
        : { parameterOverrides: options.parameterOverrides }),
      ...(options.recipe === undefined ? {} : { recipe: options.recipe }),
    }),
  };
};

/** 格式参数描述的读取结果（未知 id 与未就绪格式必须可区分）。 */
export type InterfaceFormatParameterDescriptorResult =
  | { kind: 'ready'; formatId: string; descriptor: FamilyTemplateParameterDescriptor }
  | { kind: 'pending'; formatId: string }
  | { kind: 'unknown' };

/**
 * 格式参数描述（等价于今天逐族的 `build<Family>ParameterDescriptor()`）。
 *
 * 复用族模板注册表的通用构建器：描述符的字段/保留键/文案解析口径只有一份实现。差异只在
 * 「输入从哪来」——这里是格式实体合成出的 sources，而不是一族一份的 TypeScript 工厂。
 *
 * 保留键必须并入**其余请求分支**：基线是「不接受任何素材位」的形态，但声明可能接受素材位，
 * 那些分支里出现的发出键（如 `image`）同样不能被参数编辑器占用。推导方式是**全部素材位同时
 * 接受**的一份 sources 取其 payload_rules——各族的专属构建器用的就是这一形态
 * （`buildPayloadRules(ALL_ACCEPTED_SLOTS)`）。逐位单独合成再取并集不等价：聚合族里只在
 * 「多位同时在场」时出现的规则键会漏掉（必选位族还需把 `required` 一并带上）。
 *
 * 描述符的**形状与族专属构建器完全一致**：素材位行与 `supports_media_slots` /
 * `required_media_slots` 由族模板注册表的分发处统一补填（单源填充），本函数不在这里再填一遍，
 * 否则同一份描述符会出现两个不同形状。
 */
export const buildFormatParameterDescriptor = (
  formatId: string,
): InterfaceFormatParameterDescriptorResult => {
  const lookup = getInterfaceFormat(formatId);
  if (lookup.kind !== 'ready') return lookup;
  const format = lookup.format;
  const baselineSources = composeInterfaceFormatSources({
    format,
    modelId: DESCRIPTOR_BASELINE_MODEL_ID,
    acceptedMediaSlots: [],
  });
  // 全部素材位同时接受的形态：一个素材位都没有的格式退化为基线本身。
  const allSlotsSources =
    format.media.supports.length === 0
      ? baselineSources
      : composeInterfaceFormatSources({
          format,
          modelId: DESCRIPTOR_BASELINE_MODEL_ID,
          acceptedMediaSlots: format.media.supports,
        });
  const extraPayloadRuleSets: JsonObject[] = [];
  const allSlotsRuntime = allSlotsSources.runtimeModel.runtime;
  if (isObjectRecord(allSlotsRuntime) && isObjectRecord(allSlotsRuntime.payload_rules)) {
    extraPayloadRuleSets.push(allSlotsRuntime.payload_rules);
  }
  return {
    kind: 'ready',
    formatId: format.format_id,
    descriptor: buildFamilyTemplateParameterDescriptorFromSources({
      familyAdapterId: format.format_id,
      baselineSources,
      extraPayloadRuleSets,
    }),
  };
};

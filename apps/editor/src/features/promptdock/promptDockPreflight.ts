import type { ProjectMediaAssets } from '@iart/contracts';
import type { PromptDockCatalogEntry } from '@/client/api/promptDockApi';
import type {
  PromptDockAgentSelection,
  PromptDockDraft,
  PromptDockForm,
  PromptDockPreflightIssue,
  PromptDockPreflightResult,
} from './PromptDock.types';
import { useCanvasStore } from '@/features/canvas/store/canvasStore';
import { usePromptDockStore } from './promptDockStore';
import { listPromptPresetTokenMatches } from '@/features/canvas/nodes/textInput/enhancedTextNode';
import { deploymentFailureExit, describeDeploymentFailure } from './deploymentFailureText';
import { collectSlotProblems } from './referenceSlotModel';

/**
 * PromptDock 提交前置校验（spec docs/editor/节点执行前置校验.md）。
 *
 * 校验在提交现场同步执行：任一不通过即阻断，不提交、无持久化副作用，反馈定位到问题输入。
 * 校验项集合封闭（新增须先修订 spec）：
 * - 必需输入未提供（prompt 为空且参考区无引用）
 * - prompt 内联预设 token 失效（快照缺失、预设内容为空）
 * - 引用资产不可用（画布媒体资产已被移除）
 * - 必需参数缺失或非法
 * - active deployment 不可执行（deployment.deployable === false，附深链 Hub 修复入口）
 * - 参考引用与当前模型不兼容（模型能力不支持该媒体类型输入）
 *
 * 形态差异（spec docs/agent/06）：agent 形态不承载参数与任务数，第 5 项只在生成式形态执行；
 * 模型可用性（第 4 项）在两种形态下同源判定——agent 用对话模型目录条目，生成式用可执行目录条目。
 *
 * 注意：active deployment 可执行性由 Runtime Backend 经目录投影（deployment.deployable）下发，
 * Editor 不自行解析连接/凭证/适配器/remote_model_id（模型真相由 Runtime Backend 分发）。
 */

/** 媒体类型的用户词汇（image/video/audio 是内部标识，不上界面）。 */
const MEDIA_TYPE_USER_LABEL: Record<'image' | 'video' | 'audio', string> = {
  image: '图片',
  video: '视频',
  audio: '音频',
};

const isMediaTypeSupportedByModel = (
  entry: PromptDockCatalogEntry,
  mediaType: 'image' | 'video' | 'audio',
): boolean =>
  entry.capability.input_modalities.includes(mediaType) ||
  entry.capability.supports_reference_media === true;

/**
 * 执行 PromptDock 提交前置校验。
 *
 * @param draft 当前草稿
 * @param entry 当前所选 model_id 的目录条目；null 表示目录未加载或 model_id 不在可执行目录
 * @param mediaAssets 画布媒体资产注册表（判定引用是否仍可用）
 * @param form 当前创作形态（默认生成式）
 * @param agent agent 形态的形态配置（所选对话模型 + 思考档位）；agent 形态下必传
 */
export const runPromptDockPreflight = (
  draft: PromptDockDraft,
  entry: PromptDockCatalogEntry | null | undefined,
  mediaAssets: Readonly<ProjectMediaAssets>,
  form: PromptDockForm = 'generate',
  agent: PromptDockAgentSelection | undefined = undefined,
): PromptDockPreflightResult => {
  const issues: PromptDockPreflightIssue[] = [];
  const isAgentForm = form === 'agent';
  const agentModelId = isAgentForm ? agent?.modelId ?? null : null;
  const agentEntry = agentModelId === null ? null : entry ?? null;

  // 1. 必需输入未提供
  const prompt = draft.prompt.trim();
  const hasReference = draft.references.length > 0;
  if (!prompt && !hasReference) {
    issues.push({
      code: 'required-input-missing',
      message: '请填写提示词或添加参考素材后再提交。',
      field: null,
      exit: null,
    });
  }

  // 2. prompt 内联预设 token 失效
  // 失效判定以 docs/editor/prompt内联交互.md「失效语义」为唯一口径：快照缺失或内容为空
  // 即失效；同一预设出现多次只提醒一次，界面 token 失效态已定位到位置。
  const invalidPresetIds = new Set<string>();
  for (const token of listPromptPresetTokenMatches(draft.prompt)) {
    const snapshot = draft.promptPresetSnapshots?.[token.presetId];
    if (!snapshot || snapshot.content.length === 0) invalidPresetIds.add(token.presetId);
  }
  for (const presetId of invalidPresetIds) {
    const name = draft.promptPresetSnapshots?.[presetId]?.name;
    issues.push({
      code: 'preset-token-invalid',
      message: name
        ? `提示词里的预设「${name}」已失效，删掉后重新插入。`
        : '提示词里有预设已失效，删掉后重新插入。',
      field: presetId,
      exit: null,
    });
  }

  // 3. 引用资产不可用
  for (const ref of draft.references) {
    if (!(ref.assetId in mediaAssets)) {
      issues.push({
        code: 'reference-unavailable',
        message: '参考素材已被移除，请移除这条参考后重试。',
        field: ref.assetId,
        exit: null,
      });
    }
  }

  // 4. agent 形态：语言模型可用性；生成式形态：模型未选择 / active deployment 不可执行。
  //    agent 的模型来自对话模型目录，可用性与失效原因与生成式同源（Runtime Backend 投影的
  //    deployment.deployable / failure_code），Editor 不自行解析连接、凭证与适配器。
  if (isAgentForm) {
    if (agentModelId === null) {
      issues.push({
        code: 'deployment-not-executable',
        message: '还没有可用的模型：到主窗口「设置 → 服务商与模型」添加。',
        field: null,
        exit: 'hub-providers',
      });
    } else if (!agentEntry) {
      issues.push({
        code: 'deployment-not-executable',
        message: '这个模型在服务商那边找不到了，请重新选择。',
        field: null,
        exit: null,
      });
    } else if (agentEntry.deployment.deployable !== true) {
      issues.push({
        code: 'deployment-not-executable',
        message: describeDeploymentFailure(agentEntry.deployment.failure_code),
        field: null,
        exit: deploymentFailureExit(agentEntry.deployment.failure_code),
      });
    }
  } else if (!entry) {
    issues.push({
      code: 'deployment-not-executable',
      message: '请选择可用的模型后再提交。',
      field: null,
      exit: null,
    });
  } else if (entry.deployment.deployable !== true) {
    issues.push({
      code: 'deployment-not-executable',
      message: describeDeploymentFailure(entry.deployment.failure_code),
      field: null,
      exit: deploymentFailureExit(entry.deployment.failure_code),
    });
  }

  // 5. 必需参数缺失或非法（仅生成式：agent 形态不承载参数）
  // prompt 已从模型能力包 parameter_schema 中剥离（保留键 `__prompt` 只存在于参数合并空间），
  // required_fields / fields 不再出现 prompt，无需排除。提示词空值由第 1 步统一校验。
  if (!isAgentForm && entry) {
    for (const requiredKey of entry.parameter_schema.required_fields) {
      const value = draft.arguments[requiredKey];
      if (value === undefined || value === null || value === '') {
        issues.push({
          code: 'required-param-missing',
          // 具体是哪个必填项由 UI 层按参数界面标签渲染「请补上「X」再提交」
          //（preflight 保持纯函数，不依赖 i18n / React）；本 message 只在界面
          // 拿不到字段标签时兜底，仍指向可行动的参数区域，不带内部 key。
          message: '还有必填项没有填写，请打开「完整参数」补充后再提交。',
          field: requiredKey,
          exit: null,
        });
      }
    }
  }

  // 6. 参考引用与当前模型不兼容（生成式按生成能力；agent 按语言模型的输入模态，spec 04
  //    「Editor 验证 agent 会话所选语言模型的可用性与兼容性」）
  if (entry) {
    for (const ref of draft.references) {
      if (!isMediaTypeSupportedByModel(entry, ref.mediaType)) {
        issues.push({
          code: 'incompatible-reference',
          message: `这个模型用不了${MEDIA_TYPE_USER_LABEL[ref.mediaType]}参考素材，请移除后再提交。`,
          field: ref.assetId,
          exit: null,
        });
      }
    }
  }

  // 7. 参考图用途（设计 docs/editor/PromptDock参考区用途标注-design.md §6）
  //
  // 这条判据取代了「参数值为空」那条对空数组天然失效的旧判据：必填素材位是否有图占用、
  // 是否存在没指定用途的图，两者都只看草稿的参考条目与模型下发的素材位清单。
  if (!isAgentForm && entry) {
    for (const problem of collectSlotProblems(draft.references, entry)) {
      if (problem.kind === 'required-slot-empty') {
        issues.push({
          code: 'slot-required-empty',
          message: `还没有指定「${problem.label}」用哪张图。`,
          field: problem.fieldKey,
          exit: null,
        });
      } else {
        issues.push({
          code: 'slot-unspecified',
          message: `还有图没指定用途，请为「${problem.label}」选一个用途。`,
          field: problem.refId,
          exit: null,
        });
      }
    }
  }

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true };
};

/** 便捷读取：对当前 store 草稿与画布媒体资产执行校验（形态与 agent 形态配置取自 store）。 */
export const runPromptDockPreflightFromStore = (
  draft: PromptDockDraft,
  entry: PromptDockCatalogEntry | null | undefined,
): PromptDockPreflightResult => {
  const mediaAssets = useCanvasStore.getState().mediaAssets ?? {};
  const state = usePromptDockStore.getState();
  return runPromptDockPreflight(draft, entry, mediaAssets, state.form, state.agentSelection);
};

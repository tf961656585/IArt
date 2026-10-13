import type { NodeDefinition } from '../registry';
import type { NodeSize } from '../../types/node';

/**
 * 任务节点工厂（Todo 6）。
 *
 * 任务节点是 RuntimeTask 的画布投影（spec PromptDock生成主链.md / 固定任务数批次提交与投影语义）。
 * 它不可由用户在节点面板/快捷添加创建（palette.visible=false），唯一创建触发事实是
 * GenerationBatch 提交受理响应（taskProjectionService）；后续通知/snapshot/storage read
 * 只 O(1) 更新既有投影，绝不凭 taskId 创建节点。
 */

/**
 * 任务节点孵化胚胎态默认尺寸（docs/editor/visual-design.md §5.4：孵化面 = 资产节点
 * 同款媒体表面，image 3:2 基准 240×160；成功 morph 后资产节点 240×180 同源继承）。
 */
export const TASK_NODE_DEFAULT_SIZE: NodeSize = { width: 240, height: 160 };

export const TASK_NODE_LABEL = '任务';

const baseOptionalFields = {
  defaultSize: undefined as NodeSize | undefined,
  sizeStrategy: undefined as NodeDefinition['sizeStrategy'],
  modelId: undefined as string | undefined,
  providerId: undefined as string | undefined,
  groupId: undefined as string | undefined,
  bundle: undefined as NodeDefinition['bundle'],
  palette: undefined as NodeDefinition['palette'],
  companions: undefined as NodeDefinition['companions'],
  variantGroup: undefined as NodeDefinition['variantGroup'],
} as const;

export const taskNodeDefinition: NodeDefinition = {
  ...baseOptionalFields,
  type: 'task',
  label: TASK_NODE_LABEL,
  description: '正在生成的占位节点，完成后会变成素材',
  category: 'flow',
  icon: 'loader',
  defaultData: {
    label: TASK_NODE_LABEL,
    modelId: '',
    taskId: '',
    taskIndex: 0,
    batchId: '',
    status: 'submitting',
    progressPercent: null,
    progressPhase: null,
    errorMessage: null,
    failure: null,
    createdAt: 0,
    updatedAt: 0,
  },
  defaultSize: TASK_NODE_DEFAULT_SIZE,
  sizeStrategy: { mode: 'static' },
  deletable: true,
  copyable: false,
  color: '#6366f1',
  executable: false,
  palette: { visible: false },
};

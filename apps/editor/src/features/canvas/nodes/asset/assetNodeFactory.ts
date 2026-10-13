import type { NodeDefinition } from '../registry';
import type { NodeSize } from '../../types/node';

/**
 * 资产节点工厂（Todo 6）。
 *
 * 资产节点是正式资产的画布投影（成功任务原地 morph / 邻近落位）。
 * 不可由用户在节点面板/快捷添加创建（palette.visible=false）；资产节点由任务投影
 * 终态 morph 创建（taskProjectionService），或从持久化节点恢复（项目重开）。
 * 资产节点保留来源关联（sourceBatchId/sourceTaskId/sourceModelId）以支持溯源与「复用」。
 */

export const ASSET_NODE_DEFAULT_SIZE: NodeSize = { width: 240, height: 180 };

export const ASSET_NODE_LABEL = '资产';

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

export const assetNodeDefinition: NodeDefinition = {
  ...baseOptionalFields,
  type: 'asset',
  label: ASSET_NODE_LABEL,
  description: '生成完成的素材',
  category: 'utility',
  icon: 'image',
  defaultData: {
    label: ASSET_NODE_LABEL,
    sourceBatchId: '',
    sourceTaskId: '',
    sourceModelId: '',
    mediaType: 'image',
    assetId: '',
  },
  defaultSize: ASSET_NODE_DEFAULT_SIZE,
  sizeStrategy: { mode: 'layoutModel' },
  deletable: true,
  copyable: false,
  color: '#22c55e',
  executable: false,
  palette: { visible: false },
};

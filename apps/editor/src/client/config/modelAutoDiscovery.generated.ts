// @generated
// 本文件由 tooling/scripts/generate-model-auto-discovery.ts 自动生成，请勿手动修改。
// 如需更新，请运行：pnpm generate:model-discovery

import type { ModelDefinition } from '@/features/models/modelDefinition';

type ModelModule = { MODEL_DEFINITION: ModelDefinition | undefined };

export const modelLoaders: Array<{ key: string; loader: () => Promise<ModelModule> }> = [
  { key: 'edge-detect', loader: () => import('@/features/models/processors/local/edge-detect/index') }
];

import type { UNIFIED_GENERATION_STATUSES } from '@iart/contracts/unified-generation';
import type { GenerationTaskPayload, GenerationTaskResult } from './generation';

export type TaskStatus = (typeof UNIFIED_GENERATION_STATUSES)[number];

export interface Task {
  id: string;
  requestId: string | undefined;
  statusUrl: string | undefined;
  status: TaskStatus;
  model: string;
  prompt: string | undefined;
  payload: GenerationTaskPayload | undefined;
  createdAt: number;
  updatedAt: number;
  submittedAt: number | undefined;
  startedAt: number | undefined;
  finishedAt: number | undefined;
  result: GenerationTaskResult | undefined;
  error: string | undefined;
  progress: number | undefined;
  metadata: {
    previewNodeId: string | undefined;
    executionId: string | undefined;
    nodeGraphId: string | undefined;
    remoteRequestId: string | undefined;
  } | undefined;
}

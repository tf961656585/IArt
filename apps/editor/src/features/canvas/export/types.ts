import type { ProjectMediaAssets } from '@iart/contracts';
import type { NodeGraph } from '../types';

export const EXPORT_FORMAT_VERSION = 1;

export interface ImportValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  nodeGraph: NodeGraph | undefined;
  mediaAssets: ProjectMediaAssets | undefined;
}

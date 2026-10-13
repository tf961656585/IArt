import type { ModelResultExtractor } from '@/features/workspace/modelFormTypes';

export const edgeDetectExtractor: ModelResultExtractor = {
  videoPaths: undefined,
  imagePaths: ['image_url'],
  textPaths: undefined,
  excludePaths: undefined,
};

export default edgeDetectExtractor;

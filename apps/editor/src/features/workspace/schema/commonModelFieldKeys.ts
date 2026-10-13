import type { MODEL_ASSET_PROMPT_RESERVED_FIELD_KEY } from '@iart/contracts';

export type CommonImageToImageFieldKey =
  | typeof MODEL_ASSET_PROMPT_RESERVED_FIELD_KEY
  | 'images'
  | 'aspectRatio'
  | 'imageSize';

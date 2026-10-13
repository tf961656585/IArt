import type { z } from 'zod';
import type { edgeDetectSchema } from './schema';

export type EdgeDetectParams = z.infer<typeof edgeDetectSchema>;
export type EdgeDetectFieldKey = 'images' | 'threshold' | 'mode';

import { z } from 'zod';

export const TaskSubmitMediaKindSchema = z.enum(['image', 'video', 'audio']);
export const TaskSubmitMediaSourceKindSchema = z.enum(['base64', 'url', 'local_path', 'attachment']);

export const TaskSubmitMediaInputSchema = z.object({
  media_kind: TaskSubmitMediaKindSchema,
  source_kind: TaskSubmitMediaSourceKindSchema,
  value: z.string(),
  mime_type: z.union([z.string(), z.null()]),
  filename: z.union([z.string(), z.null()]),
});

export type TaskSubmitMediaInput = z.infer<typeof TaskSubmitMediaInputSchema>;
export type TaskSubmitMediaKind = z.infer<typeof TaskSubmitMediaKindSchema>;
export type TaskSubmitMediaSourceKind = z.infer<typeof TaskSubmitMediaSourceKindSchema>;

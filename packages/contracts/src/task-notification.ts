import * as z from "zod";

import {
  RuntimeMediaAssetViewSchema,
  RuntimeTaskOutputViewSchema,
  RuntimeTaskViewSchema,
} from "./schemas/runtime-transaction.schema";

export const TaskStateNotificationSchema = z.object({
  type: z.literal("task:state-changed"),
  projectPath: z.string(),
  task: RuntimeTaskViewSchema,
  outputs: z.array(RuntimeTaskOutputViewSchema),
  mediaAssets: z.array(RuntimeMediaAssetViewSchema),
});

export const TaskStateSnapshotSchema = z.object({
  type: z.literal("task:state-snapshot"),
  projectPath: z.string(),
  tasks: z.array(RuntimeTaskViewSchema),
  taskOutputsByTaskId: z.record(z.array(RuntimeTaskOutputViewSchema)),
  mediaAssetsByTaskId: z.record(z.array(RuntimeMediaAssetViewSchema)),
});

export type TaskStateNotification = z.infer<typeof TaskStateNotificationSchema>;
export type TaskStateSnapshot = z.infer<typeof TaskStateSnapshotSchema>;

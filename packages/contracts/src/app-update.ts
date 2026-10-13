import * as z from 'zod';

export const AppUpdatePlatformSchema = z.enum(['darwin', 'win32', 'linux']);
export const AppUpdateArchSchema = z.enum(['x64', 'arm64', 'ia32']);
export const AppUpdateChannelSchema = z.enum(['stable', 'beta', 'internal']);
export const AppUpdateArtifactKindSchema = z.enum(['installer', 'metadata', 'blockmap']);
export const AppUpdateInstallActionSchema = z.enum([
  'quit-and-install',
  'open-installer',
  'show-in-folder',
  'later',
]);

export const AppUpdateProgressSchema = z.object({
  percent: z.number().min(0).max(100).optional(),
  bytesPerSecond: z.number().nonnegative().optional(),
  transferred: z.number().nonnegative().optional(),
  total: z.number().nonnegative().optional(),
}).strict();

export const AppUpdateErrorPayloadSchema = z.object({
  code: z.string().optional(),
  message: z.string(),
  detail: z.string().optional(),
  recoverable: z.boolean().optional(),
}).strict();

export const AppUpdateFileSchema = z.object({
  platform: AppUpdatePlatformSchema,
  arch: AppUpdateArchSchema,
  kind: AppUpdateArtifactKindSchema,
  name: z.string().min(1),
  path: z.string().min(1),
  r2Key: z.string().min(1),
  url: z.string().min(1).optional(),
  sha512: z.string().min(1),
  size: z.number().int().nonnegative(),
  contentType: z.string().min(1).optional(),
  blockmapKey: z.string().min(1).optional(),
  blockmapSha512: z.string().min(1).optional(),
  blockmapSize: z.number().int().nonnegative().optional(),
  visibleToUser: z.boolean().optional(),
}).strict();

export const AppUpdateReleaseManifestSchema = z.object({
  schemaVersion: z.literal(1),
  channel: AppUpdateChannelSchema,
  version: z.string().min(1),
  releaseDate: z.string().min(1),
  generatedAt: z.string().min(1),
  commitSha: z.string().nullable(),
  runId: z.string().nullable(),
  files: z.array(AppUpdateFileSchema),
  mandatory: z.boolean(),
  minimumVersion: z.string().nullable(),
  notes: z.string().nullable(),
}).strict();

export const AppUpdateCheckRequestSchema = z.object({
  currentVersion: z.string().min(1),
  platform: AppUpdatePlatformSchema,
  arch: AppUpdateArchSchema,
  channel: AppUpdateChannelSchema.default('stable'),
}).strict();

export const AppUpdateCheckResponseSchema = z.object({
  updateAvailable: z.boolean(),
  currentVersion: z.string(),
  latestVersion: z.string().nullable(),
  platform: AppUpdatePlatformSchema,
  arch: AppUpdateArchSchema,
  channel: AppUpdateChannelSchema,
  files: z.array(AppUpdateFileSchema),
  mandatory: z.boolean(),
  minimumVersion: z.string().nullable(),
  notes: z.string().nullable(),
  releaseDate: z.string().nullable(),
  error: AppUpdateErrorPayloadSchema.nullable(),
}).strict();

const AppUpdateStateBaseSchema = z.object({
  appVersion: z.string(),
  channel: AppUpdateChannelSchema,
  platform: AppUpdatePlatformSchema,
  arch: AppUpdateArchSchema,
  lastCheckedAt: z.number().nullable(),
  logPath: z.string().nullable(),
});

export const AppUpdateStateSchema = z.discriminatedUnion('status', [
  AppUpdateStateBaseSchema.extend({
    status: z.literal('idle'),
  }).strict(),
  AppUpdateStateBaseSchema.extend({
    status: z.literal('checking'),
  }).strict(),
  AppUpdateStateBaseSchema.extend({
    status: z.literal('not-available'),
    latestVersion: z.string().nullable(),
  }).strict(),
  AppUpdateStateBaseSchema.extend({
    status: z.literal('available'),
    latestVersion: z.string(),
    releaseDate: z.string().nullable(),
    notes: z.string().nullable(),
    files: z.array(AppUpdateFileSchema),
    mandatory: z.boolean(),
    minimumVersion: z.string().nullable(),
  }).strict(),
  AppUpdateStateBaseSchema.extend({
    status: z.literal('downloading'),
    latestVersion: z.string(),
    progress: AppUpdateProgressSchema.nullable(),
  }).strict(),
  AppUpdateStateBaseSchema.extend({
    status: z.literal('downloaded'),
    latestVersion: z.string(),
    downloadPath: z.string().nullable(),
    files: z.array(AppUpdateFileSchema),
    installActions: z.array(AppUpdateInstallActionSchema),
  }).strict(),
  AppUpdateStateBaseSchema.extend({
    status: z.literal('error'),
    latestVersion: z.string().nullable(),
    error: AppUpdateErrorPayloadSchema,
  }).strict(),
]);

export const AppUpdateAvailableInfoSchema = z.object({
  version: z.string(),
  releaseDate: z.string().nullable().optional(),
  releaseNotes: z.union([z.string(), z.array(z.unknown()), z.null()]).optional(),
  files: z.array(AppUpdateFileSchema).optional(),
}).strict();

export const AppUpdateNotAvailableInfoSchema = z.object({
  version: z.string().optional(),
}).strict();

export const AppUpdateDownloadedInfoSchema = z.object({
  version: z.string(),
  downloadedFile: z.string().optional(),
  downloadPath: z.string().nullable().optional(),
}).strict();

export const AppUpdateEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('checking'), state: AppUpdateStateSchema }).strict(),
  z.object({ type: z.literal('available'), state: AppUpdateStateSchema }).strict(),
  z.object({ type: z.literal('not-available'), state: AppUpdateStateSchema }).strict(),
  z.object({ type: z.literal('download-progress'), state: AppUpdateStateSchema }).strict(),
  z.object({ type: z.literal('downloaded'), state: AppUpdateStateSchema }).strict(),
  z.object({ type: z.literal('error'), state: AppUpdateStateSchema }).strict(),
]);

export const AppUpdateCommandResultSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('success'),
    state: AppUpdateStateSchema,
    message: z.string().optional(),
  }).strict(),
  z.object({
    status: z.literal('skipped'),
    reason: z.string(),
    state: AppUpdateStateSchema,
  }).strict(),
  z.object({
    status: z.literal('failed'),
    error: AppUpdateErrorPayloadSchema,
    state: AppUpdateStateSchema,
  }).strict(),
]);

export const AppUpdateLogInfoResultSchema = z.object({
  success: z.boolean(),
  path: z.string().optional(),
  exists: z.boolean().optional(),
  size: z.number().optional(),
  updatedAt: z.number().nullable().optional(),
}).strict();

export const AppUpdateRevealLogResultSchema = z.object({
  success: z.boolean(),
  error: z.string().optional(),
  path: z.string().optional(),
}).strict();

export type AppUpdatePlatform = z.infer<typeof AppUpdatePlatformSchema>;
export type AppUpdateArch = z.infer<typeof AppUpdateArchSchema>;
export type AppUpdateChannel = z.infer<typeof AppUpdateChannelSchema>;
export type AppUpdateArtifactKind = z.infer<typeof AppUpdateArtifactKindSchema>;
export type AppUpdateInstallAction = z.infer<typeof AppUpdateInstallActionSchema>;
export type AppUpdateProgress = z.infer<typeof AppUpdateProgressSchema>;
export type AppUpdateErrorPayload = z.infer<typeof AppUpdateErrorPayloadSchema>;
export type AppUpdateFile = z.infer<typeof AppUpdateFileSchema>;
export type AppUpdateReleaseManifest = z.infer<typeof AppUpdateReleaseManifestSchema>;
export type AppUpdateCheckRequest = z.infer<typeof AppUpdateCheckRequestSchema>;
export type AppUpdateCheckResponse = z.infer<typeof AppUpdateCheckResponseSchema>;
export type AppUpdateState = z.infer<typeof AppUpdateStateSchema>;
export type AppUpdateAvailableInfo = z.infer<typeof AppUpdateAvailableInfoSchema>;
export type AppUpdateNotAvailableInfo = z.infer<typeof AppUpdateNotAvailableInfoSchema>;
export type AppUpdateDownloadedInfo = z.infer<typeof AppUpdateDownloadedInfoSchema>;
export type AppUpdateEvent = z.infer<typeof AppUpdateEventSchema>;
export type AppUpdateCommandResult = z.infer<typeof AppUpdateCommandResultSchema>;
export type AppUpdateLogInfoResult = z.infer<typeof AppUpdateLogInfoResultSchema>;
export type AppUpdateRevealLogResult = z.infer<typeof AppUpdateRevealLogResultSchema>;

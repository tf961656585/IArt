import { createBusinessActionId } from '@/client/api/businessActionRuntime';
import { getRuntimeProjectPath } from '@/client/store/runtimeStore';
import { submitBusinessSyncAction } from '@/client/utils/businessActionSocket';
import {
  EDITOR_BACKEND_ACTION_NAME,
  EditorBackendThumbnailReportMissingRequestSchema,
  EditorBackendThumbnailReportMissingResultSchema,
  type EditorBackendThumbnailReportMissingResult,
} from '@iart/contracts/editor-backend-contract';

const REPORT_DEDUPE_MS = 30_000;
const recentReports = new Map<string, number>();

const normalizeString = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

const shouldSkipRecentReport = (key: string, now: number) => {
  const lastReportedAt = recentReports.get(key) ?? 0;
  if (now - lastReportedAt < REPORT_DEDUPE_MS) return true;
  recentReports.set(key, now);
  return false;
};

export const reportThumbnailRenderFailure = async (params: {
  assetId: string | null | undefined;
  mediaType: 'image' | 'video' | null | undefined;
  failedUrl: string | null | undefined;
}): Promise<EditorBackendThumbnailReportMissingResult | null> => {
  const projectPath = getRuntimeProjectPath();
  const assetId = normalizeString(params.assetId);
  const failedUrl = normalizeString(params.failedUrl);
  if (!projectPath || !assetId || !failedUrl) return null;
  const dedupeKey = `${projectPath}::${assetId}::${failedUrl}`;
  if (shouldSkipRecentReport(dedupeKey, Date.now())) return null;

  const request = EditorBackendThumbnailReportMissingRequestSchema.parse({
    projectPath,
    assetId,
    mediaType: params.mediaType ?? null,
    thumbnailUrl: failedUrl,
    reason: 'render_error',
  });
  const result = await submitBusinessSyncAction<EditorBackendThumbnailReportMissingResult>({
    actionId: createBusinessActionId(),
    actionName: EDITOR_BACKEND_ACTION_NAME.MEDIA_THUMBNAIL_REPORT_MISSING,
    projectPath,
    payload: request,
  });
  return EditorBackendThumbnailReportMissingResultSchema.parse(result.result);
};

import * as mediaProcessingActionsModule from "../media-processing-actions.cts";
import * as videoSpriteSheetModule from "../video-sprite-sheet.cts";
import * as mediaAssetRegistryModule from "../media-asset-registry.cts";
import * as thumbnailReconcileServiceModule from "../thumbnail-reconcile-service.cts";
import * as modelInputUploadModule from "../media-upload/model-input-upload.cts";
import * as remoteLocalizeModule from "../media-localization/remote-localize.cts";
import * as resultMediaPersistenceModule from "../result-media-persistence.cts";
import {
  EditorBackendThumbnailReportMissingRequestSchema,
  EditorBackendThumbnailReportMissingResultSchema,
} from "../contracts.cts";

import {
  asMediaImageThumbnailResult,
  asRecord,
  normalizeString,
} from "./common.cts";

const { localizeRemoteMediaToFiles } = remoteLocalizeModule;
const { persistResultMediaToFiles } = resultMediaPersistenceModule;
const { executeModelInputUploadSync } = modelInputUploadModule;
const { executeImageProcessing } = mediaProcessingActionsModule;
const { executeVideoSpriteSheet } = videoSpriteSheetModule;
const { repairProjectMediaAssetThumbnail } = mediaAssetRegistryModule;
const { reportMissingThumbnailByUrl, reportThumbnailRenderFailure } = thumbnailReconcileServiceModule;

export const executeMediaUploadSync = async (
  submit: unknown,
): Promise<unknown> => await executeModelInputUploadSync(submit);
export const executeMediaLocalizeSync = async (submit: unknown) => {
  const submitObject = asRecord(submit);
  const payload = asRecord(submitObject.payload);
  const result = asRecord(
    await localizeRemoteMediaToFiles({
      projectPath: normalizeString(submitObject.projectPath),
      url: normalizeString(payload.url),
      mediaType: normalizeString(payload.mediaType) || null,
      source: "ws:business:media-localize",
      mimeType: undefined,
    }),
  );
  if (result.ok !== true) {
    return {
      ok: false,
      code: normalizeString(result.code) || "download_failed",
      message: normalizeString(result.message) || "远程媒体下载失败",
    };
  }
  const hasMediaOutput =
    normalizeString(result.url) &&
    normalizeString(result.mediaType) &&
    normalizeString(result.mediaType) !== "text";
  return {
    ok: true,
    result: {
      owner: "backend",
      url: result.url,
      originalUrl: result.originalUrl,
      assetId: null,
      mediaAsset: hasMediaOutput
        ? {
            mediaType: result.mediaType,
            original: {
              url: result.url,
              mimeType: result.mimeType || null,
              sizeBytes: result.sizeBytes || null,
            },
          }
        : null,
      mediaType: result.mediaType,
      mimeType: result.mimeType,
      sizeBytes: result.sizeBytes,
      localized: result.localized,
      contract: result.contract,
    },
  };
};
export const executeMediaPersistResultSync = async (submit: unknown) => {
  const submitObject = asRecord(submit);
  const payload = asRecord(submitObject.payload);
  const result = asRecord(
    await persistResultMediaToFiles({
      projectPath: normalizeString(submitObject.projectPath),
      url: normalizeString(payload.url),
      formData: payload.formData,
      mediaType: normalizeString(payload.mediaType) || null,
      mimeType: normalizeString(payload.mimeType) || null,
      sizeBytes: payload.sizeBytes,
      filename: normalizeString(payload.filename) || null,
      filenamePrefix: normalizeString(payload.filenamePrefix) || null,
      originalUrl: normalizeString(payload.originalUrl) || null,
      source: "ws:business:media-persist-result",
    }),
  );
  if (result.ok !== true) {
    return {
      ok: false,
      code: normalizeString(result.code) || "persist_result_failed",
      message: normalizeString(result.message) || "结果媒体落盘失败",
    };
  }
  const normalizedOriginalUrl =
    normalizeString(result.originalUrl) ||
    normalizeString(payload.originalUrl) ||
    normalizeString(payload.url) ||
    null;
  const hasMediaOutput =
    normalizeString(result.url) &&
    normalizeString(result.mediaType) &&
    normalizeString(result.mediaType) !== "text";
  return {
    ok: true,
    result: {
      owner: "backend",
      url: result.url,
      originalUrl: normalizedOriginalUrl,
      assetId: null,
      mediaAsset: hasMediaOutput
        ? {
            mediaType: result.mediaType,
            original: {
              url: result.url,
              mimeType: result.mimeType || null,
              sizeBytes: result.sizeBytes || null,
            },
          }
        : null,
      mediaType: result.mediaType,
      mimeType: result.mimeType,
      sizeBytes: result.sizeBytes,
      localized: result.localized,
      contract: result.contract,
      adapter: {
        route:
          normalizeString(payload.url) &&
          /^https?:\/\//i.test(normalizeString(payload.url))
            ? "/api/media/localize"
            : "/api/upload",
        mode: "backend_internal_adapter",
      },
    },
  };
};
export const executeMediaThumbnailRepairSync = async (
  submit: unknown,
  mediaType: "image" | "video",
  route: string,
) => {
  const submitObject = asRecord(submit);
  const payload = asRecord(submitObject.payload);
  const repair = asRecord(
    await repairProjectMediaAssetThumbnail(
      normalizeString(submitObject.projectPath),
      {
        assetId: normalizeString(payload.assetId),
        mediaType,
        maxEdge: payload.maxEdge,
        width: payload.width,
        quality: payload.quality,
        timeSec: payload.timeSec,
      },
    ),
  );
  const asset = asRecord(repair.asset);
  const thumbnail = asRecord(asset.thumbnail);
  const result = asMediaImageThumbnailResult(repair.result);
  return {
    ok: true,
    result: {
      success: true,
      assetId: normalizeString(repair.assetId),
      mediaAsset: asset,
      url: normalizeString(thumbnail.url) || normalizeString(result.url),
      meta: result.meta,
      owner: "backend",
      adapter: {
        route,
        mode: "backend_internal_adapter",
      },
    },
  };
};
export const executeMediaImageThumbnailSync = async (submit: unknown) =>
  executeMediaThumbnailRepairSync(
    submit,
    "image",
    "/api/media/image/thumbnail",
  );
export const executeMediaVideoThumbnailSync = async (submit: unknown) =>
  executeMediaThumbnailRepairSync(
    submit,
    "video",
    "/api/media/video/thumbnail",
  );

export const executeMediaThumbnailReportMissingSync = async (submit: unknown) => {
  const submitObject = asRecord(submit);
  const payload = asRecord(submitObject.payload);
  const parsed = EditorBackendThumbnailReportMissingRequestSchema.safeParse({
    projectPath: normalizeString(submitObject.projectPath),
    assetId: normalizeString(payload.assetId) || null,
    mediaType: normalizeString(payload.mediaType) || null,
    thumbnailUrl: normalizeString(payload.thumbnailUrl) || null,
    reason: normalizeString(payload.reason),
  });
  if (!parsed.success) {
    return {
      ok: false,
      code: "invalid_thumbnail_report_payload",
      message: parsed.error.message,
    };
  }
  const request = parsed.data;
  const result = request.assetId
    ? await reportThumbnailRenderFailure(request.projectPath, {
        assetId: request.assetId,
        mediaType: request.mediaType,
        failedUrl: request.thumbnailUrl,
      })
    : await reportMissingThumbnailByUrl(request.projectPath, request.thumbnailUrl);
  return {
    ok: true,
    result: EditorBackendThumbnailReportMissingResultSchema.parse(result),
  };
};

export const executeMediaImageProcessSync = async (submit: unknown) => {
  const submitObject = asRecord(submit);
  const result = await executeImageProcessing(
    normalizeString(submitObject.projectPath),
    submitObject.payload,
  );
  return {
    ok: true,
    result,
  };
};

export const executeMediaVideoSpriteSheetSync = async (submit: unknown) => {
  const submitObject = asRecord(submit);
  const result = await executeVideoSpriteSheet(
    normalizeString(submitObject.projectPath),
    submitObject.payload,
  );
  return {
    ok: true,
    result,
  };
};

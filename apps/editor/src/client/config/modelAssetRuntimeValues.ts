import type { UnknownRecord } from '@/client/utils/typeGuards';
import {
  extractFirstBase64DataUrl,
  extractFirstFileOrUrlFromUpload,
  extractFirstFileFromUpload,
  extractFilesFromUpload,
  extractFirstUrlFromUpload,
  extractUrlsFromUpload,
  type ExtractUploadUrlOptions,
} from '@/features/models/shared/formTransforms';
import type { SchemaFormDefinition } from '@/features/workspace/schema/types';
import {
  MODEL_ASSET_URL_INPUT_UPLOAD_MODE,
} from '@iart/contracts/model-asset-contract';
import type {
  ModelAssetMediaTargetShape,
  ModelAssetNodeProjectionRuntimeValueRule,
} from '@iart/contracts/model-asset-contract';
import {
  evaluateRuntimeValueRule as evaluateSharedRuntimeValueRule,
  type ModelAssetRuntimeComputeOperator,
  type ModelAssetRuntimeEvaluationOptions,
  type ModelAssetRuntimeValueTransform,
} from '@iart/model-asset-runtime';
import {
  evaluateBuildContentBlocks,
  evaluatePrepareAudioUrl,
  evaluateResolveAutoAudioFlag,
} from './modelAssetMediaRuntime';
import type { RuntimeProjectionContext } from './modelAssetProjectionShared';

export interface RuntimeEvaluationContext {
  schema: SchemaFormDefinition<string>;
  values: UnknownRecord;
  fields: UnknownRecord | undefined;
  modelId: string;
  runtime: RuntimeProjectionContext | undefined;
  currentItem: unknown | undefined;
}

type NormalizedRuntimeEvaluationContext = RuntimeEvaluationContext & {
  fields: UnknownRecord;
};

const toUploadTransformOptions = (
  context: RuntimeEvaluationContext,
  mediaTarget: ModelAssetMediaTargetShape | undefined,
): ExtractUploadUrlOptions | undefined => {
  // public_url：PUBLIC_RELAY 走 data URL 直接透传链路；非 PUBLIC_RELAY 返回 undefined，
  // 由 extractUrlsFromUpload 走 remote-url 公网 URL 校验。
  if (mediaTarget === 'public_url') {
    const uploadMode = context.runtime !== undefined
      ? context.runtime.url_input_upload_mode
      : undefined;
    const modeString = typeof uploadMode === "string" ? uploadMode : undefined;
    if (modeString !== MODEL_ASSET_URL_INPUT_UPLOAD_MODE.PUBLIC_RELAY) {
      return undefined;  // 非 PUBLIC_RELAY 的 public_url：走 remote-url 公网 URL 校验
    }
    return {
      uploadMode: modeString,
      fieldPath: undefined,
    };
  }
  // inline_data / file_data_uri：Editor 直接透传本地媒体引用给后端物化，
  // 不做 remote-url 公网 URL 校验（透传 local-media://、data URL、http(s):// 等原始引用）。
  if (
    mediaTarget === 'inline_data' ||
    mediaTarget === 'file_data_uri'
  ) {
    return {
      uploadMode: undefined,
      fieldPath: undefined,
      passThroughLocalMedia: true,
    };
  }
  // multipart_file 等其他 target：返回 undefined（由各自的 file 提取 transform 处理，不走 extractUrls 的 url 逻辑）
  return undefined;
};

const buildEvaluationOptions = (
  context: NormalizedRuntimeEvaluationContext,
): ModelAssetRuntimeEvaluationOptions<NormalizedRuntimeEvaluationContext> => ({
  item: context.currentItem,
  targetPath: undefined,
  mediaTarget: undefined,
  extra: undefined,
  transformHandlers: {
    extractUrls: ({ value, options }) => extractUrlsFromUpload(value, toUploadTransformOptions(context, options.mediaTarget)),
    extractFirstUrl: ({ value, options }) => extractFirstUrlFromUpload(value, toUploadTransformOptions(context, options.mediaTarget)),
    extractFirstBase64DataUrl: ({ value }) => extractFirstBase64DataUrl(value),
    extractFirstFile: ({ value }) => extractFirstFileFromUpload(value),
    firstUploadFile: ({ value }) => extractFirstFileFromUpload(value),
    firstUploadFileOrUrl: ({ value }) => extractFirstFileOrUrlFromUpload(value),
    allUploadFiles: ({ value }) => extractFilesFromUpload(value, undefined),
  } satisfies Partial<
    Record<
      ModelAssetRuntimeValueTransform,
      NonNullable<ModelAssetRuntimeEvaluationOptions<NormalizedRuntimeEvaluationContext>['transformHandlers']>[ModelAssetRuntimeValueTransform]
    >
  >,
  operatorHandlers: {
    build_content_blocks: ({ rule }) =>
      evaluateBuildContentBlocks((rule as { options: Parameters<typeof evaluateBuildContentBlocks>[0] }).options, context),
    prepare_audio_url: ({ rule }) =>
      evaluatePrepareAudioUrl((rule as { options: Parameters<typeof evaluatePrepareAudioUrl>[0] }).options, context),
    resolve_auto_audio_flag: ({ rule }) =>
      evaluateResolveAutoAudioFlag((rule as { options: Parameters<typeof evaluateResolveAutoAudioFlag>[0] }).options, context),
  } satisfies Partial<
    Record<
      ModelAssetRuntimeComputeOperator,
      NonNullable<ModelAssetRuntimeEvaluationOptions<NormalizedRuntimeEvaluationContext>['operatorHandlers']>[ModelAssetRuntimeComputeOperator]
    >
  >,
  createError: undefined,
});

export const evaluateRuntimeValueRule = (
  rule: ModelAssetNodeProjectionRuntimeValueRule,
  context: RuntimeEvaluationContext,
): Promise<unknown> => {
  const normalizedContext: NormalizedRuntimeEvaluationContext = {
    ...context,
    fields: context.fields ?? context.values,
  };
  return evaluateSharedRuntimeValueRule(
    rule,
    normalizedContext,
    buildEvaluationOptions(normalizedContext),
  );
};

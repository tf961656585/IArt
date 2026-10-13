/**
 * 模型输入准备的共享类型和辅助函数。
 *
 * 从 model-input-preparation.cts 提取的类型定义、
 * 事件记录辅助函数和源读取工具。
 */
import type { MediaRefSource } from "@iart/contracts";
import type { ModelInputPolicy } from "./model-input-policy.cts";

type ModelInputPreparationArchiveEvent = {
  type: string;
  detail: object;
};

type ModelInputPreparationResult =
  | {
      ok: true;
      body: unknown;
      events: ModelInputPreparationArchiveEvent[];
      policy: ModelInputPolicy;
    }
  | {
      ok: false;
      body: unknown;
      events: ModelInputPreparationArchiveEvent[];
      error: { code: string; message: string };
      policy: ModelInputPolicy;
    };

type PreparationContext = {
  projectPath: unknown;
  targetType: string;
  taskId: string | undefined;
  events: ModelInputPreparationArchiveEvent[];
};

type MaterializeContext = PreparationContext & {
  multipartMode: boolean;
};

type AtomPreparationResult =
  | { ok: true; value: unknown }
  | { ok: false; code: string; message: string };

const buildArchiveDetail = (
  source: MediaRefSource,
  overrides: {
    fieldPath: string | null;
    targetType: string | null;
    phase: string | null;
    continueToRequesting: boolean | null;
    errorCode: string | null;
    error: string | null;
    url: string | null;
  },
) => {
  return {
    fieldPath: overrides.fieldPath,
    targetType: overrides.targetType,
    source: {
      kind: source.kind,
      mimeType: source.kind === "inline_data" ? source.mimeType : null,
    },
    phase: overrides.phase,
    continueToRequesting: overrides.continueToRequesting,
    errorCode: overrides.errorCode,
    error: overrides.error,
    url: overrides.url,
  };
};

const appendUploadEvent = (
  context: PreparationContext,
  type: string,
  source: MediaRefSource,
  fieldPath: string,
  overrides: {
    continueToRequesting: boolean | null;
    errorCode: string | null;
    error: string | null;
    url: string | null;
  },
) => {
  context.events.push({
    type,
    detail: buildArchiveDetail(source, {
      fieldPath,
      targetType: context.targetType,
      phase: "uploading_input",
      continueToRequesting: overrides.continueToRequesting,
      errorCode: overrides.errorCode,
      error: overrides.error,
      url: overrides.url,
    }),
  });
};

export {
  appendUploadEvent,
  buildArchiveDetail,
};
export type {
  AtomPreparationResult,
  MaterializeContext,
  ModelInputPreparationArchiveEvent,
  ModelInputPreparationResult,
  PreparationContext,
};

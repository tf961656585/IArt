import {
  type MediaRefSource,
} from "@iart/contracts";
import { uploadPreparedTaskInputMedia } from "../media-upload/model-input-upload.cts";
import {
  normalizeString,
  readField,
} from "./model-input-source.cts";
import * as loggingModule from "../logging.cts";

type RelayUploadResult =
  | { ok: true; url: string }
  | { ok: false; code: string; message: string };

const uploadModelInputViaPublicRelay = async (params: {
  projectPath: unknown;
  source: MediaRefSource;
  targetType: string;
  mimeType: string | undefined;
  filename: string | undefined;
}): Promise<RelayUploadResult> => {
  const result = await uploadPreparedTaskInputMedia({
    projectPath: normalizeString(params.projectPath),
    source: params.source,
    targetType: params.targetType,
    filename: params.filename || "input.bin",
  });
  const uploadOk = readField(result, "ok") === true;
  const resultPayload = readField(result, "result");
  const url = normalizeString(readField(resultPayload, "url"));
  if (uploadOk && url) {
    return { ok: true, url };
  }
  loggingModule.logWarn("[public-relay] model input upload failed", {
    code: normalizeString(readField(result, "code")) || "input_upload_failed",
    message: normalizeString(readField(result, "message")) || "Input upload failed",
    targetType: params.targetType,
    sourceKind: params.source.kind,
  });
  return {
    ok: false,
    code: normalizeString(readField(result, "code")) || "input_upload_failed",
    message:
      normalizeString(readField(result, "message")) || "Input upload failed",
  };
};

export {
  type RelayUploadResult,
  uploadModelInputViaPublicRelay,
};

import {
  isPlainObject,
  readRequestBodyPathValue,
  writeRequestBodyPathValue,
} from "./model-input-source.cts";
import { isSerializedFormDataBody } from "@iart/contracts";
import { MODEL_ASSET_MULTIPART_ARRAY_NAMING } from "@iart/contracts/model-asset-contract";
import {
  resolveModelInputPolicy,
} from "./model-input-policy.cts";
import { guardPreparedModelInput } from "./model-input-final-guard.cts";
import {
  convertBodyToSerializedFormData,
} from "./model-input-multipart-file.cts";
import {
  type ModelInputPreparationArchiveEvent,
  type ModelInputPreparationResult,
} from "./model-input-shared.cts";
import {
  materializeSubtree,
} from "./model-input-materializer.cts";
import { logDebug } from "../logging.cts";

const prepareModelInputForRequest = async (params: {
  modelId: unknown;
  projectPath: unknown | undefined;
  body: unknown;
  projection: unknown | undefined;
  taskId?: string;
}): Promise<ModelInputPreparationResult> => {
  const policy = await resolveModelInputPolicy({
    modelId: params.modelId,
    projection: params.projection,
    body: params.body,
  });
  const events: ModelInputPreparationArchiveEvent[] = [];

  // body 中已不包含 input_uploads 映射表，媒体以 MediaRefPlaceholder 对象嵌入
  const preparedBody = params.body;

  // 统一物化路径：收集所有需要处理的 fields，按 transport 构造 MaterializeContext
  // 并遍历 body → 发现 MediaRefPlaceholder → 根据 transport 物化 → 替换

  if (policy.publicUrl) {
    const materializeCtx = {
      projectPath: params.projectPath,
      targetType: policy.publicUrl.targetType,
      taskId: params.taskId,
      multipartMode: false,
      events,
    };
    for (const field of policy.publicUrl.fields) {
      const currentValue = readRequestBodyPathValue(
        preparedBody,
        field.requestBodyPath,
      );
      if (
        currentValue === undefined ||
        currentValue === null ||
        currentValue === ""
      )
        continue;
      const prepared = await materializeSubtree(
        materializeCtx,
        currentValue,
        field.targetPath,
      );
      if (!prepared.ok) {
        return {
          ok: false,
          body: preparedBody,
          events,
          error: { code: prepared.code, message: prepared.message },
          policy,
        };
      }
      writeRequestBodyPathValue(
        preparedBody,
        field.requestBodyPath,
        prepared.value,
      );
    }
  }

  if (policy.multipartFiles) {
    const materializeCtx = {
      projectPath: params.projectPath,
      targetType: "",
      taskId: params.taskId,
      multipartMode: true,
      events,
    };
    for (const field of policy.multipartFiles.fields) {
      const currentValue = readRequestBodyPathValue(
        preparedBody,
        field.requestBodyPath,
      );
      if (
        currentValue === undefined ||
        currentValue === null ||
        currentValue === ""
      ) {
        continue;
      }
      const prepared = await materializeSubtree(
        materializeCtx,
        currentValue,
        field.targetPath,
      );
      if (!prepared.ok) {
        return {
          ok: false,
          body: preparedBody,
          events,
          error: { code: prepared.code, message: prepared.message },
          policy,
        };
      }
      writeRequestBodyPathValue(
        preparedBody,
        field.requestBodyPath,
        prepared.value,
      );
    }
  }

  if (policy.inlineData) {
    // inline_data 一流物化路径：把本地媒体引用解析为 base64 + mime_type，
    // 替换为 `{ inline_data: { mime_type, data } }`。
    // 与 build_content_blocks 的区别：build_content_blocks 在请求构造期就把
    // 占位符转成 generateContent 形状；此分支处理请求构造期仍保留占位符的包
    // （Veo instances[].image / lastFrame / referenceImages[].image 等），
    // 使 media_target=inline_data 成为与 public_url / multipart_file 并列的
    // 一等物化目标。
    const materializeCtx = {
      projectPath: params.projectPath,
      targetType: "",
      taskId: params.taskId,
      multipartMode: false,
      events,
    };
    // 同一 requestBodyPath 可能被多个嵌套规则声明（如 Veo 的 image / lastFrame /
    // referenceImages 都收敛到顶层 body.instances），按路径去重避免重复遍历同一子树。
    const seenPaths = new Set<string>();
    for (const field of policy.inlineData.fields) {
      if (seenPaths.has(field.requestBodyPath)) continue;
      seenPaths.add(field.requestBodyPath);
      const currentValue = readRequestBodyPathValue(
        preparedBody,
        field.requestBodyPath,
      );
      if (
        currentValue === undefined ||
        currentValue === null ||
        currentValue === ""
      ) {
        logDebug(
          "[model-input-preparation] inline_data field skipped: empty request body value",
          { requestBodyPath: field.requestBodyPath },
        );
        continue;
      }
      const prepared = await materializeSubtree(
        materializeCtx,
        currentValue,
        field.targetPath,
      );
      if (!prepared.ok) {
        return {
          ok: false,
          body: preparedBody,
          events,
          error: { code: prepared.code, message: prepared.message },
          policy,
        };
      }
      writeRequestBodyPathValue(
        preparedBody,
        field.requestBodyPath,
        prepared.value,
      );
    }
  }

  const guarded = guardPreparedModelInput({ body: preparedBody, policy });
  if (!guarded.ok) {
    return {
      ok: false,
      body: preparedBody,
      events,
      error: { code: guarded.code, message: guarded.message },
      policy,
    };
  }

  let finalBody: unknown = preparedBody;
  if (
    policy.multipartFiles &&
    policy.payloadFormat === "multipart" &&
    isPlainObject(preparedBody) &&
    !isSerializedFormDataBody(preparedBody)
  ) {
    // 收集声明了 multipart_array_naming=repeated 的顶层字段（requestBodyPath），
    // 传给序列化器让数组展开为同名重复 part。
    const repeatedTopLevelKeys = new Set<string>();
    for (const field of policy.multipartFiles.fields) {
      if (field.multipartArrayNaming === MODEL_ASSET_MULTIPART_ARRAY_NAMING.REPEATED) {
        repeatedTopLevelKeys.add(field.requestBodyPath);
      }
    }
    finalBody = convertBodyToSerializedFormData(preparedBody, repeatedTopLevelKeys);
  }

  return {
    ok: true,
    body: finalBody,
    events,
    policy,
  };
};

export {
  type ModelInputPreparationArchiveEvent,
  type ModelInputPreparationResult,
  prepareModelInputForRequest,
};

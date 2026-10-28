import {
  ERROR_CODES,
  type PlainObject,
} from "./task-engine-shared.cts";
import { summarizeArchiveResponse } from "./task-engine-archive.cts";
import { normalizeString } from "./task-normalizer.cts";

type AsyncPollingStartFailureInput = {
  reason: unknown | undefined;
  submitResponseIdPath: unknown | undefined;
  responsePayload: unknown | undefined;
  /** 运行时给出的具体拒绝原因（仅 `invalid_polling_request` 携带）。 */
  message?: unknown | undefined;
};

const normalizePollingStartFailureReason = (value: unknown) =>
  normalizeString(value) || "polling_request_invalid";

const buildAsyncPollingStartFailureError = (
  input: AsyncPollingStartFailureInput,
): PlainObject => {
  const reason = normalizePollingStartFailureReason(input.reason);
  const submitResponseIdPath =
    normalizeString(input.submitResponseIdPath) || null;
  if (reason === "remote_request_id_missing") {
    return {
      code: ERROR_CODES.ASYNC_POLLING_REMOTE_REQUEST_ID_MISSING,
      message: "异步任务无法启动轮询",
      stage: "recovery",
      detail: {
        reason,
        message:
          "提交响应未按 result_rule.submit_response_id_path 解析到远端任务号",
        submitResponseIdPath,
      },
    } as PlainObject;
  }
  return {
    code: ERROR_CODES.ASYNC_POLLING_REQUEST_INVALID,
    message: "异步任务无法启动轮询",
    stage: "recovery",
    detail: {
      reason,
      message:
        normalizeString(input.message) ||
        "轮询请求缺少有效的 polling_strategy.request.url_template",
      submitResponseIdPath,
    },
  } as PlainObject;
};

const buildAsyncPollingStartFailureArchiveDetail = (
  input: AsyncPollingStartFailureInput,
) => ({
  phase: "polling_start_failed",
  reason: normalizePollingStartFailureReason(input.reason),
  message: normalizeString(input.message) || null,
  submitResponseIdPath: normalizeString(input.submitResponseIdPath) || null,
  response: summarizeArchiveResponse(input.responsePayload),
});

export {
  buildAsyncPollingStartFailureArchiveDetail,
  buildAsyncPollingStartFailureError,
};

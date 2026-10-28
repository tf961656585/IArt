import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildRemoteHttpFailurePayload } from "../task-failure-mapping.cts";

void describe("task-failure-mapping", () => {
  void it("maps remote HTTP JSON errors through model asset result_rule", () => {
    const failure = buildRemoteHttpFailurePayload({
      taskRecord: {
        metadata: {
          taskExecutionPlan: {
            result_rule: {
              mode: "sync",
              submit_response_id_path: "/id",
              failure_condition: {
                op: "any",
                children: [
                  { op: "not_empty", path: "error.message" },
                  { op: "not_empty", path: "error.code" },
                ],
              },
              error_mapping_rules: [
                {
                  target: "code",
                  source: { kind: "response", path: "error.code" },
                  required: false,
                },
                {
                  target: "message",
                  source: { kind: "response", path: "error.message" },
                  required: false,
                },
                {
                  target: "details.remote.type",
                  source: { kind: "response", path: "error.type" },
                  required: false,
                },
                {
                  target: "details.remote.param",
                  source: { kind: "response", path: "error.param" },
                  required: false,
                },
              ],
            },
          },
        },
      },
      httpStatus: 429,
      responseOk: false,
      responseBodyType: "json",
      contentType: "application/json",
      responseBody: {
        error: {
          message: "Your request was rejected by the safety system...",
          type: "image_generation_user_error",
          param: "",
          code: "moderation_blocked",
        },
      },
    } as Parameters<typeof buildRemoteHttpFailurePayload>[0]);

    assert.equal(failure?.code, "moderation_blocked");
    assert.equal(
      failure?.message,
      "Your request was rejected by the safety system...",
    );
    assert.match(
      failure?.backendMessage ?? "",
      /HTTP 429\nYour request was rejected by the safety system/,
    );
    assert.deepEqual(failure?.details, {
      httpStatus: 429,
      responseBodyType: "json",
      contentType: "application/json",
      remote: {
        message: "Your request was rejected by the safety system...",
        type: "image_generation_user_error",
        param: "",
        code: "moderation_blocked",
      },
      mapping: {
        source: "model_asset_result_rule",
        failureConditionMatched: true,
        mappedTargets: [
          "code",
          "message",
          "details.remote.type",
        ],
      },
    });
  });

  void it("keeps the HTTP status fallback when no error mapping rule exists", () => {
    const failure = buildRemoteHttpFailurePayload({
      taskRecord: {
        metadata: {
          taskExecutionPlan: {
            result_rule: {
              mode: "sync",
              submit_response_id_path: "/id",
            },
          },
        },
      },
      httpStatus: 500,
      responseOk: false,
      responseBodyType: "text",
      contentType: "text/plain",
      responseBody: "upstream unavailable",
    } as Parameters<typeof buildRemoteHttpFailurePayload>[0]);

    assert.equal(failure?.code, "task_execution_failed");
    assert.equal(failure?.message, "HTTP 500");
    assert.equal(failure?.backendMessage, "HTTP 500");
    assert.deepEqual(failure?.details, {
      httpStatus: 500,
      responseBodyType: "text",
      contentType: "text/plain",
    });
  });

  void it("returns null for successful responses without failure evidence", () => {
    const failure = buildRemoteHttpFailurePayload({
      taskRecord: {
        metadata: {
          taskExecutionPlan: {
            result_rule: {
              mode: "sync",
              submit_response_id_path: "/id",
              failure_condition: {
                op: "not_empty",
                path: "error.message",
              },
              error_mapping_rules: [
                {
                  target: "message",
                  source: { kind: "response", path: "error.message" },
                },
              ],
            },
          },
        },
      },
      httpStatus: 200,
      responseOk: true,
      responseBodyType: "json",
      contentType: "application/json",
      responseBody: {
        data: [{ url: "https://media.example.com/image.png" }],
      },
    } as Parameters<typeof buildRemoteHttpFailurePayload>[0]);

    assert.equal(failure, null);
  });

  void it("fails successful HTTP responses when failure_condition is matched", () => {
    const failure = buildRemoteHttpFailurePayload({
      taskRecord: {
        metadata: {
          taskExecutionPlan: {
            result_rule: {
              mode: "sync",
              submit_response_id_path: "/id",
              failure_condition: {
                op: "not_empty",
                path: "error.message",
              },
              error_mapping_rules: [
                {
                  target: "message",
                  source: { kind: "response", path: "error.message" },
                },
                {
                  target: "code",
                  source: { kind: "response", path: "error.code" },
                },
              ],
            },
          },
        },
      },
      httpStatus: 200,
      responseOk: true,
      responseBodyType: "json",
      contentType: "application/json",
      responseBody: {
        error: {
          code: "remote_rejected",
          message: "Remote rejected the request",
        },
      },
    } as Parameters<typeof buildRemoteHttpFailurePayload>[0]);

    assert.equal(failure?.code, "remote_rejected");
    assert.equal(failure?.message, "Remote rejected the request");
    assert.equal(failure?.backendMessage, "HTTP 200\nRemote rejected the request");
  });

  void it("injects the built-in 451 fallback userMessage when no rule maps it", () => {
    const failure = buildRemoteHttpFailurePayload({
      taskRecord: {
        metadata: {
          taskExecutionPlan: {
            result_rule: {
              mode: "sync",
              submit_response_id_path: "/id",
            },
          },
        },
      },
      httpStatus: 451,
      responseOk: false,
      responseBodyType: "json",
      contentType: "application/json",
      responseBody: {},
    } as Parameters<typeof buildRemoteHttpFailurePayload>[0]);

    assert.ok(failure?.userMessage);
    assert.match(failure?.userMessage ?? "", /地区|法律/);
    // message 链保持现状：兜底只注入 userMessage，不覆盖厂商 message 兜底。
    assert.equal(failure?.message, "HTTP 451");
  });

  void it("prefers vendor error_mapping_rules userMessage over the built-in fallback", () => {
    const failure = buildRemoteHttpFailurePayload({
      taskRecord: {
        metadata: {
          taskExecutionPlan: {
            result_rule: {
              mode: "sync",
              submit_response_id_path: "/id",
              error_mapping_rules: [
                {
                  target: "userMessage",
                  source: { kind: "response", path: "error.message" },
                  required: false,
                },
              ],
            },
          },
        },
      },
      httpStatus: 429,
      responseOk: false,
      responseBodyType: "json",
      contentType: "application/json",
      responseBody: {
        error: {
          message: "Vendor custom message",
        },
      },
    } as Parameters<typeof buildRemoteHttpFailurePayload>[0]);

    assert.equal(failure?.userMessage, "Vendor custom message");
    assert.doesNotMatch(failure?.userMessage ?? "", /限流/);
  });

  // 2026-10-26：同步失败判定与轮询共用同一求值器后，eq 的比较语义放宽为
  // 「字符串忽略大小写 + 双侧可转数值时按数值比较」。这里固定的正是这条既有实现行为，
  // 避免 `task-failure-mapping.cts` 的注释再次与实现相反。
  void it("matches failure_condition with relaxed eq semantics on the sync path", () => {
    const caseInsensitive = buildRemoteHttpFailurePayload({
      taskRecord: {
        metadata: {
          taskExecutionPlan: {
            result_rule: {
              mode: "sync",
              submit_response_id_path: "/id",
              failure_condition: { op: "eq", path: "status", value: "failed" },
            },
          },
        },
      },
      httpStatus: 200,
      responseOk: true,
      responseBodyType: "json",
      contentType: "application/json",
      responseBody: { status: "FAILED" },
    } as Parameters<typeof buildRemoteHttpFailurePayload>[0]);
    assert.ok(caseInsensitive, "字符串比较必须忽略大小写");

    const numeric = buildRemoteHttpFailurePayload({
      taskRecord: {
        metadata: {
          taskExecutionPlan: {
            result_rule: {
              mode: "sync",
              submit_response_id_path: "/id",
              failure_condition: { op: "eq", path: "code", value: 1 },
            },
          },
        },
      },
      httpStatus: 200,
      responseOk: true,
      responseBodyType: "json",
      contentType: "application/json",
      responseBody: { code: "1" },
    } as Parameters<typeof buildRemoteHttpFailurePayload>[0]);
    assert.ok(numeric, "两侧可转数值时必须按数值比较");
  });

  void it("prefers the recipe failure_reason when failure_condition matches", () => {
    const failure = buildRemoteHttpFailurePayload({
      taskRecord: {
        metadata: {
          taskExecutionPlan: {
            result_rule: {
              mode: "sync",
              submit_response_id_path: "/id",
              failure_condition: { op: "eq", path: "status", value: "failed" },
              failure_reason: "这段内容被服务商判定为不合规，请修改提示词后重试。",
            },
          },
        },
      },
      httpStatus: 200,
      responseOk: true,
      responseBodyType: "json",
      contentType: "application/json",
      responseBody: { status: "FAILED" },
    } as Parameters<typeof buildRemoteHttpFailurePayload>[0]);

    assert.equal(failure?.message, "这段内容被服务商判定为不合规，请修改提示词后重试。");
    assert.equal(failure?.userMessage, "这段内容被服务商判定为不合规，请修改提示词后重试。");
  });

  void it("does not apply the recipe failure_reason when failure_condition is not matched", () => {
    const failure = buildRemoteHttpFailurePayload({
      taskRecord: {
        metadata: {
          taskExecutionPlan: {
            result_rule: {
              mode: "sync",
              submit_response_id_path: "/id",
              failure_condition: { op: "eq", path: "status", value: "failed" },
              failure_reason: "配方声明的失败原因",
            },
          },
        },
      },
      httpStatus: 500,
      responseOk: false,
      responseBodyType: "json",
      contentType: "application/json",
      responseBody: { status: "running" },
    } as Parameters<typeof buildRemoteHttpFailurePayload>[0]);

    assert.equal(failure?.message, "HTTP 500");
    assert.doesNotMatch(failure?.userMessage ?? "", /配方声明的失败原因/);
  });

  void it("injects the built-in 5xx fallback userMessage on server errors", () => {
    const failure = buildRemoteHttpFailurePayload({
      taskRecord: {
        metadata: {
          taskExecutionPlan: {
            result_rule: {
              mode: "sync",
              submit_response_id_path: "/id",
            },
          },
        },
      },
      httpStatus: 500,
      responseOk: false,
      responseBodyType: "json",
      contentType: "application/json",
      responseBody: {},
    } as Parameters<typeof buildRemoteHttpFailurePayload>[0]);

    assert.ok(failure?.userMessage);
    assert.match(failure?.userMessage ?? "", /远端服务|暂时不可用/);
  });
});

import { describe, it, expect } from "vitest";
import { classifyError, extractErrorMessage } from "@/client/utils/generationErrors";

describe("client/utils/generationErrors", () => {
  it("Gemini PROHIBITED_CONTENT 识别为 content_blocked", () => {
    const err = {
      message: "HTTP 500",
      status: 500,
      body: {
        error: {
          message:
            "request blocked by Google Gemini (PROHIBITED_CONTENT): content is prohibited under official usage policies.",
          type: "new_api_error",
          param: "",
          code: "request_body_blocked",
        },
      },
    };

    const result = classifyError(err);
    expect(result.type).toBe("content_blocked");
  });

  it("Gemini empty_response 识别为 empty_response（不应误判为 rate_limited）", () => {
    const err = {
      message: "HTTP 429",
      status: 429,
      body: {
        error: {
          message:
            "received empty response from Gemini: no meaningful content in candidates",
          type: "channel_error",
          param: "",
          code: "empty_response",
        },
      },
    };

    const result = classifyError(err);
    expect(result.type).toBe("empty_response");
  });

  it("OpenAI safety system 429 识别为 content_blocked（不应误判为 rate_limited）", () => {
    const err = {
      message: "HTTP 429",
      status: 429,
      body: {
        error: {
          message:
            "Your request was rejected as a result of our safety system. Your request may contain content that is not allowed by our safety system.",
          type: "upstream_error",
          param: "",
          code: null,
        },
      },
    };

    const result = classifyError(err);
    expect(result.type).toBe("content_blocked");
  });

  it("纯 429/RESOURCE_EXHAUSTED 识别为 rate_limited", () => {
    const err = {
      message: "HTTP 429",
      status: 429,
      body: { error: { message: "RESOURCE_EXHAUSTED" } },
    };

    const result = classifyError(err);
    expect(result.type).toBe("rate_limited");
  });

  it("Unsupported MIME type 显示中文说明（不应误判为 rate_limited）", () => {
    const err = {
      message: "HTTP 429",
      status: 429,
      body: {
        error: {
          message: "Unsupported MIME type: application/octet-stream",
          type: "upstream_error",
          param: "",
          code: "400",
        },
      },
    };

    const translated = extractErrorMessage(err);
    expect(translated).toBe(
      "这张图片的格式不支持，请换成 JPG、PNG 等常见格式后重试"
    );

    const result = classifyError(err);
    expect(result.type).toBe("unknown");
    expect(result.rawMessage).toBe(translated);
  });

  // ==========================================================================
  // network_error 分支扩展测试
  // ==========================================================================

  it("TypeError: terminated 识别为 network_error", () => {
    const result = classifyError(new Error("TypeError: terminated"));
    expect(result.type).toBe("network_error");
  });

  it("ECONNRESET 识别为 network_error", () => {
    const result = classifyError(new Error("ECONNRESET"));
    expect(result.type).toBe("network_error");
  });

  it("ETIMEDOUT 识别为 network_error", () => {
    const result = classifyError(new Error("ETIMEDOUT"));
    expect(result.type).toBe("network_error");
  });

  it("ECONNREFUSED 识别为 network_error", () => {
    const result = classifyError(new Error("ECONNREFUSED"));
    expect(result.type).toBe("network_error");
  });

  it("ENOTFOUND 识别为 network_error", () => {
    const result = classifyError(new Error("ENOTFOUND example.com"));
    expect(result.type).toBe("network_error");
  });

  it("socket hang up 识别为 network_error", () => {
    const result = classifyError(new Error("socket hang up"));
    expect(result.type).toBe("network_error");
  });

  it("非网络错误不误分类为 network_error", () => {
    const result = classifyError(new Error("some random error"));
    expect(result.type).toBe("unknown");
  });
});

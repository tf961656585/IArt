import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { classifyNetworkError } from "../task-engine-shared.cts";

const errorWithCode = (message: string, code: string) => {
  const error = new Error(message) as Error & { code?: string };
  error.code = code;
  return error;
};

const fetchFailedWithCode = (code: string) =>
  new TypeError("fetch failed", { cause: errorWithCode(`detail ${code}`, code) });

void describe("classifyNetworkError", () => {
  void it("reads the undici cause code instead of treating 'fetch failed' as one bucket", () => {
    const result = classifyNetworkError(fetchFailedWithCode("ECONNREFUSED"));
    assert.notEqual(result, null);
    if (result !== null) {
      assert.equal(result.kind, "connection_refused");
      assert.equal(result.causeCode, "ECONNREFUSED");
      assert.equal(result.userMessage, "服务商地址拒绝连接，请检查地址与端口是否正确后重新提交");
      assert.equal(result.retryable, true);
    }
  });

  void it("classifies DNS failures from the cause code", () => {
    const result = classifyNetworkError(fetchFailedWithCode("ENOTFOUND"));
    assert.notEqual(result, null);
    if (result !== null) {
      assert.equal(result.kind, "dns");
      assert.equal(result.userMessage, "找不到服务商地址，请检查地址是否正确、网络是否可用后重新提交");
    }
  });

  void it("classifies certificate failures as TLS, not as a generic network outage", () => {
    const result = classifyNetworkError(fetchFailedWithCode("CERT_HAS_EXPIRED"));
    assert.notEqual(result, null);
    if (result !== null) {
      assert.equal(result.kind, "tls");
      assert.match(result.userMessage, /加密连接未通过校验/);
    }
  });

  void it("classifies connect timeouts without claiming a configured request timeout", () => {
    const result = classifyNetworkError(fetchFailedWithCode("UND_ERR_CONNECT_TIMEOUT"));
    assert.notEqual(result, null);
    if (result !== null) {
      assert.equal(result.kind, "connection_unreachable");
      assert.match(result.userMessage, /连接服务商耗时过长/);
      assert.doesNotMatch(result.userMessage, /超时/);
    }
  });

  void it("classifies ETIMEDOUT as unreachable without using the word 超时", () => {
    const result = classifyNetworkError(new Error("ETIMEDOUT"));
    assert.notEqual(result, null);
    if (result !== null) {
      assert.equal(result.kind, "connection_unreachable");
      assert.doesNotMatch(result.userMessage, /超时/);
    }
  });

  void it("reports a long wait before an upstream disconnect with phase and seconds", () => {
    const result = classifyNetworkError(fetchFailedWithCode("ECONNRESET"), {
      phase: "requesting",
      elapsedMs: 15_400,
    });
    assert.notEqual(result, null);
    if (result !== null) {
      assert.equal(result.kind, "connection_dropped");
      assert.match(result.userMessage, /服务商在等待 15 秒后断开了连接/);
      assert.match(result.userMessage, /阶段：提交请求/);
      assert.match(result.userMessage, /降低图片尺寸或参考图数量/);
      assert.doesNotMatch(result.userMessage, /超时|断网|网络连接失败/);
    }
  });

  void it("reports a fast disconnect without inventing a long wait", () => {
    const result = classifyNetworkError(new Error("socket hang up"), {
      phase: "requesting",
      elapsedMs: 320,
    });
    assert.notEqual(result, null);
    if (result !== null) {
      assert.match(result.userMessage, /在「提交请求」阶段断开了连接/);
      assert.doesNotMatch(result.userMessage, /服务商在等待 1 秒/);
    }
  });

  void it("labels a drop while receiving results as a result delivery interruption", () => {
    const result = classifyNetworkError(fetchFailedWithCode("ECONNRESET"), {
      phase: "downloading",
      elapsedMs: 8_000,
    });
    assert.notEqual(result, null);
    if (result !== null) {
      assert.match(result.userMessage, /服务商在返回结果时断开了连接（已等待 8 秒）/);
    }
  });

  void it("reports undici response-window interruptions as no response, not as a timeout", () => {
    const result = classifyNetworkError(fetchFailedWithCode("UND_ERR_HEADERS_TIMEOUT"), {
      phase: "requesting",
      elapsedMs: 300_000,
    });
    assert.notEqual(result, null);
    if (result !== null) {
      assert.equal(result.kind, "response_interrupted");
      assert.match(result.userMessage, /服务商在等待 300 秒后仍未返回结果/);
      assert.match(result.userMessage, /阶段：提交请求/);
      assert.doesNotMatch(result.userMessage, /超时/);
    }
  });

  void it("classifies UND_ERR_SOCKET as a dropped connection", () => {
    const result = classifyNetworkError(new Error("UND_ERR_SOCKET"));
    assert.notEqual(result, null);
    if (result !== null) {
      assert.equal(result.kind, "connection_dropped");
    }
  });

  void it("classifies terminated as a dropped connection", () => {
    const result = classifyNetworkError(new TypeError("terminated"));
    assert.notEqual(result, null);
    if (result !== null) {
      assert.equal(result.kind, "connection_dropped");
      assert.match(result.userMessage, /断开了连接/);
    }
  });

  void it("classifies a bare 'fetch failed' as a connection attempt failure", () => {
    const result = classifyNetworkError(new TypeError("fetch failed"), {
      phase: "requesting",
    });
    assert.notEqual(result, null);
    if (result !== null) {
      assert.equal(result.kind, "request_failed");
      assert.match(result.userMessage, /没能连接到服务商（阶段：提交请求）/);
    }
  });

  void it("traverses nested causes", () => {
    const root = new TypeError("fetch failed", {
      cause: new Error("wrapper", { cause: errorWithCode("EAI_AGAIN", "EAI_AGAIN") }),
    });
    const result = classifyNetworkError(root);
    assert.notEqual(result, null);
    if (result !== null) {
      assert.equal(result.kind, "dns");
      assert.equal(result.causeCode, "EAI_AGAIN");
    }
  });

  void it("does not classify an AbortError", () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    assert.equal(classifyNetworkError(abort), null);
  });

  void it("returns null for unrecognized error", () => {
    assert.equal(classifyNetworkError(new Error("some random error")), null);
  });

  void it("returns null for null input", () => {
    assert.equal(classifyNetworkError(null), null);
  });

  void it("returns null for string error", () => {
    assert.equal(classifyNetworkError("string error"), null);
  });
});

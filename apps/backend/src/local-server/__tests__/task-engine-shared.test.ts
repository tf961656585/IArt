import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { classifyNetworkError } from "../task-engine-shared.cts";

void describe("classifyNetworkError", () => {
  void it("classifies terminated as network instability", () => {
    const result = classifyNetworkError(new TypeError("terminated"));
    assert.notEqual(result, null);
    if (result !== null) {
      assert.equal(result.userMessage, "网络连接波动，请重试");
    }
  });

  void it("classifies fetch failed as network failure", () => {
    const result = classifyNetworkError(new TypeError("fetch failed"));
    assert.notEqual(result, null);
    if (result !== null) {
      assert.equal(result.userMessage, "网络连接失败，请检查网络后重试");
    }
  });

  void it("classifies ECONNRESET as connection reset", () => {
    const result = classifyNetworkError(new Error("ECONNRESET"));
    assert.notEqual(result, null);
    if (result !== null) {
      assert.equal(result.userMessage, "网络连接中断，请重试");
    }
  });

  void it("classifies ECONNREFUSED as service unavailable", () => {
    const result = classifyNetworkError(new Error("ECONNREFUSED"));
    assert.notEqual(result, null);
    if (result !== null) {
      assert.equal(result.userMessage, "服务暂时不可用，请稍后重试");
    }
  });

  void it("classifies ETIMEDOUT as connection timeout", () => {
    const result = classifyNetworkError(new Error("ETIMEDOUT"));
    assert.notEqual(result, null);
    if (result !== null) {
      assert.equal(result.userMessage, "网络连接超时，请重试");
    }
  });

  void it("classifies ENOTFOUND as retryable network error", () => {
    const result = classifyNetworkError(new Error("ENOTFOUND"));
    assert.notEqual(result, null);
    if (result !== null) {
      assert.equal(result.retryable, true);
    }
  });

  void it("classifies socket hang up as retryable network error", () => {
    const result = classifyNetworkError(new Error("socket hang up"));
    assert.notEqual(result, null);
    if (result !== null) {
      assert.equal(result.retryable, true);
    }
  });

  void it("classifies UND_ERR_CONNECT_TIMEOUT as retryable network error", () => {
    const result = classifyNetworkError(new Error("UND_ERR_CONNECT_TIMEOUT"));
    assert.notEqual(result, null);
    if (result !== null) {
      assert.equal(result.retryable, true);
    }
  });

  void it("classifies UND_ERR_SOCKET as retryable network error", () => {
    const result = classifyNetworkError(new Error("UND_ERR_SOCKET"));
    assert.notEqual(result, null);
    if (result !== null) {
      assert.equal(result.retryable, true);
    }
  });

  void it("returns null for unrecognized error", () => {
    const result = classifyNetworkError(new Error("some random error"));
    assert.equal(result, null);
  });

  void it("returns null for null input", () => {
    const result = classifyNetworkError(null);
    assert.equal(result, null);
  });

  void it("returns null for string error", () => {
    const result = classifyNetworkError("string error");
    assert.equal(result, null);
  });
});

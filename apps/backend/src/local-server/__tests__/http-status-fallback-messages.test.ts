import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resolveHttpStatusUserMessage } from "../http-status-fallback-messages.cts";

void describe("http-status-fallback-messages", () => {
  void it("resolves exact covered status codes to their fallback messages", () => {
    assert.match(resolveHttpStatusUserMessage(451) ?? "", /地区|法律/);
    assert.match(resolveHttpStatusUserMessage(409) ?? "", /冲突/);
    assert.match(resolveHttpStatusUserMessage(422) ?? "", /参数/);
    assert.match(resolveHttpStatusUserMessage(429) ?? "", /限流/);
  });

  void it("resolves any 5xx status to the server error message", () => {
    for (const status of [500, 502, 503, 599]) {
      const userMessage = resolveHttpStatusUserMessage(status);
      assert.ok(userMessage, `expected fallback for HTTP ${status}`);
      assert.match(userMessage ?? "", /远端服务|暂时不可用/);
    }
  });

  void it("returns null for a 2xx status", () => {
    assert.equal(resolveHttpStatusUserMessage(200), null);
  });

  void it("returns null for null and undefined", () => {
    assert.equal(resolveHttpStatusUserMessage(null), null);
    assert.equal(resolveHttpStatusUserMessage(undefined), null);
  });

  void it("returns null for non-covered status codes", () => {
    assert.equal(resolveHttpStatusUserMessage(444), null);
  });
});

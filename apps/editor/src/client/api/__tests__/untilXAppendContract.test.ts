import { describe, expect, it } from "vitest";
import { UnifiedGenerationUntilXAppendRequestSchema } from "@iart/contracts/unified-generation";

const baseAppendRequest = {
  path: "/tmp/project",
  nodeGraphId: "graph-1",
  sourceNodeId: "source-1",
  targetNodeId: "result-1",
  executionId: "exec-1",
  batchId: "batch-1",
  target_success_count: 2,
  model_id: "model-1",
  append_count: 1,
};

describe("UnifiedGenerationUntilXAppendRequestSchema", () => {
  it("拒绝没有直接 payload 的 append 请求", () => {
    expect(() =>
      UnifiedGenerationUntilXAppendRequestSchema.parse(baseAppendRequest),
    ).toThrow(/payload/);
  });

  it("拒绝仅携带历史 snapshot 引用的 append 请求", () => {
    expect(() =>
      UnifiedGenerationUntilXAppendRequestSchema.parse({
        ...baseAppendRequest,
        payload_snapshot_ref: {
          batch_id: "batch-1",
        },
      }),
    ).toThrow(/direct payload/);
  });

  it("允许直接携带业务 arguments 进行 append", () => {
    expect(
      UnifiedGenerationUntilXAppendRequestSchema.parse({
        ...baseAppendRequest,
        arguments: {
          prompt: "dancing",
        },
      }),
    ).toMatchObject({
      arguments: {
        prompt: "dancing",
      },
    });
  });

  it("透传 policyTierKey 档位字段", () => {
    expect(
      UnifiedGenerationUntilXAppendRequestSchema.parse({
        ...baseAppendRequest,
        arguments: {
          prompt: "dancing",
        },
        policyTierKey: "tier-pro",
      }),
    ).toMatchObject({
      policyTierKey: "tier-pro",
    });
  });
});

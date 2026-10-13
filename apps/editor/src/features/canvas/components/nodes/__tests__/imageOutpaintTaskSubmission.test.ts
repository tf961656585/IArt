import { describe, expect, it } from "vitest";
import { bindOutpaintTaskInfo } from "../imageOutpaintTaskSubmission";
import { createNodeTaskInfoFixture } from "../../__tests__/fixtures/canvasTestBuilders";

describe("imageOutpaintTaskSubmission", () => {
  it("绑定扩图任务信息时保留稳定 taskId，并可采纳状态字段", () => {
    const next = bindOutpaintTaskInfo({
      existingTaskInfo: createNodeTaskInfoFixture({
        taskId: "task-1",
        modelId: "gemini-3-pro-image",
        taskIndex: 0,
        createdAt: 100,
        updatedAt: 100,
      }),
      modelId: "gemini-3-pro-image",
      createdAtFallback: 100,
      patch: {
        remoteRequestId: "remote-1",
        status: "submitting",
      },
      now: 200,
    });

    expect(next).toEqual({
      taskId: "task-1",
      modelId: "gemini-3-pro-image",
      taskIndex: 0,
      createdAt: 100,
      updatedAt: 200,
      progress: undefined,
      error: undefined,
      failure: undefined,
      batchId: undefined,
      status: "submitting",
      remoteRequestId: "remote-1",
    });
  });
});

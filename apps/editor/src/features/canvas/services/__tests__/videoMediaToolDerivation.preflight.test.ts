import { beforeEach, describe, expect, it, vi } from "vitest";
import { trimVideo } from "@/client/api/videoTrim";
import { captureVideoFrame } from "@/client/api/videoFrameCapture";
import { getCurrentProjectPath } from "../../storage/backend";
import {
  runVideoFrameCaptureDerivation,
  runVideoTrimDerivation,
} from "../videoMediaToolDerivation";

vi.mock("@/client/api/videoTrim", () => ({ trimVideo: vi.fn() }));
vi.mock("@/client/api/videoFrameCapture", () => ({
  captureVideoFrame: vi.fn(),
}));
vi.mock("../../storage/backend", () => ({
  getCurrentProjectPath: vi.fn(async () => "/tmp/project"),
}));

const mockedTrimVideo = vi.mocked(trimVideo);
const mockedCaptureVideoFrame = vi.mocked(captureVideoFrame);
const mockedGetCurrentProjectPath = vi.mocked(getCurrentProjectPath);

describe("videoMediaToolDerivation 前置校验（共享服务层兜底）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("裁切：源资产不可用（空 sourceUrl）时不发起远端加工请求", async () => {
    await expect(
      runVideoTrimDerivation({
        sourceNodeId: "video-1",
        sourceAssetId: undefined,
        sourceSlotId: undefined,
        sourceUrl: "   ",
        startTime: 0,
        endTime: 1,
        withAudio: false,
        selectNodes: vi.fn(),
      }),
    ).rejects.toThrow("视频已被移除或还没取回本地，请重新选择后再裁切");

    expect(mockedTrimVideo).not.toHaveBeenCalled();
    expect(mockedGetCurrentProjectPath).not.toHaveBeenCalled();
  });

  it("截帧：源资产不可用（空 sourceUrl）时不发起远端加工请求", async () => {
    await expect(
      runVideoFrameCaptureDerivation({
        sourceNodeId: "video-1",
        sourceAssetId: undefined,
        sourceSlotId: undefined,
        sourceUrl: "",
        timeSec: 1,
        selectNodes: vi.fn(),
      }),
    ).rejects.toThrow("视频已被移除或还没取回本地，请重新选择后再截帧");

    expect(mockedCaptureVideoFrame).not.toHaveBeenCalled();
    expect(mockedGetCurrentProjectPath).not.toHaveBeenCalled();
  });
});

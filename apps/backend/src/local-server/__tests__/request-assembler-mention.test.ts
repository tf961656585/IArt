import assert from "node:assert/strict";
import test from "node:test";

import {
  generateMentionId,
  injectMentionsIntoReferenceBlobs,
} from "../request-assembler-mention.cts";

/**
 * referenceBlobs mention 注入单测（spec §5.4 / §7：连线=上传、@=mention）。
 *
 * 覆盖：
 * - 组偏移：image 组从 0 开始、video 组从 N_image 开始、audio 组从 N_image+N_video 开始
 * - 仅提示词 @ 的素材带 mention；未 @ 的不带
 * - mention.id 为 21 位 base64url 随机串（spec §6.4）
 * - 边界：mention_map 为空/undefined → 无操作；越界 index → 跳过不 throw
 * - mediaInputFields 以 media_kind 作桶 key（video/audio）时的兜底计数
 */

type BlobEntry = { id: string; usage: string; mention?: { id: string; label: string } };

const buildPayload = () => ({
  body: {
    referenceBlobs: [
      { id: "img-0", usage: "style" },
      { id: "vid-0", usage: "source" },
      { id: "aud-0", usage: "source" },
    ],
  },
});

const readMentions = (payload: ReturnType<typeof buildPayload>): (BlobEntry["mention"])[] => {
  const blobs = payload.body.referenceBlobs as BlobEntry[];
  return blobs.map((entry) => entry.mention);
};

void test("injectMentionsIntoReferenceBlobs: 仅 @ 的图与视频带 mention，音频不带", () => {
  const payload = buildPayload();
  injectMentionsIntoReferenceBlobs(
    payload,
    {
      Image1: { media_kind: "image", index: 0 },
      Video1: { media_kind: "video", index: 0 },
    },
    {
      reference_images: [{}],
      reference_videos: [{}],
      reference_audios: [{}],
    },
  );

  const mentions = readMentions(payload);
  const imageMention = mentions[0];
  const videoMention = mentions[1];
  assert.ok(imageMention, "referenceBlobs[0]（图）应带 mention");
  assert.equal(imageMention.label, "Image1");
  assert.equal(imageMention.id.length, 21);
  assert.match(imageMention.id, /^[A-Za-z0-9_-]+$/);
  assert.ok(videoMention, "referenceBlobs[1]（视频）应带 mention");
  assert.equal(videoMention.label, "Video1");
  assert.equal(videoMention.id.length, 21);
  assert.equal(mentions[2], undefined, "referenceBlobs[2]（未 @ 的音频）不应带 mention");
});

void test("injectMentionsIntoReferenceBlobs: 组偏移按 N_image/N_video 计算（两图一视频）", () => {
  const payload = {
    body: {
      referenceBlobs: [
        { id: "img-0", usage: "style" },
        { id: "img-1", usage: "style" },
        { id: "vid-0", usage: "source" },
      ],
    },
  };
  injectMentionsIntoReferenceBlobs(
    payload,
    {
      Image2: { media_kind: "image", index: 1 },
      Video1: { media_kind: "video", index: 0 },
    },
    {
      reference_images: [{}, {}],
      reference_videos: [{}],
      reference_audios: [],
    },
  );

  const blobs = payload.body.referenceBlobs as BlobEntry[];
  const blob0 = blobs[0];
  const blob1 = blobs[1];
  const blob2 = blobs[2];
  assert.ok(blob0);
  assert.ok(blob1);
  assert.ok(blob2);
  assert.equal(blob1.mention?.label, "Image2", "Image2 → 图组内 index=1 → 绝对下标 1");
  assert.equal(blob2.mention?.label, "Video1", "Video1 → 组偏移 N_image=2 → 绝对下标 2");
  assert.equal(blob0.mention, undefined);
});

void test("injectMentionsIntoReferenceBlobs: 音频组偏移 = N_image + N_video", () => {
  const payload = buildPayload();
  injectMentionsIntoReferenceBlobs(
    payload,
    {
      Audio1: { media_kind: "audio", index: 0 },
    },
    {
      reference_images: [{}],
      reference_videos: [{}],
      reference_audios: [{}],
    },
  );

  const mentions = readMentions(payload);
  assert.equal(mentions[0], undefined);
  assert.equal(mentions[1], undefined);
  assert.equal(mentions[2]?.label, "Audio1", "Audio1 → 组偏移 1+1=2 → 绝对下标 2");
});

void test("injectMentionsIntoReferenceBlobs: mention_map 为空对象时无操作", () => {
  const payload = buildPayload();
  const before = JSON.stringify(payload);
  injectMentionsIntoReferenceBlobs(
    payload,
    {},
    {
      reference_images: [{}],
      reference_videos: [{}],
      reference_audios: [{}],
    },
  );
  assert.equal(JSON.stringify(payload), before);
});

void test("injectMentionsIntoReferenceBlobs: mention_map 为 undefined 时无操作", () => {
  const payload = buildPayload();
  const before = JSON.stringify(payload);
  injectMentionsIntoReferenceBlobs(
    payload,
    undefined,
    {
      reference_images: [{}],
      reference_videos: [{}],
      reference_audios: [{}],
    },
  );
  assert.equal(JSON.stringify(payload), before);
});

void test("injectMentionsIntoReferenceBlobs: 越界 index 跳过不 throw", () => {
  const payload = buildPayload();
  injectMentionsIntoReferenceBlobs(
    payload,
    {
      Video9: { media_kind: "video", index: 8 },
    },
    {
      reference_images: [{}],
      reference_videos: [{}],
      reference_audios: [{}],
    },
  );
  const mentions = readMentions(payload);
  assert.equal(mentions[1], undefined, "越界 index 不应注入 mention");
});

void test("injectMentionsIntoReferenceBlobs: 畸形条目（非法 media_kind / index）跳过不 throw", () => {
  const payload = buildPayload();
  injectMentionsIntoReferenceBlobs(
    payload,
    {
      BadKind: { media_kind: "gif", index: 0 },
      BadIndex: { media_kind: "image", index: -1 },
      NotObject: "not-an-object",
    },
    {
      reference_images: [{}],
      reference_videos: [{}],
      reference_audios: [{}],
    },
  );
  const mentions = readMentions(payload);
  assert.equal(mentions[0], undefined);
  assert.equal(mentions[1], undefined);
  assert.equal(mentions[2], undefined);
});

void test("injectMentionsIntoReferenceBlobs: mediaInputFields 以 media_kind 为桶 key 时兜底计数", () => {
  const payload = buildPayload();
  injectMentionsIntoReferenceBlobs(
    payload,
    {
      Video1: { media_kind: "video", index: 0 },
    },
    {
      reference_images: [{}],
      video: [{}],
      audio: [{}],
    },
  );
  const mentions = readMentions(payload);
  assert.equal(mentions[1]?.label, "Video1", "video 桶缺 canonical field_key 时用 media_kind 兜底");
});

void test("injectMentionsIntoReferenceBlobs: 目标元素不是对象（嵌套数组形态）时跳过不 throw", () => {
  // 当前 seedance 资产 DSL 的 compact_array([map_array...]) 会产出嵌套数组
  // [[image],[video],[audio]]；嵌套形态下元素是数组而非对象，按身份校验跳过。
  const payload = {
    body: {
      referenceBlobs: [
        [{ id: "img-0", usage: "style" }],
        [{ id: "vid-0", usage: "source" }],
        [{ id: "aud-0", usage: "source" }],
      ],
    },
  };
  injectMentionsIntoReferenceBlobs(
    payload,
    {
      Image1: { media_kind: "image", index: 0 },
    },
    {
      reference_images: [{}],
      reference_videos: [{}],
      reference_audios: [{}],
    },
  );
  const blobs = payload.body.referenceBlobs as Array<Array<BlobEntry>>;
  const imageGroup = blobs[0];
  assert.ok(imageGroup);
  const imageEntry = imageGroup[0];
  assert.ok(imageEntry);
  assert.equal(imageEntry.mention, undefined, "嵌套形态下目标元素是数组，不应注入");
});

void test("generateMentionId: 返回 21 位 base64url 随机串且每次不同", () => {
  const first = generateMentionId();
  const second = generateMentionId();
  assert.equal(first.length, 21);
  assert.equal(second.length, 21);
  assert.match(first, /^[A-Za-z0-9_-]{21}$/);
  assert.notEqual(first, second);
});

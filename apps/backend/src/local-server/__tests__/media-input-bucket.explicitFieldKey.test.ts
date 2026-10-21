/**
 * 媒体分桶的显式字段绑定与逐必填位判空。
 *
 * 这些测试钉住的是一个**曾经的静默错误**：旧实现按「媒体类型 → 字段键」建单值映射，
 * 同类型多个素材位时后写覆盖先写，于是可灵图生视频（首帧必填 + 尾帧可选，都是图片）的
 * 图片会被整体倒进尾帧位，首帧恒空——不报错，只生成一张语义错了的图。
 *
 * 三类判据：
 * 1. 显式 field_key 优先，且必须落在该模型的候选位内；
 * 2. 无显式绑定时，唯一候选位按类型兜底（保持既有单素材位模型的行为不变）；
 * 3. 多候选位且无显式绑定时明确失败并点名候选，不做顺序启发式。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { normalizeMediaInputBuckets } from '../media-input-bucket-normalizer.cts';

/** 两图片素材位的投影（可灵图生视频形态：首帧 + 尾帧，字段键不同但组件都是 imageUpload）。 */
const makeTwoImageSlotProjection = () => ({
  capability: { input_modalities: ['text', 'image'] },
  parameter_schema: {
    fields: [
      { field_key: 'firstFrameImage', component: 'imageUpload', required: true },
      { field_key: 'lastFrameImage', component: 'imageUpload', required: false },
    ],
  },
});

/** 单图片素材位的投影（图像编辑形态）。 */
const makeSingleImageSlotProjection = () => ({
  capability: { input_modalities: ['text', 'image'] },
  parameter_schema: {
    fields: [{ field_key: 'images', component: 'imageUpload', required: false }],
  },
});

const makeTmpImage = (): { dir: string; file: string } => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-slot-bucket-'));
  const file = path.join(dir, 'frame.png');
  fs.writeFileSync(file, Buffer.from('fake-png-data'));
  return { dir, file };
};

void test('分桶：显式 field_key 指定首帧时图片进 firstFrameImage，不进尾帧位', async () => {
  const { dir, file } = makeTmpImage();
  try {
    const buckets = await normalizeMediaInputBuckets(
      [
        {
          media_kind: 'image',
          source_kind: 'attachment',
          value: file,
          mime_type: 'image/png',
          filename: 'frame.png',
          field_key: 'firstFrameImage',
        },
      ],
      makeTwoImageSlotProjection(),
    );
    const first = buckets['firstFrameImage'];
    assert.ok(Array.isArray(first) && first.length === 1, '首帧位必须收到这张图');
    const last = buckets['lastFrameImage'];
    assert.equal(last, undefined, '尾帧位不该被同类型媒体误塞（旧缺陷的现场）');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

void test('分桶：两张图分别绑定首帧与尾帧，各进各位', async () => {
  const a = makeTmpImage();
  const b = makeTmpImage();
  try {
    const buckets = await normalizeMediaInputBuckets(
      [
        {
          media_kind: 'image',
          source_kind: 'attachment',
          value: a.file,
          mime_type: 'image/png',
          filename: 'first.png',
          field_key: 'firstFrameImage',
        },
        {
          media_kind: 'image',
          source_kind: 'attachment',
          value: b.file,
          mime_type: 'image/png',
          filename: 'last.png',
          field_key: 'lastFrameImage',
        },
      ],
      makeTwoImageSlotProjection(),
    );
    assert.equal(buckets['firstFrameImage']?.length, 1);
    assert.equal(buckets['lastFrameImage']?.length, 1);
  } finally {
    fs.rmSync(a.dir, { recursive: true, force: true });
    fs.rmSync(b.dir, { recursive: true, force: true });
  }
});

void test('分桶：多候选位且无显式绑定 → 明确失败并点名候选位', async () => {
  const { dir, file } = makeTmpImage();
  try {
    await assert.rejects(
      () =>
        normalizeMediaInputBuckets(
          [
            {
              media_kind: 'image',
              source_kind: 'attachment',
              value: file,
              mime_type: 'image/png',
              filename: 'frame.png',
            },
          ],
          makeTwoImageSlotProjection(),
        ),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.ok(message.includes('field_key'), '错误必须点名缺什么');
        assert.ok(message.includes('firstFrameImage'), '错误必须列出候选位之一');
        assert.ok(message.includes('lastFrameImage'), '错误必须列出候选位之二');
        return true;
      },
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

void test('分桶：单候选位无显式绑定 → 按类型兜底（单素材位模型行为不变）', async () => {
  const { dir, file } = makeTmpImage();
  try {
    const buckets = await normalizeMediaInputBuckets(
      [
        {
          media_kind: 'image',
          source_kind: 'attachment',
          value: file,
          mime_type: 'image/png',
          filename: 'frame.png',
        },
      ],
      makeSingleImageSlotProjection(),
    );
    assert.equal(buckets['images']?.length, 1, '唯一候选位应兜底接收');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

void test('分桶：显式 field_key 不在该模型的候选位内 → 明确失败', async () => {
  const { dir, file } = makeTmpImage();
  try {
    await assert.rejects(
      () =>
        normalizeMediaInputBuckets(
          [
            {
              media_kind: 'image',
              source_kind: 'attachment',
              value: file,
              mime_type: 'image/png',
              filename: 'frame.png',
              field_key: 'notAFieldOfThisModel',
            },
          ],
          makeSingleImageSlotProjection(),
        ),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.ok(message.includes('notAFieldOfThisModel'));
        return true;
      },
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

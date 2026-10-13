import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import sharp from 'sharp';
import { applyDifferenceKey } from '../image-difference-key.cts';

/**
 * 像素级验证 applyDifferenceKey。
 * 覆盖:alpha 映射正确性、尺寸不一致报错、RGBA 输入(4通道)正确抽取。
 */
const writePng = async (dir: string, name: string, rgb: number[], width: number, height: number, channels: 3 | 4) => {
  const filePath = path.join(dir, name);
  await sharp(Buffer.from(rgb), { raw: { width, height, channels } }).png().toFile(filePath);
  return filePath;
};

const readAlphas = async (buffer: Buffer) => {
  // applyDifferenceKey 返回的是 PNG 编码字节(非 raw),需作为输入文件解码
  const { data } = await sharp(buffer)
    .raw()
    .toBuffer({ resolveWithObject: true });
  const alphas: number[] = [];
  for (let i = 3; i < data.length; i += 4) {
    alphas.push(data[i] || 0);
  }
  return alphas;
};

void test('applyDifferenceKey maps identical pixels to foreground and differing pixels to background', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'diff-key-'));
  // 2x2 RGB: A=红绿蓝白, B=红(同)蓝(异)蓝(同)黑(异)
  const pathA = await writePng(tmpDir, 'a.png', [
    255, 0, 0, 0, 255, 0,
    0, 0, 255, 255, 255, 255,
  ], 2, 2, 3);
  const pathB = await writePng(tmpDir, 'b.png', [
    255, 0, 0, 0, 0, 255,
    0, 0, 255, 0, 0, 0,
  ], 2, 2, 3);

  const result = await applyDifferenceKey(pathA, pathB, { threshold: 10, softness: 0 });
  assert.equal(result.info.width, 2);
  assert.equal(result.info.height, 2);

  const alphas = await readAlphas(result.buffer);
  // pixel0 A=B diff=0 → 前景 255; pixel1 diff≈360 → 背景 0; pixel2 A=B → 255; pixel3 diff≈441 → 0
  assert.deepEqual(alphas, [255, 0, 255, 0]);
});

void test('applyDifferenceKey throws DIFFERENCE_KEY_SIZE_MISMATCH for different dimensions', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'diff-key-size-'));
  const pathA = await writePng(tmpDir, 'a.png', [255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255], 2, 2, 3);
  const pathB = await writePng(tmpDir, 'b.png', [255, 0, 0, 0, 255, 0, 0, 0, 255], 3, 1, 3);

  await assert.rejects(
    () => applyDifferenceKey(pathA, pathB, { threshold: 10, softness: 0 }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'DIFFERENCE_KEY_SIZE_MISMATCH');
      return true;
    },
  );
});

void test('applyDifferenceKey correctly extracts RGB from 4-channel RGBA input', async () => {
  // 回归测试:4 通道 RGBA 必须按 4 字节步长抽取 RGB,不能错位。
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'diff-key-rgba-'));
  const pathA = await writePng(tmpDir, 'rgba-a.png', [
    255, 0, 0, 255, 0, 255, 0, 255,
  ], 2, 1, 4);
  const pathB = await writePng(tmpDir, 'rgba-b.png', [
    255, 0, 0, 255, 0, 0, 255, 255,
  ], 2, 1, 4);

  const result = await applyDifferenceKey(pathA, pathB, { threshold: 10, softness: 0 });
  const alphas = await readAlphas(result.buffer);
  // pixel0 A=B=(255,0,0) diff=0 → 255; pixel1 A=(0,255,0) B=(0,0,255) diff≈360 → 0
  assert.deepEqual(alphas, [255, 0]);
});

import assert from "node:assert/strict";
import test from "node:test";

import { computeSpriteSheetLayout } from "../video-sprite-sheet.cts";

void test("computeSpriteSheetLayout: 30fps * 1 * 1s = 30 frames, square video", () => {
  const layout = computeSpriteSheetLayout(30, 1, 0, 1, 1920, 1080);

  assert.ok(layout.frameCount === 30, `frameCount should be 30, got ${layout.frameCount}`);
  assert.ok(layout.rows * layout.cols >= 30, `rows*cols should >= 30, got ${layout.rows * layout.cols}`);
  assert.ok(layout.atlasWidth === layout.frameWidth * layout.cols, `atlasWidth should equal frameWidth * cols`);
  assert.ok(layout.atlasHeight === layout.frameHeight * layout.rows, `atlasHeight should equal frameHeight * rows`);

  assert.ok(layout.rows >= 1, "no empty rows");
  assert.ok(layout.cols >= 1, "no empty cols");

  // 1920x1080 x 30 frames triggers safety scaling (atlasWidth > 8192)
  assert.ok(layout.atlasWidth <= 8192, `atlasWidth should <= 8192, got ${layout.atlasWidth}`);
  assert.ok(layout.atlasHeight <= 8192, `atlasHeight should <= 8192, got ${layout.atlasHeight}`);
  const ratioTolerance = 0.01;
  assert.ok(
    Math.abs(layout.frameWidth / layout.frameHeight - 1920 / 1080) <= ratioTolerance,
    `frameWidth/frameHeight ratio should preserve 16:9`,
  );
});

void test("computeSpriteSheetLayout: 30fps * 0.5 * 2s = 30 frames", () => {
  const layout = computeSpriteSheetLayout(30, 0.5, 0, 2, 1920, 1080);

  assert.ok(layout.frameCount === 30, `frameCount should be 30, got ${layout.frameCount}`);
  assert.ok(layout.rows * layout.cols >= 30, `rows*cols should >= 30, got ${layout.rows * layout.cols}`);
  assert.ok(layout.atlasWidth === layout.frameWidth * layout.cols, `atlasWidth should equal frameWidth * cols`);
  assert.ok(layout.atlasHeight === layout.frameHeight * layout.rows, `atlasHeight should equal frameHeight * rows`);

  // 1920x1080 x 30 frames triggers safety scaling
  assert.ok(layout.atlasWidth <= 8192, `atlasWidth should <= 8192, got ${layout.atlasWidth}`);
  assert.ok(layout.atlasHeight <= 8192, `atlasHeight should <= 8192, got ${layout.atlasHeight}`);
  const ratioTolerance = 0.01;
  assert.ok(
    Math.abs(layout.frameWidth / layout.frameHeight - 1920 / 1080) <= ratioTolerance,
    `frameWidth/frameHeight ratio should preserve 16:9`,
  );
});

void test("computeSpriteSheetLayout: 24fps * 1 * 0.5s = 12 frames, small frame count", () => {
  const layout = computeSpriteSheetLayout(24, 1, 0, 0.5, 1920, 1080);

  assert.ok(layout.frameCount === 12, `frameCount should be 12, got ${layout.frameCount}`);
  assert.ok(layout.rows * layout.cols >= 12, `rows*cols should >= 12, got ${layout.rows * layout.cols}`);
  assert.ok(layout.atlasWidth === layout.frameWidth * layout.cols, `atlasWidth should equal frameWidth * cols`);
  assert.ok(layout.atlasHeight === layout.frameHeight * layout.rows, `atlasHeight should equal frameHeight * rows`);
  // 12 frames: cols=4, atlasWidth=7680 < 8192, no scaling triggered
  assert.ok(layout.frameWidth === 1920, `frameWidth should be 1920, got ${layout.frameWidth}`);
  assert.ok(layout.frameHeight === 1080, `frameHeight should be 1080, got ${layout.frameHeight}`);
});

void test("computeSpriteSheetLayout: 1fps * 1 * 1s = 1 frame, minimal case", () => {
  const layout = computeSpriteSheetLayout(1, 1, 0, 1, 640, 480);

  assert.ok(layout.frameCount === 1, `frameCount should be 1, got ${layout.frameCount}`);
  assert.ok(layout.rows === 1, `rows should be 1, got ${layout.rows}`);
  assert.ok(layout.cols === 1, `cols should be 1, got ${layout.cols}`);
  // 1 frame: no scaling, frameWidth = videoWidth
  assert.ok(layout.frameWidth === 640, `frameWidth should be 640, got ${layout.frameWidth}`);
  assert.ok(layout.frameHeight === 480, `frameHeight should be 480, got ${layout.frameHeight}`);
});

void test("computeSpriteSheetLayout: atlas dimensions are consistent", () => {
  const layout = computeSpriteSheetLayout(30, 1, 0, 2, 1920, 1080);

  assert.ok(
    layout.atlasWidth === layout.frameWidth * layout.cols,
    `atlasWidth (${layout.atlasWidth}) !== frameWidth (${layout.frameWidth}) * cols (${layout.cols})`,
  );
  assert.ok(
    layout.atlasHeight === layout.frameHeight * layout.rows,
    `atlasHeight (${layout.atlasHeight}) !== frameHeight (${layout.frameHeight}) * rows (${layout.rows})`,
  );
});

void test("computeSpriteSheetLayout: non-square video maintains aspect ratio in layout", () => {
  const layout = computeSpriteSheetLayout(30, 1, 0, 1, 3840, 2160);

  assert.ok(layout.frameCount === 30, `frameCount should be 30, got ${layout.frameCount}`);

  assert.ok(layout.rows >= 1, "no empty rows");
  assert.ok(layout.cols >= 1, "no empty cols");

  // 3840x2160 x 30 frames triggers safety scaling
  assert.ok(layout.atlasWidth <= 8192, `atlasWidth should <= 8192, got ${layout.atlasWidth}`);
  assert.ok(layout.atlasHeight <= 8192, `atlasHeight should <= 8192, got ${layout.atlasHeight}`);
  const ratioTolerance = 0.01;
  assert.ok(
    Math.abs(layout.frameWidth / layout.frameHeight - 3840 / 2160) <= ratioTolerance,
    `frameWidth/frameHeight ratio should preserve 16:9`,
  );
});

void test("computeSpriteSheetLayout: zero duration yields at least 1 frame", () => {
  const layout = computeSpriteSheetLayout(30, 1, 5, 5, 1920, 1080);

  assert.ok(layout.frameCount >= 1, `frameCount should be at least 1, got ${layout.frameCount}`);
  assert.ok(layout.rows >= 1, "no empty rows");
  assert.ok(layout.cols >= 1, "no empty cols");
});

void test("computeSpriteSheetLayout: no empty last row", () => {
  const layout = computeSpriteSheetLayout(30, 1, 0, 1, 1920, 1080);

  const totalSlots = layout.rows * layout.cols;
  assert.ok(totalSlots >= layout.frameCount, `totalSlots (${totalSlots}) should >= frameCount (${layout.frameCount})`);

  const lastRowFrames = layout.frameCount - (layout.rows - 1) * layout.cols;
  assert.ok(lastRowFrames >= 1, `last row should have at least 1 frame, got ${lastRowFrames}`);
});

void test("computeSpriteSheetLayout: portrait video 1080x1920", () => {
  const layout = computeSpriteSheetLayout(30, 1, 0, 1, 1080, 1920);

  assert.ok(layout.frameCount === 30, `frameCount should be 30, got ${layout.frameCount}`);
  assert.ok(layout.rows * layout.cols >= 30, `rows*cols should >= 30, got ${layout.rows * layout.cols}`);
  assert.ok(layout.rows >= 1, "no empty rows");
  assert.ok(layout.cols >= 1, "no empty cols");

  // 1080x1920 x 30 frames triggers safety scaling
  assert.ok(layout.atlasWidth <= 8192, `atlasWidth should <= 8192, got ${layout.atlasWidth}`);
  assert.ok(layout.atlasHeight <= 8192, `atlasHeight should <= 8192, got ${layout.atlasHeight}`);
  const ratioTolerance = 0.02;
  assert.ok(
    Math.abs(layout.frameWidth / layout.frameHeight - 1080 / 1920) <= ratioTolerance,
    `frameWidth/frameHeight ratio should preserve 9:16`,
  );
});

void test("computeSpriteSheetLayout: large frame count scales atlas size", () => {
  const layout = computeSpriteSheetLayout(60, 1, 0, 10, 3840, 2160);

  assert.ok(layout.frameCount === 600, `frameCount should be 600, got ${layout.frameCount}`);
  assert.ok(layout.atlasWidth <= 8192, `atlasWidth should <= 8192, got ${layout.atlasWidth}`);
  assert.ok(layout.atlasHeight <= 8192, `atlasHeight should <= 8192, got ${layout.atlasHeight}`);
  const ratioTolerance = 0.01;
  assert.ok(
    Math.abs(layout.frameWidth / layout.frameHeight - 3840 / 2160) <= ratioTolerance,
    `frameWidth/frameHeight ratio should preserve 16:9`,
  );
});

void test("computeSpriteSheetLayout: landscape 1920x1080 maintains 16:9 ratio", () => {
  const layout = computeSpriteSheetLayout(30, 1, 0, 1, 1920, 1080);
  const ratio = layout.frameWidth / layout.frameHeight;
  const expected = 1920 / 1080;
  assert.ok(
    Math.abs(ratio - expected) <= 0.01,
    `frameWidth/frameHeight ratio ${ratio} should be close to ${expected}`,
  );
});

void test("computeSpriteSheetLayout: portrait 1080x1920 maintains 9:16 ratio", () => {
  const layout = computeSpriteSheetLayout(30, 1, 0, 1, 1080, 1920);
  const ratio = layout.frameWidth / layout.frameHeight;
  const expected = 1080 / 1920;
  assert.ok(
    Math.abs(ratio - expected) <= 0.02,
    `frameWidth/frameHeight ratio ${ratio} should be close to ${expected}`,
  );
});

void test("computeSpriteSheetLayout: 4K 3840x2160 maintains 16:9 ratio", () => {
  const layout = computeSpriteSheetLayout(30, 1, 0, 1, 3840, 2160);
  const ratio = layout.frameWidth / layout.frameHeight;
  const expected = 3840 / 2160;
  assert.ok(
    Math.abs(ratio - expected) <= 0.01,
    `frameWidth/frameHeight ratio ${ratio} should be close to ${expected}`,
  );
});

void test("computeSpriteSheetLayout: square 1080x1080 maintains 1:1 ratio", () => {
  const layout = computeSpriteSheetLayout(30, 1, 0, 1, 1080, 1080);
  assert.ok(
    layout.frameWidth === layout.frameHeight,
    `frameWidth ${layout.frameWidth} should equal frameHeight ${layout.frameHeight}`,
  );
});

void test("computeSpriteSheetLayout: 4K x 600 frames triggers safety scaling and maintains ratio", () => {
  const layout = computeSpriteSheetLayout(60, 1, 0, 20, 3840, 2160);
  assert.ok(layout.atlasWidth <= 8192, `atlasWidth should <= 8192, got ${layout.atlasWidth}`);
  assert.ok(layout.atlasHeight <= 8192, `atlasHeight should <= 8192, got ${layout.atlasHeight}`);
  const ratio = layout.frameWidth / layout.frameHeight;
  const expected = 3840 / 2160;
  assert.ok(
    Math.abs(ratio - expected) <= 0.01,
    `frameWidth/frameHeight ratio ${ratio} should be close to ${expected}`,
  );
});

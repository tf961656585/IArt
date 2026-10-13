import { describe, expect, it } from 'vitest';
import {
  computeByLevelAndAspect,
  computeByPixelBudgetAndAspect,
  formatResolution,
  isValidConstrainedResolution,
  normalizeConstrainedImageSizeValue,
  type ImageSizeSelectorConstrainedConstraints,
  type ImageSizeSelectorConstrainedSizeLevel,
} from '../imageSizeConstrainedResolutionMath';

const constraints: ImageSizeSelectorConstrainedConstraints = {
  dimensionMultiple: 16,
  maxLongEdge: 3840,
  minPixels: 655_360,
  maxPixels: 8_294_400,
  maxAspectRatio: 3,
};

const level1k: ImageSizeSelectorConstrainedSizeLevel = {
  id: '1k',
  label: '1K',
  pixelBudget: 1_048_576,
};

const level2k: ImageSizeSelectorConstrainedSizeLevel = {
  id: '2k',
  label: '2K',
  pixelBudget: 4_194_304,
};

const level4k: ImageSizeSelectorConstrainedSizeLevel = {
  id: '4k',
  label: '4K',
  pixelBudget: 8_294_400,
};

const expectValid = (resolution: { width: number; height: number }) => {
  expect(isValidConstrainedResolution(resolution, constraints)).toBe(true);
};

describe('imageSizeConstrainedResolutionMath 像素预算语义', () => {
  it('验收基准：1K + 16:9 是真实 16:9 量级（1360x768），不再是 8:5', () => {
    const resolution = computeByLevelAndAspect(level1k, 16 / 9, constraints);
    expect(formatResolution(resolution.width, resolution.height)).toBe('1360x768');
    expectValid(resolution);
  });

  it('验收基准：4K + 1:1 = 2880x2880', () => {
    const resolution = computeByLevelAndAspect(level4k, 1, constraints);
    expect(formatResolution(resolution.width, resolution.height)).toBe('2880x2880');
    expectValid(resolution);
  });

  it('验收基准：4K + 16:9 = 3840x2160', () => {
    const resolution = computeByLevelAndAspect(level4k, 16 / 9, constraints);
    expect(formatResolution(resolution.width, resolution.height)).toBe('3840x2160');
    expectValid(resolution);
  });

  it('验收基准：1K + 3:1 可行且不超比例上限', () => {
    const resolution = computeByLevelAndAspect(level1k, 3, constraints);
    expectValid(resolution);
    const longEdge = Math.max(resolution.width, resolution.height);
    const shortEdge = Math.min(resolution.width, resolution.height);
    expect(longEdge / shortEdge).toBeLessThanOrEqual(constraints.maxAspectRatio);
  });

  it('竖版比例与横版对称', () => {
    const landscape = computeByLevelAndAspect(level4k, 16 / 9, constraints);
    const portrait = computeByLevelAndAspect(level4k, 9 / 16, constraints);
    expect(formatResolution(portrait.width, portrait.height)).toBe(
      formatResolution(landscape.height, landscape.width),
    );
  });

  it('任意预算与比例组合都产出合法值且总像素不超预算', () => {
    const budgets = [level1k.pixelBudget, level2k.pixelBudget, level4k.pixelBudget];
    const ratios = [1, 4 / 3, 3 / 2, 16 / 9, 2, 3, 1 / 3, 9 / 16, 2 / 3];
    for (const budget of budgets) {
      for (const ratio of ratios) {
        const resolution = computeByPixelBudgetAndAspect(budget, ratio, constraints);
        expectValid(resolution);
        expect(resolution.width * resolution.height).toBeLessThanOrEqual(budget);
      }
    }
  });

  it('预算被夹到 [minPixels, maxPixels]，非法预算回退 maxPixels', () => {
    const tiny = computeByPixelBudgetAndAspect(1, 1, constraints);
    expectValid(tiny);
    expect(tiny.width * tiny.height).toBeGreaterThanOrEqual(constraints.minPixels);

    const fallback = computeByPixelBudgetAndAspect(Number.NaN, 1, constraints);
    expect(formatResolution(fallback.width, fallback.height)).toBe('2880x2880');
  });

  it('比例被夹到 maxAspectRatio', () => {
    const resolution = computeByPixelBudgetAndAspect(level2k.pixelBudget, 100, constraints);
    expectValid(resolution);
    const longEdge = Math.max(resolution.width, resolution.height);
    const shortEdge = Math.min(resolution.width, resolution.height);
    expect(longEdge / shortEdge).toBeLessThanOrEqual(constraints.maxAspectRatio);
  });
});

describe('normalizeConstrainedImageSizeValue 提交兜底', () => {
  it('auto 在 allowAuto 时原样放过', () => {
    expect(normalizeConstrainedImageSizeValue('auto', constraints, true)).toBe('auto');
  });

  it('合法值原样返回', () => {
    expect(normalizeConstrainedImageSizeValue('1360x768', constraints, true)).toBe('1360x768');
  });

  it('非法值投影为最近合法值', () => {
    const normalized = normalizeConstrainedImageSizeValue('9999x17', constraints, true);
    expect(normalized).toBeDefined();
    const match = (normalized ?? '').match(/^(\d+)x(\d+)$/);
    expect(match).not.toBeNull();
    const width = Number.parseInt(match?.[1] ?? '0', 10);
    const height = Number.parseInt(match?.[2] ?? '0', 10);
    expectValid({ width, height });
  });

  it('不可解析值回退到合法投影', () => {
    const normalized = normalizeConstrainedImageSizeValue('not-a-size', constraints, true);
    expect(normalized).toMatch(/^\d+x\d+$/);
  });

  it('空值与不允许的 auto 返回 undefined（调用方保留原值）', () => {
    expect(normalizeConstrainedImageSizeValue(undefined, constraints, true)).toBeUndefined();
    expect(normalizeConstrainedImageSizeValue('', constraints, true)).toBeUndefined();
    expect(normalizeConstrainedImageSizeValue('auto', constraints, false)).toBeUndefined();
  });
});

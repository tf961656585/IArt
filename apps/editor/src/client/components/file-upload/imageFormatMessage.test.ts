import { describe, expect, it } from 'vitest';
import type { ImageValidationConstraints } from '@iart/contracts/media/imageValidationTypes';
import { describeAllowedImageFormats, validateImageBlob } from './imageValidation';
import { getImageConstraintError } from './fileUploadLogic';

const constraintsWith = (allowedMimeTypes: string[]): ImageValidationConstraints => ({
  allowedMimeTypes,
  minWidth: undefined,
  minHeight: undefined,
  maxWidth: undefined,
  maxHeight: undefined,
  disallowPngTransparency: undefined,
});

describe('图片格式提示由 allowedMimeTypes 约束生成', () => {
  it('约束只允许 PNG / JPG 时，提示里不出现其它格式', () => {
    expect(describeAllowedImageFormats(['image/png', 'image/jpeg'])).toBe('PNG 或 JPG');
  });

  it('多格式约束按约束顺序拼接，最后一项用「或」', () => {
    expect(
      describeAllowedImageFormats(['image/jpeg', 'image/png', 'image/bmp', 'image/webp']),
    ).toBe('JPG、PNG、BMP 或 WEBP');
  });

  it('没有约束时退回通用兜底句', () => {
    expect(describeAllowedImageFormats(undefined)).toBe('JPG、PNG、BMP 或 WEBP');
    expect(describeAllowedImageFormats([])).toBe('JPG、PNG、BMP 或 WEBP');
  });

  it('两份同源实现在同一约束下给出同一句提示', async () => {
    const constraints = constraintsWith(['image/png', 'image/jpeg']);
    const file = new File(['x'], 'a.gif', { type: 'image/gif' });
    const expected = '这张图片的格式不支持，请换成 PNG 或 JPG 图片。';

    expect(await validateImageBlob(file, constraints)).toEqual({
      ok: false,
      message: expected,
      dimensions: undefined,
    });
    expect(await getImageConstraintError(file, constraints, undefined)).toBe(expected);
  });

  it('读不出格式时也按约束提示可换的格式', async () => {
    const constraints = constraintsWith(['image/png']);
    const file = new File(['x'], 'a.bin', { type: '' });

    expect(await getImageConstraintError(file, constraints, undefined)).toBe(
      '无法识别图片格式，请重新选择 PNG 图片。',
    );
  });
});

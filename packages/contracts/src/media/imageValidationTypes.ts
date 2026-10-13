export type ImageDimensions = { width: number; height: number };

export type ImageResizeMode = 'fit' | 'none';

export interface ImageValidationConstraints {
  /**
   * 允许的 MIME 类型白名单（例如 image/png）
   * - 若未设置，则不限制
   */
  allowedMimeTypes: string[] | undefined;
  /** 最小宽度（像素） */
  minWidth: number | undefined;
  /** 最小高度（像素） */
  minHeight: number | undefined;
  /** 最大宽度（像素） */
  maxWidth: number | undefined;
  /** 最大高度（像素） */
  maxHeight: number | undefined;
  /**
   * 是否禁止 PNG 透明（alpha / tRNS）
   * - 仅在 mimeType === image/png 时生效
   */
  disallowPngTransparency: boolean | undefined;
}


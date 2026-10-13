export type NaturalImageSize = {
  width: number;
  height: number;
};

export type CssBox = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export type ImageContentFrame = {
  left: number;
  top: number;
  width: number;
  height: number;
  scale: number;
};

export type NormalizedPoint = {
  x: number;
  y: number;
};

export type NormalizedRect = {
  x: number;
  y: number;
  w: number;
  h: number;
};

type NaturalRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

const clamp = (value: number, min: number, max: number): number => {
  return Math.max(min, Math.min(max, value));
};

const clamp01 = (value: number): number => {
  return clamp(value, 0, 1);
};

export const computeContainContentFrame = (
  natural: NaturalImageSize,
  box: CssBox,
): ImageContentFrame => {
  const safeNaturalWidth = Math.max(1, natural.width);
  const safeNaturalHeight = Math.max(1, natural.height);
  const safeBoxWidth = Math.max(1, box.width);
  const safeBoxHeight = Math.max(1, box.height);
  const scale = Math.min(
    safeBoxWidth / safeNaturalWidth,
    safeBoxHeight / safeNaturalHeight,
  );
  const width = safeNaturalWidth * scale;
  const height = safeNaturalHeight * scale;
  return {
    left: box.left + (safeBoxWidth - width) / 2,
    top: box.top + (safeBoxHeight - height) / 2,
    width,
    height,
    scale,
  };
};

export const createImageContentFrameFromBox = (
  box: CssBox,
): ImageContentFrame => {
  return {
    left: box.left,
    top: box.top,
    width: Math.max(1, box.width),
    height: Math.max(1, box.height),
    scale: 1,
  };
};

export const getElementBoxFrame = (
  element: HTMLElement,
): ImageContentFrame | null => {
  const rect = element.getBoundingClientRect();
  if (!rect.width || !rect.height) {
    return null;
  }
  return createImageContentFrameFromBox({
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
  });
};

export const getImageContentFrameFromElement = (
  image: HTMLImageElement,
): ImageContentFrame | null => {
  const naturalWidth = image.naturalWidth;
  const naturalHeight = image.naturalHeight;
  if (!naturalWidth || !naturalHeight) {
    return null;
  }
  const rect = image.getBoundingClientRect();
  if (!rect.width || !rect.height) {
    return null;
  }
  return computeContainContentFrame(
    { width: naturalWidth, height: naturalHeight },
    {
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
    },
  );
};

export const clientPointToImageNorm = (
  client: { x: number; y: number },
  frame: ImageContentFrame,
): NormalizedPoint | null => {
  if (!frame.width || !frame.height) {
    return null;
  }
  const offsetX = client.x - frame.left;
  const offsetY = client.y - frame.top;
  if (
    offsetX < 0 ||
    offsetY < 0 ||
    offsetX > frame.width ||
    offsetY > frame.height
  ) {
    return null;
  }
  return {
    x: clamp01(offsetX / frame.width),
    y: clamp01(offsetY / frame.height),
  };
};

export const imageNormToFramePoint = (
  point: NormalizedPoint,
  frame: ImageContentFrame,
): { x: number; y: number } => {
  return {
    x: frame.left + clamp01(point.x) * frame.width,
    y: frame.top + clamp01(point.y) * frame.height,
  };
};

export const normalizedRectToNaturalRect = (
  rect: NormalizedRect,
  natural: NaturalImageSize,
): NaturalRect => {
  const width = Math.max(1, natural.width);
  const height = Math.max(1, natural.height);
  const left = clamp01(rect.x);
  const top = clamp01(rect.y);
  const right = clamp01(rect.x + rect.w);
  const bottom = clamp01(rect.y + rect.h);
  const x = clamp(Math.round(left * width), 0, width - 1);
  const y = clamp(Math.round(top * height), 0, height - 1);
  const maxRight = Math.max(x + 1, Math.min(width, Math.round(right * width)));
  const maxBottom = Math.max(
    y + 1,
    Math.min(height, Math.round(bottom * height)),
  );
  return {
    x,
    y,
    width: clamp(maxRight - x, 1, width - x),
    height: clamp(maxBottom - y, 1, height - y),
  };
};

export const cssPxToShortSideRatio = (
  px: number,
  frame: ImageContentFrame,
): number => {
  const shortSide = Math.max(1, Math.min(frame.width, frame.height));
  return px / shortSide;
};

export const shortSideRatioToCssPx = (
  ratio: number,
  frame: ImageContentFrame,
): number => {
  const shortSide = Math.max(1, Math.min(frame.width, frame.height));
  return ratio * shortSide;
};

export const shortSideRatioToNaturalPx = (
  ratio: number,
  natural: NaturalImageSize,
): number => {
  const shortSide = Math.max(1, Math.min(natural.width, natural.height));
  return ratio * shortSide;
};

export const fitSizeIntoBox = (
  ratio: number,
  maxW: number,
  maxH: number,
): { width: number; height: number } => {
  const safeRatio = Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
  const frame = computeContainContentFrame(
    { width: safeRatio, height: 1 },
    { left: 0, top: 0, width: Math.max(1, maxW), height: Math.max(1, maxH) },
  );
  return {
    width: Math.max(1, Math.floor(frame.width)),
    height: Math.max(1, Math.floor(frame.height)),
  };
};

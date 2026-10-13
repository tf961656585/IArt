export type ImageSizeSelectorConstrainedPresetOption = {
  label: string;
  value: string;
  description: string | undefined | undefined;
};

export type ImageSizeSelectorConstrainedSizeLevel = {
  id: string;
  label: string;
  /** 级别语义：总像素预算（如 1K = 1024² = 1048576），不再是长边像素 */
  pixelBudget: number;
};

export type ImageSizeSelectorConstrainedAspectPreset = {
  id: string;
  label: string;
  ratio: number;
};

export type ImageSizeSelectorConstrainedConstraints = {
  dimensionMultiple: number;
  maxLongEdge: number;
  minPixels: number;
  maxPixels: number;
  maxAspectRatio: number;
};

export type ImageSizeResolution = {
  width: number;
  height: number;
};

const FALLBACK_CONSTRAINTS: ImageSizeSelectorConstrainedConstraints = {
  dimensionMultiple: 1,
  maxLongEdge: 4096,
  minPixels: 1,
  maxPixels: 4096 * 4096,
  maxAspectRatio: 100,
};

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

const normalizeStep = (dimensionMultiple: number): number =>
  Number.isFinite(dimensionMultiple) && dimensionMultiple > 0 ? Math.max(1, Math.round(dimensionMultiple)) : 1;

const floorToStep = (value: number, step: number): number =>
  Math.max(step, Math.floor(Math.max(step, value) / step) * step);

const roundToStep = (value: number, step: number): number =>
  Math.max(step, Math.round(Math.max(step, value) / step) * step);

export const formatResolution = (width: number, height: number): string => `${width}x${height}`;

export const parseResolution = (raw: string | undefined): ImageSizeResolution | null => {
  if (!raw) return null;
  const match = raw.trim().match(/^(\d+)\s*[xX]\s*(\d+)$/);
  if (!match) return null;
  const width = Number.parseInt(match[1] ?? '', 10);
  const height = Number.parseInt(match[2] ?? '', 10);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    return null;
  }
  return { width, height };
};

export const normalizeConstraints = (
  constraints: ImageSizeSelectorConstrainedConstraints | undefined,
): ImageSizeSelectorConstrainedConstraints => {
  const source = constraints ?? FALLBACK_CONSTRAINTS;
  const dimensionMultiple = normalizeStep(source.dimensionMultiple);
  const maxLongEdge = Number.isFinite(source.maxLongEdge) && source.maxLongEdge > 0
    ? floorToStep(source.maxLongEdge, dimensionMultiple)
    : FALLBACK_CONSTRAINTS.maxLongEdge;
  const minPixels = Number.isFinite(source.minPixels) && source.minPixels > 0
    ? source.minPixels
    : FALLBACK_CONSTRAINTS.minPixels;
  const rawMaxPixels = Number.isFinite(source.maxPixels) && source.maxPixels > 0
    ? source.maxPixels
    : FALLBACK_CONSTRAINTS.maxPixels;
  return {
    dimensionMultiple,
    maxLongEdge,
    minPixels,
    maxPixels: Math.max(rawMaxPixels, minPixels),
    maxAspectRatio: Number.isFinite(source.maxAspectRatio) && source.maxAspectRatio > 0
      ? source.maxAspectRatio
      : FALLBACK_CONSTRAINTS.maxAspectRatio,
  };
};

export const isValidConstrainedResolution = (
  resolution: ImageSizeResolution,
  constraints: ImageSizeSelectorConstrainedConstraints,
  maxLongEdgeLimit = constraints.maxLongEdge,
): boolean => {
  const step = normalizeStep(constraints.dimensionMultiple);
  const { width, height } = resolution;
  const longEdge = Math.max(width, height);
  const shortEdge = Math.min(width, height);
  const pixels = width * height;
  return (
    Number.isInteger(width) &&
    Number.isInteger(height) &&
    width > 0 &&
    height > 0 &&
    width % step === 0 &&
    height % step === 0 &&
    longEdge <= Math.min(maxLongEdgeLimit, constraints.maxLongEdge) &&
    longEdge / shortEdge <= constraints.maxAspectRatio &&
    pixels >= constraints.minPixels &&
    pixels <= constraints.maxPixels
  );
};

export const resolveAspectRatioFromResolution = (width: number, height: number): number => {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return 1;
  }
  return width / height;
};

const normalizeRatio = (ratio: number, constraints: ImageSizeSelectorConstrainedConstraints): number => {
  const fallback = Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
  return clamp(fallback, 1 / constraints.maxAspectRatio, constraints.maxAspectRatio);
};

export const findNearestConstrainedResolution = (
  targetWidth: number,
  targetHeight: number,
  constraints: ImageSizeSelectorConstrainedConstraints,
  maxLongEdgeLimit = constraints.maxLongEdge,
): ImageSizeResolution => {
  const step = normalizeStep(constraints.dimensionMultiple);
  const maxLongEdge = floorToStep(Math.min(maxLongEdgeLimit, constraints.maxLongEdge), step);
  const normalizedTargetWidth = Number.isFinite(targetWidth) && targetWidth > 0 ? targetWidth : maxLongEdge;
  const normalizedTargetHeight = Number.isFinite(targetHeight) && targetHeight > 0 ? targetHeight : maxLongEdge;
  const targetRatio = normalizeRatio(normalizedTargetWidth / normalizedTargetHeight, constraints);
  let best: ImageSizeResolution = { width: maxLongEdge, height: maxLongEdge };
  let bestScore = Number.POSITIVE_INFINITY;

  for (let width = step; width <= maxLongEdge; width += step) {
    for (let height = step; height <= maxLongEdge; height += step) {
      const candidate = { width, height };
      if (!isValidConstrainedResolution(candidate, constraints, maxLongEdge)) continue;
      const ratioScore = Math.abs(Math.log((width / height) / targetRatio)) * 100_000;
      const dimensionScore = Math.abs(width - normalizedTargetWidth) + Math.abs(height - normalizedTargetHeight);
      const pixelScore = Math.abs(width * height - normalizedTargetWidth * normalizedTargetHeight) / 1_000;
      const score = ratioScore + dimensionScore + pixelScore;
      if (score < bestScore) {
        best = candidate;
        bestScore = score;
      }
    }
  }

  return best;
};

/**
 * 按总像素预算与比例求合法分辨率。
 *
 * 取整策略（确定性）：
 * - 比例归一为长/短 r（r ≥ 1，且不超 maxAspectRatio）；预算 P 夹到 [minPixels, maxPixels]。
 * - short = floor(sqrt(P / r) / step) * step —— 先向下取整，保证不主动超出预算。
 * - long = round(short * r / step) * step —— 四舍五入贴近目标比例。
 * - long 超 maxLongEdge 时钉到 maxLongEdge，short 重新向下取整。
 * - 取整后总像素仍超预算时，long 改为向下取整，保证总像素不超预算。
 * - 结果不合法（如预算过小跌破 minPixels）时回退到穷举最近合法值。
 */
export const computeByPixelBudgetAndAspect = (
  pixelBudget: number,
  ratio: number,
  constraints: ImageSizeSelectorConstrainedConstraints,
): ImageSizeResolution => {
  const step = normalizeStep(constraints.dimensionMultiple);
  const maxLongEdge = floorToStep(constraints.maxLongEdge, step);
  const normalizedRatio = normalizeRatio(ratio, constraints);
  const longShortRatio = normalizedRatio >= 1 ? normalizedRatio : 1 / normalizedRatio;
  const rawBudget = Number.isFinite(pixelBudget) && pixelBudget > 0 ? pixelBudget : constraints.maxPixels;
  const targetPixels = clamp(rawBudget, constraints.minPixels, constraints.maxPixels);

  let shortEdge = floorToStep(Math.sqrt(targetPixels / longShortRatio), step);
  let longEdge = roundToStep(shortEdge * longShortRatio, step);
  if (longEdge > maxLongEdge) {
    longEdge = maxLongEdge;
    shortEdge = floorToStep(longEdge / longShortRatio, step);
  }
  if (shortEdge * longEdge > targetPixels) {
    longEdge = floorToStep(shortEdge * longShortRatio, step);
  }

  const candidate: ImageSizeResolution = normalizedRatio >= 1
    ? { width: longEdge, height: shortEdge }
    : { width: shortEdge, height: longEdge };
  if (isValidConstrainedResolution(candidate, constraints)) {
    return candidate;
  }
  return findNearestConstrainedResolution(candidate.width, candidate.height, constraints);
};

export const computeByLevelAndAspect = (
  level: ImageSizeSelectorConstrainedSizeLevel,
  ratio: number,
  constraints: ImageSizeSelectorConstrainedConstraints,
): ImageSizeResolution => computeByPixelBudgetAndAspect(level.pixelBudget, ratio, constraints);

/**
 * 提交链路兜底：把任意来源的尺寸值投影为约束内的合法值。
 * "auto" 在 allowAuto 时原样放过；合法值原样返回；非法/不可解析值返回穷举最近合法值。
 */
export const normalizeConstrainedImageSizeValue = (
  raw: string | undefined,
  constraints: ImageSizeSelectorConstrainedConstraints | undefined,
  allowAuto: boolean,
): string | undefined => {
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  const trimmed = raw.trim();
  if (trimmed === 'auto') {
    return allowAuto ? 'auto' : undefined;
  }
  const resolvedConstraints = normalizeConstraints(constraints);
  const parsed = parseResolution(trimmed);
  if (parsed && isValidConstrainedResolution(parsed, resolvedConstraints)) {
    return formatResolution(parsed.width, parsed.height);
  }
  const target = parsed ?? { width: 2048, height: 2048 };
  const nearest = findNearestConstrainedResolution(target.width, target.height, resolvedConstraints);
  return formatResolution(nearest.width, nearest.height);
};

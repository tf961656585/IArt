import { loadImageSharp } from './image-processing.cts';

type ErrorWithCode = Error & { code: string | undefined };

type DifferenceKeyResult = {
  buffer: Buffer;
  info: { width: number; height: number };
};

/**
 * 将任意通道数的 raw 像素统一成 3 通道 RGB(紧密排列,无 alpha 间隔)。
 * 后续按 i*3 步长读取,因此必须保证输出是纯 3 通道紧密缓冲。
 * - channels=1:灰度复制到 RGB
 * - channels=3:已是 RGB,直接返回
 * - channels=4:RGBA,抽取每像素前 3 字节,丢弃 alpha
 */
const normalizeToRgb = (data: Buffer, pixelCount: number, channels: number): Buffer => {
  if (channels === 3) return data;
  const converted = Buffer.allocUnsafe(pixelCount * 3);
  for (let i = 0; i < pixelCount; i += 1) {
    if (channels === 1) {
      const gray = data[i] || 0;
      converted[i * 3] = gray;
      converted[i * 3 + 1] = gray;
      converted[i * 3 + 2] = gray;
    } else if (channels >= 4) {
      const srcBase = i * channels;
      converted[i * 3] = data[srcBase] || 0;
      converted[i * 3 + 1] = data[srcBase + 1] || 0;
      converted[i * 3 + 2] = data[srcBase + 2] || 0;
    } else {
      // channels=2 等异常情况,按灰度处理第一通道
      const gray = data[i * channels] || 0;
      converted[i * 3] = gray;
      converted[i * 3 + 1] = gray;
      converted[i * 3 + 2] = gray;
    }
  }
  return converted;
};

/**
 * 差异抠图(difference keying)。
 * 输入两张尺寸完全一致、背景不同的图,逐像素比较 RGB 欧氏距离,
 * 差异大(像素变化)→ 背景丢弃(alpha=0),差异小(像素不变)→ 前景保留(alpha=255)。
 * softness 区间内做线性羽化,算法与 applyChromaKey 对称。
 */
export const applyDifferenceKey = async (
  sourceFilePathA: string,
  sourceFilePathB: string,
  params: { threshold: number; softness: number },
): Promise<DifferenceKeyResult> => {
  const sharp = loadImageSharp();
  if (!sharp) {
    const error = new Error('Sharp library not installed') as ErrorWithCode;
    error.code = 'SHARP_NOT_AVAILABLE';
    throw error;
  }

  const loadRawRgb = async (filePath: string) => {
    const { data, info } = await sharp(filePath, undefined)
      .raw()
      .toBuffer({ resolveWithObject: true });
    const width = (info !== null && info !== undefined ? info.width : undefined) || 0;
    const height = (info !== null && info !== undefined ? info.height : undefined) || 0;
    const channels = (info !== null && info !== undefined ? info.channels : undefined) || 0;
    if (!width || !height || channels < 1) {
      const error = new Error('Invalid image data') as ErrorWithCode;
      error.code = 'INVALID_IMAGE';
      throw error;
    }
    const pixelCount = width * height;
    const rgb = normalizeToRgb(data, pixelCount, channels);
    return { rgb, width, height };
  };

  const a = await loadRawRgb(sourceFilePathA);
  const b = await loadRawRgb(sourceFilePathB);

  // 硬约束:两图必须像素级对齐,否则差异抠图无意义。不静默 resize。
  if (a.width !== b.width || a.height !== b.height) {
    const error = new Error(
      `Difference keying requires both images to have identical dimensions (got ${a.width}x${a.height} and ${b.width}x${b.height})`,
    ) as ErrorWithCode;
    error.code = 'DIFFERENCE_KEY_SIZE_MISMATCH';
    throw error;
  }

  const width = a.width;
  const height = a.height;
  const pixelCount = width * height;
  const alpha = new Uint8Array(pixelCount);
  const maxDistance = Math.sqrt(3) * 255;
  const threshold = (params.threshold / 100) * maxDistance;
  const softnessNormalized = params.softness * (maxDistance / 100);

  for (let i = 0; i < pixelCount; i += 1) {
    const base = i * 3;
    const deltaR = (a.rgb[base] || 0) - (b.rgb[base] || 0);
    const deltaG = (a.rgb[base + 1] || 0) - (b.rgb[base + 1] || 0);
    const deltaB = (a.rgb[base + 2] || 0) - (b.rgb[base + 2] || 0);
    const distance = Math.sqrt(deltaR * deltaR + deltaG * deltaG + deltaB * deltaB);

    // 差异抠图语义:差异大 → 背景(alpha=0);差异小 → 前景(alpha=255)。与 chromaKey 相反。
    if (distance >= threshold + softnessNormalized) {
      alpha[i] = 0;
    } else if (softnessNormalized > 0 && distance <= threshold) {
      alpha[i] = 255;
    } else if (softnessNormalized > 0) {
      // 羽化区间:线性映射 255 → 0
      alpha[i] = Math.round(255 * (1 - (distance - threshold) / softnessNormalized));
    } else {
      // softness=0 时,以 threshold 为硬边界:>=threshold 视为背景,否则视为前景
      alpha[i] = distance >= threshold ? 0 : 255;
    }
  }

  // 前景像素取 A 图(背景A)的颜色。用户操作语义是"从 A 图抠出角色"。
  const rgba = Buffer.allocUnsafe(pixelCount * 4);
  for (let i = 0; i < pixelCount; i += 1) {
    const srcBase = i * 3;
    const dstBase = i * 4;
    rgba[dstBase] = a.rgb[srcBase] || 0;
    rgba[dstBase + 1] = a.rgb[srcBase + 1] || 0;
    rgba[dstBase + 2] = a.rgb[srcBase + 2] || 0;
    rgba[dstBase + 3] = alpha[i] || 0;
  }

  const encoded = await sharp(rgba, { raw: { width, height, channels: 4 } })
    .png()
    .toBuffer({ resolveWithObject: true });

  return {
    buffer: encoded.data,
    info: { width, height },
  };
};

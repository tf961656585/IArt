import { loadImageElement } from "./imageConstraints";

const gaussianKernel5x5 = new Float32Array([
  2, 4, 5, 4, 2, 4, 9, 12, 9, 4, 5, 12, 15, 12, 5, 4, 9, 12, 9, 4, 2, 4, 5, 4,
  2,
]);
const gaussianDivisor = 159;

export const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value));

export const applyCannyEdgeDetection = async (
  src: string,
  lowThreshold: number,
  highThreshold: number,
): Promise<string> => {
  const image = await loadImageElement(src);
  const width = Math.max(image.naturalWidth || image.width, 1);
  const height = Math.max(image.naturalHeight || image.height, 1);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("CANVAS_CONTEXT_UNAVAILABLE");

  ctx.drawImage(image, 0, 0, width, height);
  const imageData = ctx.getImageData(0, 0, width, height);
  const { data } = imageData;
  const grayscale = new Float32Array(width * height);
  for (let i = 0; i < width * height; i += 1) {
    const idx = i * 4;
    grayscale[i] =
      0.2126 * (data[idx] ?? 0) +
      0.7152 * (data[idx + 1] ?? 0) +
      0.0722 * (data[idx + 2] ?? 0);
  }

  const blurred = new Float32Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let sum = 0;
      for (let ky = -2; ky <= 2; ky += 1) {
        for (let kx = -2; kx <= 2; kx += 1) {
          const sampleX = clamp(x + kx, 0, width - 1);
          const sampleY = clamp(y + ky, 0, height - 1);
          const weight = gaussianKernel5x5[(ky + 2) * 5 + (kx + 2)] ?? 0;
          sum += (grayscale[sampleY * width + sampleX] ?? 0) * weight;
        }
      }
      blurred[y * width + x] = sum / gaussianDivisor;
    }
  }

  const sobelX = [-1, 0, 1, -2, 0, 2, -1, 0, 1];
  const sobelY = [-1, -2, -1, 0, 0, 0, 1, 2, 1];
  const gradient = new Float32Array(width * height);
  const direction = new Float32Array(width * height);
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      let gx = 0;
      let gy = 0;
      for (let ky = -1; ky <= 1; ky += 1) {
        for (let kx = -1; kx <= 1; kx += 1) {
          const sample = blurred[(y + ky) * width + (x + kx)] ?? 0;
          const kernelIdx = (ky + 1) * 3 + (kx + 1);
          gx += sample * (sobelX[kernelIdx] ?? 0);
          gy += sample * (sobelY[kernelIdx] ?? 0);
        }
      }
      const idx = y * width + x;
      gradient[idx] = Math.hypot(gx, gy);
      let angle = (Math.atan2(gy, gx) * 180) / Math.PI;
      if (angle < 0) angle += 180;
      direction[idx] = angle;
    }
  }

  const suppressed = new Float32Array(width * height);
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const idx = y * width + x;
      const angle = direction[idx] ?? 0;
      const magnitude = gradient[idx] ?? 0;
      let neighbor1 = 0;
      let neighbor2 = 0;
      if ((angle >= 0 && angle < 22.5) || angle >= 157.5) {
        neighbor1 = gradient[idx + 1] ?? 0;
        neighbor2 = gradient[idx - 1] ?? 0;
      } else if (angle >= 22.5 && angle < 67.5) {
        neighbor1 = gradient[idx + width + 1] ?? 0;
        neighbor2 = gradient[idx - width - 1] ?? 0;
      } else if (angle >= 67.5 && angle < 112.5) {
        neighbor1 = gradient[idx + width] ?? 0;
        neighbor2 = gradient[idx - width] ?? 0;
      } else {
        neighbor1 = gradient[idx + width - 1] ?? 0;
        neighbor2 = gradient[idx - width + 1] ?? 0;
      }
      suppressed[idx] =
        magnitude >= neighbor1 && magnitude >= neighbor2 ? magnitude : 0;
    }
  }

  const strong = 255;
  const weak = 75;
  const result = new Uint8ClampedArray(width * height);
  for (let i = 0; i < width * height; i += 1) {
    const value = suppressed[i] ?? 0;
    result[i] =
      value >= highThreshold ? strong : value >= lowThreshold ? weak : 0;
  }
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const idx = y * width + x;
      if (result[idx] !== weak) continue;
      let hasStrongNeighbor = false;
      for (let ky = -1; ky <= 1 && !hasStrongNeighbor; ky += 1) {
        for (let kx = -1; kx <= 1; kx += 1) {
          if (result[(y + ky) * width + (x + kx)] === strong) {
            hasStrongNeighbor = true;
            break;
          }
        }
      }
      result[idx] = hasStrongNeighbor ? strong : 0;
    }
  }

  const output = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    const value = result[i] ?? 0;
    const idx = i * 4;
    output[idx] = value;
    output[idx + 1] = value;
    output[idx + 2] = value;
    output[idx + 3] = 255;
  }
  ctx.putImageData(new ImageData(output, width, height), 0, 0);
  return canvas.toDataURL("image/png");
};

const buildProcessedFileName = (
  originalName: string | undefined,
  mimeType: string,
): string => {
  const extension =
    mimeType === "image/png"
      ? ".png"
      : mimeType === "image/jpeg"
        ? ".jpg"
        : ".png";
  if (!originalName) return `processed-${Date.now()}${extension}`;
  const dotIndex = originalName.lastIndexOf(".");
  const base = dotIndex > 0 ? originalName.slice(0, dotIndex) : originalName;
  return `${base}-canny${extension}`;
};

export const dataUrlToFile = async (
  dataUrl: string,
  originalName: string | undefined,
): Promise<File> => {
  const response = await fetch(dataUrl);
  const blob = await response.blob();
  const name = buildProcessedFileName(originalName, blob.type || "image/png");
  return new File([blob], name, { type: blob.type || "image/png" });
};

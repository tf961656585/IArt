export const canvasToBlob = (
  canvas: HTMLCanvasElement,
  type = 'image/png',
  quality: number | undefined,
): Promise<Blob> => {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error('导出失败：无法生成图片 Blob'));
          return;
        }
        resolve(blob);
      },
      type,
      quality,
    );
  });
};

export const loadImageElement = async (src: string): Promise<HTMLImageElement> => {
  const url = typeof src === 'string' ? src.trim() : '';
  if (!url) throw new Error('图片地址无效');
  const img = new Image();
  img.decoding = 'async';
  img.loading = 'eager';
  img.src = url;
  if (typeof img.decode === 'function') {
    await img.decode();
  } else {
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('图片加载失败'));
    });
  }
  return img;
};

export const drawImageContain = (
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  target: { width: number; height: number },
): void => {
  const dstW = Math.max(1, Math.floor(target.width));
  const dstH = Math.max(1, Math.floor(target.height));
  const srcW = img.naturalWidth || 0;
  const srcH = img.naturalHeight || 0;
  if (!srcW || !srcH) return;

  const scale = Math.min(dstW / srcW, dstH / srcH);
  const drawW = srcW * scale;
  const drawH = srcH * scale;
  const dx = (dstW - drawW) / 2;
  const dy = (dstH - drawH) / 2;
  ctx.drawImage(img, dx, dy, drawW, drawH);
};


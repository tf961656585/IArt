
export type BoundingBox = { x: number; y: number; width: number; height: number };

export const binarizeAlpha = (rawBuffer: Buffer, width: number, height: number, threshold: number): Uint8Array => {
  const pixelCount = width * height;
  const binary = new Uint8Array(pixelCount);
  for (let i = 0; i < pixelCount; i += 1) {
    const alpha = rawBuffer[i * 4 + 3] || 0;
    binary[i] = alpha > threshold ? 255 : 0;
  }
  return binary;
};

export const dilateBinary = (binary: Uint8Array, width: number, height: number, iterations: number): Uint8Array => {
  let current = new Uint8Array(binary);
  for (let iter = 0; iter < iterations; iter += 1) {
    const next = new Uint8Array(current);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        if (current[y * width + x] === 255) continue;
        let found = false;
        for (let ky = -1; ky <= 1 && !found; ky += 1) {
          for (let kx = -1; kx <= 1 && !found; kx += 1) {
            const ny = y + ky;
            const nx = x + kx;
            if (ny >= 0 && ny < height && nx >= 0 && nx < width) {
              if (current[ny * width + nx] === 255) found = true;
            }
          }
        }
        if (found) next[y * width + x] = 255;
      }
    }
    current = next;
  }
  return current;
};

export const detectConnectedComponents = (
  binary: Uint8Array,
  width: number,
  height: number,
  minArea: number,
): BoundingBox[] => {
  const visited = new Uint8Array(width * height);
  const boxes: BoundingBox[] = [];
  const allBoxes: BoundingBox[] = [];
  const queue: number[] = [];

  for (let startY = 0; startY < height; startY += 1) {
    for (let startX = 0; startX < width; startX += 1) {
      const startIdx = startY * width + startX;
      if (binary[startIdx] !== 255 || visited[startIdx]) continue;

      queue.length = 0;
      queue.push(startIdx);
      visited[startIdx] = 1;
      let minX = startX;
      let maxX = startX;
      let minY = startY;
      let maxY = startY;
      let area = 0;

      while (queue.length > 0) {
        const idx = queue.pop();
        if (idx === undefined) break;
        const cy = (idx / width) | 0;
        const cx = idx % width;
        area += 1;
        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;

        const neighbors = [
          cy > 0 ? idx - width : -1,
          cy < height - 1 ? idx + width : -1,
          cx > 0 ? idx - 1 : -1,
          cx < width - 1 ? idx + 1 : -1,
        ];
        for (const nIdx of neighbors) {
          if (nIdx >= 0 && binary[nIdx] === 255 && !visited[nIdx]) {
            visited[nIdx] = 1;
            queue.push(nIdx);
          }
        }
      }

      const bbox: BoundingBox = { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
      if (area >= minArea) {
        boxes.push(bbox);
      }
      allBoxes.push(bbox);
    }
  }

  return boxes.sort((a, b) => (b.width * b.height) - (a.width * a.height));
};

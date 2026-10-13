import { describe, expect, it } from 'vitest';
import { normalizeUploadItems } from '../mediaHelpers';

/** jsdom 下 File/Blob 可直接构造。 */
const createFile = (name = 'a.png'): File => new File(['x'], name, { type: 'image/png' });

describe('mediaHelpers.normalizeUploadItems', () => {
  it('UploadFileItem 携带 File 时保留 file 与 id，src 为 undefined', () => {
    const file = createFile();
    const items = normalizeUploadItems([{ id: 'f1', file, src: undefined }], undefined);
    expect(items).toHaveLength(1);
    expect(items[0]).toEqual({ id: 'f1', file, src: undefined });
  });

  it('UploadFileItem 仅携带 src 字符串时归一为 src（去首尾空白），file 为 undefined', () => {
    const items = normalizeUploadItems([{ id: 'f2', file: null, src: '  /files/a.png  ' }], undefined);
    expect(items).toHaveLength(1);
    expect(items[0]).toEqual({ id: 'f2', file: undefined, src: '/files/a.png' });
  });

  it('file 与 src 均为空的 UploadFileItem 被丢弃', () => {
    const items = normalizeUploadItems([{ id: 'f3', file: null, src: '' }], undefined);
    expect(items).toEqual([]);
  });

  it('裸 URL 字符串归一为 src 项，裸 Blob 归一为 file 项', () => {
    const blob = new Blob(['x'], { type: 'image/png' });
    const items = normalizeUploadItems(['/files/a.png', blob], undefined);
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({ id: undefined, file: undefined, src: '/files/a.png' });
    expect(items[1]).toEqual({ id: undefined, file: blob, src: undefined });
  });

  it('嵌套数组递归展开为平面列表', () => {
    const file = createFile();
    const items = normalizeUploadItems(
      [['/files/a.png'], [{ id: 'f4', file, src: undefined }], []],
      undefined,
    );
    expect(items).toHaveLength(2);
    expect(items[0]?.src).toBe('/files/a.png');
    expect(items[1]).toEqual({ id: 'f4', file, src: undefined });
  });

  it('maxFiles 截断产出数量', () => {
    const items = normalizeUploadItems(
      ['/files/a.png', '/files/b.png', '/files/c.png'],
      2,
    );
    expect(items.map((item) => item.src)).toEqual(['/files/a.png', '/files/b.png']);
  });

  it('无效标量（数字/null/undefined）被忽略，不产生条目', () => {
    const items = normalizeUploadItems([42, null, undefined, '/files/a.png'], undefined);
    expect(items).toHaveLength(1);
    expect(items[0]?.src).toBe('/files/a.png');
  });
});

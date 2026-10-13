import { describe, expect, it } from 'vitest';
import { getImageOperation } from '../registry';

describe('IMAGE_OPERATION_REGISTRY', () => {
  it('mirrorX 应当生成 transform ops 与 derivedOp', () => {
    const op = getImageOperation('mirrorX');
    expect(op.ops).toEqual([{ type: 'mirrorX' }]);
    expect(op.derivedOp).toEqual({ type: 'mirrorX' });
  });

  it('mirrorY 应当生成 transform ops 与 derivedOp', () => {
    const op = getImageOperation('mirrorY');
    expect(op.ops).toEqual([{ type: 'mirrorY' }]);
    expect(op.derivedOp).toEqual({ type: 'mirrorY' });
  });

  it('rotate90 应当生成 transform ops 与 derivedOp', () => {
    const op = getImageOperation('rotate90');
    expect(op.ops).toEqual([{ type: 'rotate', deg: 90 }]);
    expect(op.derivedOp).toEqual({ type: 'rotate', deg: 90 });
  });
});

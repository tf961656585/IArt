import { describe, expect, it, vi } from 'vitest';
import {
  claimInlinePlayback,
  releaseInlinePlayback,
  type InlinePlaybackHandle,
} from '../shared/inlinePlaybackCoordinator';

const createHandle = (): InlinePlaybackHandle => ({ pause: vi.fn() });

describe('inlinePlaybackCoordinator · 同屏唯一播放', () => {
  it('开始播放新的时暂停上一个', () => {
    const a = createHandle();
    const b = createHandle();
    claimInlinePlayback(a);
    claimInlinePlayback(b);
    expect(a.pause).toHaveBeenCalledTimes(1);
    expect(b.pause).not.toHaveBeenCalled();
    releaseInlinePlayback(b);
  });

  it('同一 handle 重复 claim 不暂停自己', () => {
    const a = createHandle();
    claimInlinePlayback(a);
    claimInlinePlayback(a);
    expect(a.pause).not.toHaveBeenCalled();
    releaseInlinePlayback(a);
  });

  it('release 之后不再被新的 claim 暂停', () => {
    const a = createHandle();
    const b = createHandle();
    claimInlinePlayback(a);
    releaseInlinePlayback(a);
    claimInlinePlayback(b);
    expect(a.pause).not.toHaveBeenCalled();
    releaseInlinePlayback(b);
  });
});

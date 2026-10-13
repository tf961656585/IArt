import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { requestMock } = vi.hoisted(() => ({
  requestMock: vi.fn(),
}));

vi.mock('../client', () => ({
  request: requestMock,
}));

import { fetchModelAssetNodeProjections } from '../modelAssetProjections';

describe('fetchModelAssetNodeProjections', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    requestMock.mockReset();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('success!=true 时返回 null 并输出告警', async () => {
    requestMock.mockResolvedValue({
      success: false,
      loaded_at: '2026-04-30T00:00:00.000Z',
      package_root: '/tmp/model-assets',
      projections: [],
      localization_bundles: [],
      diagnostics: [],
    });

    const result = await fetchModelAssetNodeProjections();

    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      '[model-asset] fetch node projections response not successful',
      expect.objectContaining({ success: false }),
    );
  });

  it('request 抛异常时返回 null 并输出告警', async () => {
    const error = new Error('network failed');
    requestMock.mockRejectedValue(error);

    const result = await fetchModelAssetNodeProjections();

    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith('[model-asset] fetch node projections failed', error);
  });
});

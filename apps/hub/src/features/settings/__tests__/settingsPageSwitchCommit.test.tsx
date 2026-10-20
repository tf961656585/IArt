import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { HubConfigResponseSchema, type HubConfigResponse, type HubConfigUpdatePayload } from '@iart/contracts';
import { PublicRelaySection } from '../PublicRelaySection';

/**
 * 分区成页后「切换导航 = 卸载页面」的输入保全契约（2026-10-19）。
 *
 * 背景：设置页的表单子单元是「编辑即自动保存」——变更后 300ms 提交，成功静默。
 * 设置页改为「一个导航项 = 一个页面」之后，切页会卸载整个子单元。若卸载时清掉
 * 挂起的定时器而不提交，用户在 300ms 内改完就切走，这次改动会静默丢失：
 * 界面已经显示新值，后端仍是旧值，且没有任何提示。这类缺陷在单页长滚动形态下
 * 不存在（切页不卸载），是分区成页引入的新风险，必须有机械保护。
 *
 * 钉住的行为：卸载时若有挂起提交，立即冲出（用最后一次输入值），不丢弃。
 * 反例（同时钉住的反向契约）：没有挂起变更时卸载，不得产生任何保存请求。
 */

const settingsRef = vi.hoisted(() => ({
  current: {
    loadSettings: vi.fn<(signal: undefined) => Promise<HubConfigResponse>>(),
    saveSettings: vi.fn<(payload: Partial<HubConfigUpdatePayload>) => Promise<HubConfigResponse>>(),
  },
}));

vi.mock('../../../components/providers/HubAppProvider', () => ({
  useHubRuntime: () => ({ settingsFeature: settingsRef.current }),
}));

const configResponse = (relay?: { cloudflare: string; selfHosted: string }): HubConfigResponse =>
  HubConfigResponseSchema.parse({
    config: {
      publicRelayTargets: {
        cloudflare_image_public_url: { endpoint: relay?.cloudflare ?? '' },
        self_hosted_image_public_url: { endpoint: relay?.selfHosted ?? '' },
      },
    },
    resolved: {
      preferredPort: 0,
      logLevel: 'info',
      maxUploadSize: 10737418240,
      maxMediaSize: 104857600,
      maxBatchTasks: 30,
      expandInlineParamsOnStartup: false,
      agentDefaultModelId: null,
      generationDefaultModelId: null,
      allowedRemoteHosts: [],
      proxyMode: 'system',
      proxyUrl: null,
    },
    server: { port: null, baseUrl: null },
  });

const inputByLabel = (label: string): HTMLInputElement => screen.getByLabelText(label) as HTMLInputElement;

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  vi.clearAllMocks();
});

describe('切换分区时的挂起输入（useDebouncedCommit）', () => {
  it('300ms 内改完就切页：卸载时冲出挂起提交，带最后一次输入值', async () => {
    settingsRef.current.loadSettings.mockResolvedValue(configResponse());
    settingsRef.current.saveSettings.mockResolvedValue(
      configResponse({ cloudflare: 'https://relay.example.com/upload', selfHosted: '' }),
    );
    const { unmount } = render(<PublicRelaySection />);
    await waitFor(() => {
      expect(inputByLabel('通用文件中转地址').value).toBe('');
    });

    // 输入后**不推进定时器**就卸载（模拟用户改完立刻点另一个分区）
    fireEvent.change(inputByLabel('通用文件中转地址'), { target: { value: 'https://relay.example.com/upload' } });
    expect(settingsRef.current.saveSettings).not.toHaveBeenCalled();

    unmount();

    // 卸载即提交：不依赖 300ms 定时器，且用的是最后输入值
    expect(settingsRef.current.saveSettings).toHaveBeenCalledTimes(1);
    const payload = settingsRef.current.saveSettings.mock.calls[0]?.[0];
    expect(payload?.publicRelayTargets).toEqual({
      cloudflare_image_public_url: { endpoint: 'https://relay.example.com/upload' },
      self_hosted_image_public_url: { endpoint: '' },
    });
  });

  it('没有挂起变更时卸载不产生保存请求', async () => {
    settingsRef.current.loadSettings.mockResolvedValue(configResponse({ cloudflare: 'https://relay.example.com/upload', selfHosted: '' }));
    const { unmount } = render(<PublicRelaySection />);
    await waitFor(() => {
      expect(inputByLabel('通用文件中转地址').value).toBe('https://relay.example.com/upload');
    });

    unmount();

    expect(settingsRef.current.saveSettings).not.toHaveBeenCalled();
  });

  it('定时器已正常提交后再卸载，不重复提交', async () => {
    settingsRef.current.loadSettings.mockResolvedValue(configResponse());
    settingsRef.current.saveSettings.mockResolvedValue(
      configResponse({ cloudflare: 'https://relay.example.com/upload', selfHosted: '' }),
    );
    const { unmount } = render(<PublicRelaySection />);
    await waitFor(() => {
      expect(inputByLabel('通用文件中转地址').value).toBe('');
    });

    fireEvent.change(inputByLabel('通用文件中转地址'), { target: { value: 'https://relay.example.com/upload' } });
    await vi.advanceTimersByTimeAsync(300);
    expect(settingsRef.current.saveSettings).toHaveBeenCalledTimes(1);

    unmount();
    expect(settingsRef.current.saveSettings).toHaveBeenCalledTimes(1);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { HubConfigResponseSchema, type HubConfigResponse, type HubConfigUpdatePayload } from '@iart/contracts';
import { PublicRelaySection } from '../PublicRelaySection';

/**
 * 设置页「公共中转」子单元（spec docs/runtime/public-relay-capability.md）：
 * 两个用户自带的公共中转端点。本测试钉住三条行为契约：
 * 1. 加载时从 config 镜像回填两个端点（空串 = 未配置，输入框留空）；
 * 2. 非法地址（非 http/https）不发起保存，仅状态行留痕（客户端预校验，避免 400）；
 * 3. 保存体整体携带两个中转类型（backend 对 publicRelayTargets 整体替换），
 *    未编辑的一侧按加载值原样携带；空串 = 清除该类型配置。
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

const inputByLabel = (label: string): HTMLInputElement => {
  const input = screen.getByLabelText(label) as HTMLInputElement;
  return input;
};

beforeEach(() => {
  // shouldAdvanceTime：定时器随真实时间自动推进，waitFor 可用；300ms debounce 仍可确定性推进。
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  vi.clearAllMocks();
});

describe('PublicRelaySection', () => {
  it('加载时从 config 镜像回填两个端点；未配置留空', async () => {
    settingsRef.current.loadSettings.mockResolvedValue(
      configResponse({ cloudflare: 'https://relay.example.com/upload', selfHosted: '' }),
    );
    render(<PublicRelaySection />);

    await waitFor(() => {
      expect(inputByLabel('通用文件中转地址').value).toBe('https://relay.example.com/upload');
    });
    expect(inputByLabel('图像中转地址').value).toBe('');
    expect(settingsRef.current.saveSettings).not.toHaveBeenCalled();
  });

  it('非法地址不发起保存，状态行留痕', async () => {
    settingsRef.current.loadSettings.mockResolvedValue(configResponse());
    render(<PublicRelaySection />);
    await waitFor(() => {
      expect(inputByLabel('通用文件中转地址').value).toBe('');
    });

    fireEvent.change(inputByLabel('通用文件中转地址'), { target: { value: 'ftp://relay.example.com' } });
    await vi.advanceTimersByTimeAsync(300);

    await waitFor(() => {
      expect(settingsRef.current.saveSettings).not.toHaveBeenCalled();
      expect(screen.getByText('地址格式不对，需要以 http:// 或 https:// 开头')).toBeTruthy();
    });
  });

  it('保存体整体携带两个中转类型：编辑侧带新值、另一侧按加载值携带', async () => {
    settingsRef.current.loadSettings.mockResolvedValue(
      configResponse({ cloudflare: 'https://relay.example.com/upload', selfHosted: 'https://images.example.com/api/upload' }),
    );
    settingsRef.current.saveSettings.mockResolvedValue(
      configResponse({ cloudflare: 'https://new-relay.example.com/upload', selfHosted: 'https://images.example.com/api/upload' }),
    );
    render(<PublicRelaySection />);
    await waitFor(() => {
      expect(inputByLabel('通用文件中转地址').value).toBe('https://relay.example.com/upload');
    });

    fireEvent.change(inputByLabel('通用文件中转地址'), { target: { value: 'https://new-relay.example.com/upload' } });
    await vi.advanceTimersByTimeAsync(300);

    expect(settingsRef.current.saveSettings).toHaveBeenCalledTimes(1);
    const payload = settingsRef.current.saveSettings.mock.calls[0]?.[0];
    expect(payload).toEqual({
      maxBatchTasks: undefined,
      expandInlineParamsOnStartup: undefined,
      agentDefaultModelId: undefined,
      generationDefaultModelId: undefined,
      proxyMode: undefined,
      proxyUrl: undefined,
      publicRelayTargets: {
        cloudflare_image_public_url: { endpoint: 'https://new-relay.example.com/upload' },
        self_hosted_image_public_url: { endpoint: 'https://images.example.com/api/upload' },
      },
    });
    // 保存成功后以返回的 config 回填
    await waitFor(() => {
      expect(inputByLabel('通用文件中转地址').value).toBe('https://new-relay.example.com/upload');
    });
  });

  it('清空一侧地址 = 清除该类型配置（空串随保存体携带）', async () => {
    settingsRef.current.loadSettings.mockResolvedValue(
      configResponse({ cloudflare: 'https://relay.example.com/upload', selfHosted: 'https://images.example.com/api/upload' }),
    );
    settingsRef.current.saveSettings.mockResolvedValue(configResponse());
    render(<PublicRelaySection />);
    await waitFor(() => {
      expect(inputByLabel('图像中转地址').value).toBe('https://images.example.com/api/upload');
    });

    fireEvent.change(inputByLabel('图像中转地址'), { target: { value: '' } });
    await vi.advanceTimersByTimeAsync(300);

    const payload = settingsRef.current.saveSettings.mock.calls[0]?.[0];
    expect(payload?.['publicRelayTargets']).toEqual({
      cloudflare_image_public_url: { endpoint: 'https://relay.example.com/upload' },
      self_hosted_image_public_url: { endpoint: '' },
    });
  });
});

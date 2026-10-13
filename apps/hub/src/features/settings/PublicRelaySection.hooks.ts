import { useCallback, useEffect, useRef, useState } from 'react';
import type { HubConfigResponse, PublicRelayTargetSettings } from '@iart/contracts';
import { useHubRuntime } from '../../components/providers/HubAppProvider';
import { validateHttpUrlInput } from './url-validation';

/**
 * 「公共中转」子域 React 版操作 hook（通用设置分区）。
 * - 进入设置 tab 时 loadSettings 读取配置；
 * - 任一地址变更走 debounce 300ms 自动保存；保存体整体携带两个中转类型
 *   （backend 对该键整体替换，spec docs/runtime/public-relay-capability.md）；
 * - 地址为空 = 清除该类型配置（合法）；非空必须合法 http/https：非法时不发起保存
 *   （避免 400），仅本地暂存并提示；
 * - 保存成功后以返回的 config 回填（等价其他子单元的 applySettings）。
 * statusMessage 仅承载错误/校验留痕（读取失败、保存失败、地址非法），成功路径静默。
 */

type RelayTargetKey = keyof PublicRelayTargetSettings;

const readEndpoint = (
  targets: PublicRelayTargetSettings | undefined,
  targetType: RelayTargetKey,
): string => {
  const entry = targets?.[targetType];
  return typeof entry?.endpoint === 'string' ? entry.endpoint : '';
};

export function usePublicRelay() {
  const { settingsFeature } = useHubRuntime();

  const [cloudflareEndpoint, setCloudflareEndpoint] = useState('');
  const [selfHostedEndpoint, setSelfHostedEndpoint] = useState('');
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const applySettings = useCallback((payload: HubConfigResponse | null | undefined): void => {
    if (!payload) return;
    const targets = payload.config.publicRelayTargets;
    setCloudflareEndpoint(readEndpoint(targets, 'cloudflare_image_public_url'));
    setSelfHostedEndpoint(readEndpoint(targets, 'self_hosted_image_public_url'));
  }, []);

  const loadSettings = useCallback(
    async (_force: boolean | undefined): Promise<void> => {
      try {
        const payload: HubConfigResponse = await settingsFeature.loadSettings(undefined);
        applySettings(payload);
      } catch {
        setStatusMessage('没能读取设置，请重试');
      }
    },
    [applySettings, settingsFeature],
  );

  const persist = useCallback(
    async (cloudflare: string, selfHosted: string): Promise<void> => {
      const hasInvalidEndpoint =
        (cloudflare.trim() !== '' && validateHttpUrlInput(cloudflare) === null) ||
        (selfHosted.trim() !== '' && validateHttpUrlInput(selfHosted) === null);
      if (hasInvalidEndpoint) {
        setStatusMessage('地址格式不对，需要以 http:// 或 https:// 开头');
        return;
      }
      try {
        const payload: HubConfigResponse = await settingsFeature.saveSettings({
          publicRelayTargets: {
            cloudflare_image_public_url: { endpoint: cloudflare },
            self_hosted_image_public_url: { endpoint: selfHosted },
          },
        });
        applySettings(payload);
      } catch {
        setStatusMessage('没能保存，请重试');
      }
    },
    [applySettings, settingsFeature],
  );

  const debouncedPersist = useCallback(
    (cloudflare: string, selfHosted: string): void => {
      if (saveTimerRef.current !== null) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => {
        void persist(cloudflare, selfHosted);
      }, 300);
    },
    [persist],
  );

  const changeCloudflareEndpoint = useCallback(
    (value: string): void => {
      setCloudflareEndpoint(value);
      debouncedPersist(value, selfHostedEndpoint);
    },
    [debouncedPersist, selfHostedEndpoint],
  );

  const changeSelfHostedEndpoint = useCallback(
    (value: string): void => {
      setSelfHostedEndpoint(value);
      debouncedPersist(cloudflareEndpoint, value);
    },
    [cloudflareEndpoint, debouncedPersist],
  );

  useEffect(() => {
    return () => {
      if (saveTimerRef.current !== null) clearTimeout(saveTimerRef.current);
    };
  }, []);

  return {
    cloudflareEndpoint,
    selfHostedEndpoint,
    statusMessage,
    loadSettings,
    changeCloudflareEndpoint,
    changeSelfHostedEndpoint,
  };
}

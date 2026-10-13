import { useCallback, useEffect, useRef, useState } from 'react';
import type { HubConfigResponse, ProxyMode } from '@iart/contracts';
import { useHubRuntime } from '../../components/providers/HubAppProvider';
import { validateHttpUrlInput } from './url-validation';

/**
 * 「网络代理」子域 React 版操作 hook（通用设置分区）。
 * - 进入设置 tab 时 loadSettings 读取配置；
 * - 模式/地址变更走 debounce 300ms 自动保存（与 RunPolicy 同一模式）；
 * - manual 模式要求合法 http/https 代理地址：地址为空或非法时不发起保存（避免 400），
 *   仅本地暂存并提示；切换到 system/direct 时始终保存（backend 归一化会清空 proxyUrl）；
 * - 保存成功后以返回的 config 回填（等价其他子单元的 applySettings）。
 * statusMessage 仅承载错误/校验留痕（读取失败、保存失败、地址非法），成功路径静默。
 */

const PROXY_MODES: readonly ProxyMode[] = ['system', 'direct', 'manual'];

const isProxyMode = (value: unknown): value is ProxyMode =>
  typeof value === 'string' && (PROXY_MODES as readonly string[]).includes(value);

export function useNetworkProxy() {
  const { settingsFeature } = useHubRuntime();

  const [proxyMode, setProxyMode] = useState<ProxyMode>('system');
  const [proxyUrl, setProxyUrl] = useState('');
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const applySettings = useCallback((payload: HubConfigResponse | null | undefined): void => {
    if (!payload) return;
    const config = payload.config;
    if (isProxyMode(config.proxyMode)) {
      setProxyMode(config.proxyMode);
    } else if (isProxyMode(payload.resolved.proxyMode)) {
      setProxyMode(payload.resolved.proxyMode);
    }
    setProxyUrl(typeof config.proxyUrl === 'string' ? config.proxyUrl : '');
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

  /**
   * 保存：返回 true 表示已发起请求（结果经 applySettings/错误回填状态）。
   * manual + 空/非法地址：不发请求，本地提示（避免后端 400 与半生效状态）。
   */
  const persist = useCallback(
    async (mode: ProxyMode, url: string): Promise<boolean> => {
      if (mode === 'manual') {
        const normalizedUrl = validateHttpUrlInput(url);
        if (normalizedUrl === null) {
          setStatusMessage(url.trim() ? '代理地址格式不对，需要以 http:// 或 https:// 开头' : '填写代理地址后才会生效');
          return false;
        }
        try {
          const payload: HubConfigResponse = await settingsFeature.saveSettings({
            proxyMode: 'manual',
            proxyUrl: normalizedUrl,
          });
          applySettings(payload);
        } catch {
          setStatusMessage('没能保存，请重试');
        }
        return true;
      }
      try {
        const payload: HubConfigResponse = await settingsFeature.saveSettings({
          proxyMode: mode,
          proxyUrl: '',
        });
        applySettings(payload);
      } catch {
        setStatusMessage('没能保存，请重试');
      }
      return true;
    },
    [applySettings, settingsFeature],
  );

  const debouncedPersist = useCallback(
    (mode: ProxyMode, url: string): void => {
      if (saveTimerRef.current !== null) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => {
        void persist(mode, url);
      }, 300);
    },
    [persist],
  );

  const changeProxyMode = useCallback(
    (mode: ProxyMode): void => {
      setProxyMode(mode);
      debouncedPersist(mode, proxyUrl);
    },
    [debouncedPersist, proxyUrl],
  );

  const changeProxyUrl = useCallback(
    (value: string): void => {
      setProxyUrl(value);
      debouncedPersist(proxyMode, value);
    },
    [debouncedPersist, proxyMode],
  );

  useEffect(() => {
    return () => {
      if (saveTimerRef.current !== null) clearTimeout(saveTimerRef.current);
    };
  }, []);

  return {
    proxyMode,
    proxyUrl,
    statusMessage,
    loadSettings,
    changeProxyMode,
    changeProxyUrl,
  };
}

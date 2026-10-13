import type { HubConfigUpdatePayload } from '@iart/contracts';
import { buildConfigUpdatePayload } from '../../client/settings/config-update';
import type { HubApiClient } from '../../client/types';

/**
 * settings 域 React 版 API feature。逻辑与 vanilla 侧 controllers/settings-controller.ts 等价：
 * - loadSettings：读取完整配置（等价 vanilla settingsController.loadSettings）；
 * - saveSettings：部分字段更新，未提供的字段以 undefined 补全（backend 保留原值）。
 */

export interface SettingsSavePayload {
  maxBatchTasks: number | undefined;
  expandInlineParamsOnStartup: boolean | undefined;
}

export const createSettingsFeature = (api: HubApiClient) => ({
  loadSettings(signal: AbortSignal | undefined) {
    return api.loadConfig(signal);
  },
  saveSettings(payload: Partial<HubConfigUpdatePayload>) {
    // 补全成完整更新体（未提供的字段为 undefined，backend 保留原值），补全规则见 config-update
    return api.saveConfig(buildConfigUpdatePayload(payload));
  },
});

export { SettingsTab } from './SettingsTab';
export { PENDING_SETTINGS_SECTION_KEY } from './SettingsTab';
export { SettingsSection } from './components/SettingsSection';
export { SettingsNav, SETTINGS_NAV_GROUPS, SETTINGS_SECTION_IDS } from './components/SettingsNav';
export { RunPolicySection } from './RunPolicySection';
export { useRunPolicy } from './RunPolicySection.hooks';
export { NetworkProxySection } from './NetworkProxySection';
export { useNetworkProxy } from './NetworkProxySection.hooks';
export { PublicRelaySection } from './PublicRelaySection';
export { usePublicRelay } from './PublicRelaySection.hooks';
export { UpdateSection } from './UpdateSection';
export { UpdateBanner } from './UpdateBanner';
export { useAppUpdate } from './UpdateSection.hooks';
export { CliSection } from './CliSection';
export { useCliSection } from './CliSection.hooks';
export { ProviderSection } from './ProviderSection';
export { ProviderDataProvider, useProviderData } from './provider-connection/ProviderDataContext';
export { describeError } from './provider-connection/useProviderConnectionData';

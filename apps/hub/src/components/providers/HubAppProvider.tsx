import { createContext, useContext, type ReactNode } from 'react';
import type { HubHttpClient, HubApiClient, HubPlatformBridge, HubStatusPresenter } from '../../client/types';
import type { createProjectsFeature } from '../../client/projects';
import type { createTaskMonitorFeature } from '../../client/task-monitor';
import type { createPromptPresetFeature } from '../../features/prompt-preset';
import type { createSettingsFeature } from '../../features/settings';

interface HubRuntime {
  http: HubHttpClient;
  api: HubApiClient;
  platform: HubPlatformBridge;
  status: HubStatusPresenter;
  projectsFeature: ReturnType<typeof createProjectsFeature>;
  promptPresetFeature: ReturnType<typeof createPromptPresetFeature>;
  taskMonitorFeature: ReturnType<typeof createTaskMonitorFeature>;
  settingsFeature: ReturnType<typeof createSettingsFeature>;
}

const HubRuntimeContext = createContext<HubRuntime | null>(null);

export function HubRuntimeProvider({ runtime, children }: { runtime: HubRuntime; children: ReactNode }) {
  return <HubRuntimeContext.Provider value={runtime}>{children}</HubRuntimeContext.Provider>;
}

export function useHubRuntime(): HubRuntime {
  const ctx = useContext(HubRuntimeContext);
  if (!ctx) throw new Error('useHubRuntime must be used within HubRuntimeProvider');
  return ctx;
}

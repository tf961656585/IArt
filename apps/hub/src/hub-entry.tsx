import { createRoot } from 'react-dom/client';
import { fetchHubBootstrapFromElectron, isElectronEnvironment } from '@iart/backend-sdk';
import { normalizeLocalApiBase } from './client/bootstrap';
import { applyThemeToDocument, readThemePreference } from './client/theme/theme-store';
import { createHubHttpClient } from './client/adapters/http-client';
import { createHubApiClient } from './client/api/hub-api';
import { createHubPlatformBridge } from './client/platform/electron-bridge';
import { createProjectsFeature } from './client/projects';
import { createTaskMonitorFeature } from './client/task-monitor';
import { createStatusPresenter } from './client/utils/status-presenter';
import { createPromptPresetFeature } from './features/prompt-preset';
import { createSettingsFeature } from './features/settings';
import { App } from './App';
import { HubRuntimeProvider } from './components/providers/HubAppProvider';
import './app/globals.css';
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';

// 主题早期应用（spec: docs/hub/hub-renderer-architecture.md §8.1）：
// 在 React render 前同步读 localStorage 偏好并应用，避免首屏闪屏。
// 默认深色；用户可在设置切换浅色 / 深色 / 跟随系统。
applyThemeToDocument(readThemePreference());

function FatalErrorScreen({ message }: { message: string }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100vh',
        background: 'var(--background)',
        color: 'var(--destructive)',
        fontFamily: 'var(--font-sans)',
      }}
    >
      {message}
    </div>
  );
}

async function bootstrap() {
  // 阶段0：环境就绪
  let baseUrl = '';
  let hubWriteToken: string | undefined = undefined;
  if (isElectronEnvironment()) {
    const b = await fetchHubBootstrapFromElectron();
    baseUrl = normalizeLocalApiBase(b?.backendBaseUrl ?? null) ?? '';
    hubWriteToken = b?.hubWriteToken;
  }
  if (!baseUrl || !hubWriteToken?.trim()) {
    const root = document.getElementById('root') ?? document.body;
    createRoot(root).render(<FatalErrorScreen message="启动失败，请重新打开应用" />);
    return;
  }
  // 阶段1：构建
  const http = createHubHttpClient(baseUrl, hubWriteToken);
  const api = createHubApiClient(http);
  const platform = createHubPlatformBridge();
  const status = createStatusPresenter();
  const projectsFeature = createProjectsFeature(platform);
  const promptPresetFeature = createPromptPresetFeature(api);
  const taskMonitorFeature = createTaskMonitorFeature(api);
  const settingsFeature = createSettingsFeature(api);
  // 阶段4：渲染
  const root = document.getElementById('root') ?? document.body;
  createRoot(root).render(
    <HubRuntimeProvider
      runtime={{
        http,
        api,
        platform,
        status,
        projectsFeature,
        promptPresetFeature,
        taskMonitorFeature,
        settingsFeature,
      }}
    >
      <App />
    </HubRuntimeProvider>
  );
}

void bootstrap();

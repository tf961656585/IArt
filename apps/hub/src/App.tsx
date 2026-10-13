import { useEffect, useState } from 'react';
import { LayoutGrid, MessageSquare, Activity, Blocks, Package, Settings, LifeBuoy, Aperture, type LucideIcon } from 'lucide-react';
import { Button, cn, OverlayEscapeDispatcher } from '@iart/ui';
import { useHubRuntime } from './components/providers/HubAppProvider';
import { useHubStore } from './client/store/hub-store';
import { ProjectsTab } from './features/projects';
import { PromptPresetTab } from './features/prompt-preset';
import { TaskMonitorTab } from './features/task-monitor';
import { PackagesTab } from './features/packages';
import { SkillsTab } from './features/skills';
import { FirstRunGuide } from './features/onboarding';
import { SettingsTab, UpdateBanner, PENDING_SETTINGS_SECTION_KEY } from './features/settings';
import { HelpTab } from './features/help';
import { HUB_TOP_BAND_HEIGHT } from './components/HubTopBand';

interface NavItem {
  id: string;
  label: string;
  icon: LucideIcon;
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

// 分组导航（spec: docs/hub/visual-design.md §8.1）：工作区 / 系统
const NAV_GROUPS: NavGroup[] = [
  {
    label: '工作区',
    items: [
      { id: 'canvas', label: '画布', icon: LayoutGrid },
      { id: 'prompt-preset', label: '提示词预设', icon: MessageSquare },
      { id: 'task-monitor', label: '任务监控', icon: Activity },
      { id: 'packages', label: '包管理', icon: Package },
      { id: 'skills', label: 'Skill 商店', icon: Blocks },
    ],
  },
  {
    label: '系统',
    items: [
      { id: 'settings', label: '设置', icon: Settings },
      { id: 'help', label: '帮助', icon: LifeBuoy },
    ],
  },
];

const NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap((g) => g.items);
const tabLabel = (id: string): string => NAV_ITEMS.find((t) => t.id === id)?.label ?? id;

// 窗口 chrome 平台让位（spec docs/hub/window-chrome.md §6.2）：经 preload 桥暴露的常量消费，
// 不在渲染层硬编码。osPlatform 决定让位方向（macOS 交通灯左侧 / Windows overlay 顶部）。
const electronApi = typeof window !== 'undefined' ? window.electron : undefined;
const osPlatform = electronApi?.platform;
const windowChromeInsets = electronApi?.windowChromeInsets;

export function App() {
  const { platform } = useHubRuntime();
  const currentTab = useHubStore((s) => s.currentTab);
  const setCurrentTab = useHubStore((s) => s.setCurrentTab);
  const [version, setVersion] = useState<string | null>(null);

  // main → Hub 通知：Editor 请求聚焦主窗口并定位设置页子单元（首次指引跨窗口引导，
  // docs/hub/首次指引-design.md §4.3）。切到设置 tab + 写待处理锚点，由 SettingsTab
  // 挂载时消费（sessionStorage 传递：tab 可能尚未挂载，props 会丢）。
  useEffect(() => {
    platform.onHubFocusSettings((notice) => {
      window.sessionStorage.setItem(PENDING_SETTINGS_SECTION_KEY, notice.sectionId);
      setCurrentTab('settings');
    });
    return () => {
      platform.removeHubFocusSettingsListener();
    };
  }, [platform, setCurrentTab]);

  // 版本号加载
  useEffect(() => {
    let cancelled = false;
    void platform.getAppVersion().then((v) => {
      if (!cancelled) setVersion(v);
    });
    return () => {
      cancelled = true;
    };
  }, [platform]);

  return (
    <div className="flex h-screen w-full overflow-hidden bg-background text-foreground">
      {/* 每窗口唯一的 Esc 分发器（spec docs/editor/浮层堆栈管理.md 核心规则 1）：挂在 React 根部，
          不渲染 DOM。浮层经 useOverlayLayer 注册，Esc 只派发栈顶。 */}
      <OverlayEscapeDispatcher />
      {/* 全局横幅（App 顶层常驻，等价 vanilla updateBanner） */}
      <UpdateBanner />
      {/* 首次指引欢迎面（docs/hub/首次指引-design.md §4）：判定与展示自包含，App 顶层挂载，
          不依赖任何 tab 处于激活态；触发条件 = 零服务商且零模型且未看过。 */}
      <FirstRunGuide />
      {/* 方案 C 分隔：hairline(border-r) 之上叠加方向性阴影（向主区外投，只向右/轻微向下），含顶部 1px 亮边；relative z-10 提升 stacking 让阴影绘制在 main 之上 */}
      <aside className="relative z-10 flex w-56 shrink-0 flex-col border-r border-border bg-card shadow-[inset_0_1px_0_var(--border-highlight),8px_0_16px_-4px_var(--shadow-key),4px_0_8px_-2px_var(--shadow-ambient)]">
        {/* 品牌区 = 顶栏带左段（spec docs/hub/window-chrome.md §6.1/§6.3）：带高同源常量，
            mac 下左让位交通灯；品牌柔光局限在品牌 wordmark 区顶部，不蔓延到导航项文字区 */}
        <div
          className="relative flex shrink-0 items-center gap-2 overflow-hidden border-b border-border px-4 [-webkit-app-region:drag]"
          style={{
            height: HUB_TOP_BAND_HEIGHT,
            ...(osPlatform === 'darwin' && windowChromeInsets
              ? { paddingLeft: windowChromeInsets.macosTrafficLightWidth }
              : {}),
          }}
        >
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,oklch(0.58_0.21_277/0.08),transparent_75%)]"
          />
          <Aperture className="relative h-6 w-6 text-primary" />
          <span className="relative text-lg font-semibold">IARTStudio</span>
        </div>
        <nav className="flex flex-1 flex-col gap-4 overflow-y-auto p-2">
          {NAV_GROUPS.map((group) => (
            <div key={group.label} className="flex flex-col gap-1">
              <div className="px-2 py-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                {group.label}
              </div>
              {group.items.map((item) => {
                const Icon = item.icon;
                const active = currentTab === item.id;
                return (
                  <Button
                    key={item.id}
                    variant="ghost"
                    className={cn('justify-start gap-2', active && 'bg-accent text-accent-foreground')}
                    onClick={() => setCurrentTab(item.id)}
                  >
                    <Icon className={cn('h-4 w-4', active ? 'text-primary' : 'text-muted-foreground')} />
                    {item.label}
                  </Button>
                );
              })}
            </div>
          ))}
        </nav>
        <div className="shrink-0 border-t border-border px-4 py-3 text-xs text-muted-foreground">
          {version ? `v${version}` : '正在读取版本'}
        </div>
      </aside>
      {/* 滚动责任在各 tab 内部（各页自带内容滚动列），main 只做裁剪：
          外层再开滚动会形成第二条冗余滚动轨道（spec docs/hub/visual-design.md §5.6）。
          Windows overlay 让位不在 main 整体 paddingTop（spec §6.2 改为各 tab 顶栏带右侧预留） */}
      <main className="flex min-w-0 flex-1 overflow-hidden">
        {currentTab === 'canvas' ? (
          <ProjectsTab />
        ) : currentTab === 'prompt-preset' ? (
          <PromptPresetTab />
        ) : currentTab === 'task-monitor' ? (
          <TaskMonitorTab />
        ) : currentTab === 'packages' ? (
          <PackagesTab />
        ) : currentTab === 'skills' ? (
          <SkillsTab />
        ) : currentTab === 'settings' ? (
          <SettingsTab />
        ) : currentTab === 'help' ? (
          <HelpTab />
        ) : (
          <div className="flex flex-1 items-center justify-center">
            <div className="text-2xl text-muted-foreground">{tabLabel(currentTab)}</div>
          </div>
        )}
      </main>
    </div>
  );
}

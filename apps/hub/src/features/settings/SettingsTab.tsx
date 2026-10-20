import { useCallback, useEffect, useState } from 'react';
import { AppearanceSection } from './AppearanceSection';
import { CliSection } from './CliSection';
import { NetworkProxySection } from './NetworkProxySection';
import { PublicRelaySection } from './PublicRelaySection';
import { ProviderDataProvider } from './provider-connection/ProviderDataContext';
import { ProviderSection } from './ProviderSection';
import { RunPolicySection } from './RunPolicySection';
import { UpdateSection } from './UpdateSection';
import {
  DEFAULT_SETTINGS_SECTION_ID,
  SETTINGS_SECTION_IDS,
  SettingsNav,
} from './components/SettingsNav';
import { HubTopBand } from '../../components/HubTopBand';

/**
 * 设置 tab 容器（spec docs/hub/hub-information-architecture.md §5.2/§5.4/§7）。
 *
 * **一个导航项 = 一个页面**：左侧分区导航选中哪一项，右侧只渲染该子单元的页面。
 * 不再把全部子单元串成一条长滚动——那样做有两个已实证的后果：① 激活态只能由滚动位置
 * 推断，于是导航会说谎（命令行工具高亮时屏幕上 2/3 是服务商）；② 所有子单元被迫共用
 * 同一条内容列宽，数据面（服务商主从、模型清单）被表单列宽压到详情 494px。
 *
 * **内容列宽按页面性质决定**（docs/hub/visual-design.md §8.5）：
 * 表单类页面 768 居中（`max-w-3xl mx-auto`），数据类页面按可用宽度铺满。
 * 768 只约束表单字段轨，不再作为「设置页所有表面」的统一上限。
 *
 * **深链**：`settings#providers` 等 hash 的语义由「滚动到锚点」改为「切到该分区页」；
 * 锚点 id 全集仍是 `SETTINGS_SECTION_IDS` 单一事实源，外部生产者（首次指引欢迎模态、
 * Editor 的 `hub:focus-settings` 通知）零改动。
 *
 * 全局 banner（更新）由 App 顶层承载，不在此处渲染。
 */

/** 服务商与模型分区的页面名（= 分区名；子单元名「服务商」留给导航项与卡片标题） */
const PROVIDERS_PAGE_LABEL = '服务商与模型';

/** 子单元 id → 页面名（顶栏面包屑用）。id 即深链 hash，与 SETTINGS_SECTION_IDS 同源。 */
const PAGE_LABEL_BY_ID: Readonly<Record<string, string>> = {
  appearance: '外观',
  'run-policy': '运行策略',
  'network-proxy': '网络代理',
  'public-relay': '公共中转',
  update: '检查更新',
  cli: '命令行工具',
  providers: PROVIDERS_PAGE_LABEL,
};

/**
 * 程序化锚点定位的跨作用域传递键（首次指引跨窗口引导）：
 * App 级监听（App.tsx useHubFocusSettingsEffect）收到 main 的 hub:focus-settings 通知后
 * 写入 sessionStorage；SettingsTab 挂载时消费并清除。经 sessionStorage 而非 props 的原因：
 * 设置 tab 由 currentTab 条件挂载，通知到达时 tab 可能尚未挂载，直接 props 传递会丢。
 */
export const PENDING_SETTINGS_SECTION_KEY = 'hub:pending-settings-section';

export function SettingsTab() {
  const [sectionId, setSectionId] = useState<string>(DEFAULT_SETTINGS_SECTION_ID);

  /** 切换分区：更新激活态 + 更新 hash（支持深链分享，不走 URL 路由跳转） */
  const selectSection = useCallback((id: string): void => {
    setSectionId(id);
    window.history.replaceState(null, '', '#' + id);
  }, []);

  /** 挂载时的落地分区：待处理锚点（首次指引跨窗口引导）优先于 hash，hash 优先于默认值。
      待处理锚点来自 main 的通知，比 URL 里可能残留的旧 hash 更晚、更可信。 */
  useEffect(() => {
    const pending = window.sessionStorage.getItem(PENDING_SETTINGS_SECTION_KEY);
    if (pending !== null) {
      window.sessionStorage.removeItem(PENDING_SETTINGS_SECTION_KEY);
      if (SETTINGS_SECTION_IDS.includes(pending)) {
        setSectionId(pending);
        window.history.replaceState(null, '', '#' + pending);
        return;
      }
    }
    const hash = window.location.hash.slice(1);
    if (hash !== '' && SETTINGS_SECTION_IDS.includes(hash)) {
      setSectionId(hash);
    }
  }, []);

  /** 外部改 hash（同一窗口再次深链）时同步切换：hashchange 是浏览器已提供的事件源，
      不为此引入路由库。 */
  useEffect(() => {
    const onHashChange = (): void => {
      const hash = window.location.hash.slice(1);
      if (hash !== '' && SETTINGS_SECTION_IDS.includes(hash)) setSectionId(hash);
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  return (
    <div className="flex h-full w-full flex-col">
      {/* 顶栏带（spec docs/hub/window-chrome.md §6.1/§6.3）：标题常驻，分区切换不改变带高与水平轴 */}
      <HubTopBand>
        <h1 className="text-xl font-semibold">设置</h1>
        <span className="text-sm text-muted-foreground">{`/ ${PAGE_LABEL_BY_ID[sectionId] ?? ''}`}</span>
      </HubTopBand>
      <div className="flex min-h-0 flex-1">
        <SettingsNav activeId={sectionId} onSelect={selectSection} />
        <div className="flex min-w-0 flex-1 flex-col overflow-y-auto p-4">
          <SettingsPage id={sectionId} />
        </div>
      </div>
    </div>
  );
}

/**
 * 分区页面：只渲染当前子单元，切换分区即卸载（未激活页面的表单 hook 不再常驻）。
 *
 * 列宽在这里统一施加：表单类 768 居中，数据类铺满——「768 只管表单字段轨」的落点，
 * 避免每个子单元各写一次列宽。
 */
function SettingsPage({ id }: { id: string }) {
  if (id === 'providers') {
    return (
      <div id="providers" className="flex min-w-0 flex-col gap-4">
        <ProviderDataProvider>
          <ProviderSection />
        </ProviderDataProvider>
      </div>
    );
  }

  return (
    <div id={id} className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      {renderFormSection(id)}
    </div>
  );
}

/** 表单类子单元装配（一个分区一页，只渲染当前页的卡片）。 */
function renderFormSection(id: string): React.ReactNode {
  switch (id) {
    case 'appearance':
      return <AppearanceSection />;
    case 'run-policy':
      return <RunPolicySection />;
    case 'network-proxy':
      return <NetworkProxySection />;
    case 'public-relay':
      return <PublicRelaySection />;
    case 'update':
      return <UpdateSection />;
    case 'cli':
      return <CliSection />;
    default:
      return null;
  }
}

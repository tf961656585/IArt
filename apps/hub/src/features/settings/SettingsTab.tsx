import { useEffect, useRef, useState } from 'react';
import { AppearanceSection } from './AppearanceSection';
import { CliSection } from './CliSection';
import { NetworkProxySection } from './NetworkProxySection';
import { PublicRelaySection } from './PublicRelaySection';
import { ProviderDataProvider } from './provider-connection/ProviderDataContext';
import { ProviderSection } from './ProviderSection';
import { RunPolicySection } from './RunPolicySection';
import { UpdateSection } from './UpdateSection';
import { SETTINGS_SECTION_IDS, SettingsNav } from './components/SettingsNav';
import { HubTopBand } from '../../components/HubTopBand';

/**
 * 设置 tab 容器（spec docs/hub/hub-information-architecture.md §5/§6/§7/§8）：
 * 左侧锚点导航 + 右侧分区内容。两个一级分区，按业务链路组织：
 * ① 通用设置（外观、运行策略、网络代理、公共中转、检查更新、命令行工具）；
 * ② 服务商与模型（服务商 + 模型添加同页，见 ProviderSection）。
 *
 * 锚点导航：点击 scrollIntoView 定位；激活态由 IntersectionObserver 反向同步
 * （基于可视区观测，不基于 scroll 位置计算，spec §5.2）。支持深链（hash 定位到子单元）。
 *
 * 全局 banner（更新）由 App 顶层承载，不在此处渲染。
 * 内容列 768px（max-w-3xl，docs/hub/visual-design.md §8.5 密度）：窄工具列是刻意取向
 * （macOS 系统设置同款），宽窗右缘留白不得为「填满」而放宽列宽。
 */

/** 分区标题（spec §5.1 固定命名） */
const PARTITION_GENERAL = '通用设置';
const PARTITION_PROVIDERS = '服务商与模型';

/**
 * 程序化锚点定位的跨作用域传递键（首次指引跨窗口引导）：
 * App 级监听（App.tsx useHubFocusSettingsEffect）收到 main 的 hub:focus-settings 通知后
 * 写入 sessionStorage；SettingsTab 挂载时消费并清除。经 sessionStorage 而非 props 的原因：
 * 设置 tab 由 currentTab 条件挂载，通知到达时 tab 可能尚未挂载，直接 props 传递会丢。
 */
export const PENDING_SETTINGS_SECTION_KEY = 'hub:pending-settings-section';

export function SettingsTab() {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [activeId, setActiveId] = useState<string>('appearance');

  /** 程序化锚点定位（首次指引跨窗口引导，docs/hub/首次指引-design.md §4.3）：
      App 级监听 main 的 hub:focus-settings 通知后写 sessionStorage 待处理锚点，
      本 effect 在设置 tab 挂载时消费（一次定位后清除）。 */
  useEffect(() => {
    const pending = window.sessionStorage.getItem(PENDING_SETTINGS_SECTION_KEY);
    if (pending === null) return;
    window.sessionStorage.removeItem(PENDING_SETTINGS_SECTION_KEY);
    if (!SETTINGS_SECTION_IDS.includes(pending)) return;
    // 首帧渲染后滚动：等分区内容布局完成再定位（rAF 一次即可，IntersectionObserver 会接管激活态）。
    window.requestAnimationFrame(() => {
      const el = document.getElementById(pending);
      if (el !== null) {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        setActiveId(pending);
      }
    });
  }, []);

  /** 反向同步激活态：IntersectionObserver 触发时扫描全部子单元，取最靠近顶部的可见子单元 */
  useEffect(() => {
    const root = scrollRef.current;
    if (root === null) return;

    const observer = new IntersectionObserver(
      () => {
        const rootEl = scrollRef.current;
        if (rootEl === null) return;
        const rootTop = rootEl.getBoundingClientRect().top;
        let current = 'appearance';
        for (const id of SETTINGS_SECTION_IDS) {
          const el = document.getElementById(id);
          if (el === null) continue;
          // 子单元顶部相对滚动容器顶部的偏移；<=阈值(40px) 视为已进入激活线
          const offset = el.getBoundingClientRect().top - rootTop;
          if (offset <= 40) {
            current = id;
          } else {
            break;
          }
        }
        setActiveId(current);
      },
      { root, rootMargin: '0px 0px -80% 0px', threshold: [0, 0.25, 0.5, 1] },
    );

    for (const id of SETTINGS_SECTION_IDS) {
      const el = document.getElementById(id);
      if (el !== null) observer.observe(el);
    }
    return () => observer.disconnect();
  }, []);

  /** 深链定位：挂载时读取 hash 滚动到对应子单元（spec §8 设置页深链） */
  useEffect(() => {
    const hash = window.location.hash.slice(1);
    if (hash === '') return;
    if (!SETTINGS_SECTION_IDS.includes(hash)) return;
    const el = document.getElementById(hash);
    if (el !== null) {
      el.scrollIntoView({ block: 'start' });
      setActiveId(hash);
    }
  }, []);

  /** 点击锚点项：滚动定位 + 同步激活态 + 更新 hash（支持深链分享，不触发 URL 路由跳转） */
  const handleSelect = (id: string): void => {
    const el = document.getElementById(id);
    if (el !== null) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      setActiveId(id);
      window.history.replaceState(null, '', '#' + id);
    }
  };

  return (
    <div className="flex h-full w-full flex-col">
      {/* 顶栏带（spec docs/hub/window-chrome.md §6.1/§6.3）：设置标题常驻，深链定位不受滚动影响 */}
      <HubTopBand>
        <h1 className="text-xl font-semibold">设置</h1>
      </HubTopBand>
      <div className="flex min-h-0 flex-1">
        <SettingsNav activeId={activeId} onSelect={handleSelect} />
        <div ref={scrollRef} className="flex min-w-0 flex-1 flex-col overflow-y-auto p-4">
          <div className="flex max-w-3xl flex-col gap-6">
            {/* ① 通用设置（spec §5.1）：业务无关偏好 */}
            <SettingsPartition label={PARTITION_GENERAL}>
              <div id="appearance" className="scroll-mt-4">
                <AppearanceSection />
              </div>
              <div id="run-policy" className="scroll-mt-4">
                <RunPolicySection />
              </div>
              <div id="network-proxy" className="scroll-mt-4">
                <NetworkProxySection />
              </div>
              <div id="public-relay" className="scroll-mt-4">
                <PublicRelaySection />
              </div>
              <div id="update" className="scroll-mt-4">
                <UpdateSection />
              </div>
              <div id="cli" className="scroll-mt-4">
                <CliSection />
              </div>
            </SettingsPartition>

            {/* ② 服务商与模型（spec §7）：服务商与模型添加同页完成，见 ProviderSection 说明 */}
            <SettingsPartition label={PARTITION_PROVIDERS}>
              <ProviderDataProvider>
                <div id="providers" className="scroll-mt-4">
                  <ProviderSection />
                </div>
              </ProviderDataProvider>
            </SettingsPartition>
          </div>
        </div>
      </div>
    </div>
  );
}

/** 分区分组容器：分区标题 + 子单元列表（gap-3） */
function SettingsPartition({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="flex flex-col gap-3">{children}</div>
    </section>
  );
}

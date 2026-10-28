import { CloudUpload, Globe, Layers, Palette, RefreshCw, Server, SlidersHorizontal, Terminal, type LucideIcon } from 'lucide-react';
import { Button, cn, SELECTION_SOFT_COMPACT_CLASSES } from '@iart/ui';

/**
 * 设置页左侧分区导航（spec docs/hub/hub-information-architecture.md §5.2）。
 *
 * 一个导航项 = 一个页面：点击后右侧只渲染该子单元，不再把全部子单元串成一条长滚动。
 * 激活态由「当前显示的是哪个分区」直接决定（SettingsTab 的 sectionId），不由滚动位置推断——
 * 滚动推断会让导航说谎（高亮项与屏幕上占多数的分区可以不一致）。
 *
 * 列出全部两个一级分区的子单元（通用 6 + 服务商与模型 2），按 spec §5.1/§7.2 顺序排列，
 * 按分区分组。视觉与 Hub 主侧边栏同源（spec §5.2：ghost 按钮 + 选中态令牌 + 图标色）。
 */

export interface SettingsNavItem {
  id: string;
  label: string;
  icon: LucideIcon;
}

export interface SettingsNavGroup {
  label: string;
  items: SettingsNavItem[];
}

/** 全部子单元按分区与 spec §5.1/§7.2 顺序排列（id 即页面 id / 深链 hash） */
export const SETTINGS_NAV_GROUPS: ReadonlyArray<SettingsNavGroup> = [
  {
    label: '通用设置',
    items: [
      { id: 'appearance', label: '外观', icon: Palette },
      { id: 'run-policy', label: '运行策略', icon: SlidersHorizontal },
      { id: 'network-proxy', label: '网络代理', icon: Globe },
      { id: 'public-relay', label: '公共中转', icon: CloudUpload },
      { id: 'update', label: '检查更新', icon: RefreshCw },
      { id: 'cli', label: '命令行工具', icon: Terminal },
    ],
  },
  {
    label: '服务商与模型',
    items: [
      { id: 'providers', label: '服务商', icon: Server },
      { id: 'interface-formats', label: '接口格式', icon: Layers },
    ],
  },
];

export const SETTINGS_SECTION_IDS: ReadonlyArray<string> = SETTINGS_NAV_GROUPS.flatMap((g) => g.items.map((i) => i.id));

/** 默认分区：无深链、无待处理锚点时的落地页。 */
export const DEFAULT_SETTINGS_SECTION_ID = 'appearance';

interface SettingsNavProps {
  /** 当前显示的分区 id */
  activeId: string;
  /** 点击导航项回调（由 SettingsTab 切换分区并更新 hash） */
  onSelect: (id: string) => void;
}

export function SettingsNav({ activeId, onSelect }: SettingsNavProps) {
  return (
    <nav
      aria-label="设置分区"
      className="flex w-48 shrink-0 flex-col gap-4 overflow-y-auto border-r border-border p-2"
    >
      {SETTINGS_NAV_GROUPS.map((group) => (
        <div key={group.label} className="flex flex-col gap-1">
          <div className="px-2 py-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
            {group.label}
          </div>
          {group.items.map((item) => {
            const Icon = item.icon;
            const active = activeId === item.id;
            return (
              <Button
                key={item.id}
                variant="ghost"
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'justify-start gap-2',
                  active && SELECTION_SOFT_COMPACT_CLASSES,
                )}
                onClick={() => onSelect(item.id)}
              >
                <Icon className={cn('h-4 w-4', active ? 'text-[var(--selection-fg)]' : 'text-muted-foreground')} />
                {item.label}
              </Button>
            );
          })}
        </div>
      ))}
    </nav>
  );
}

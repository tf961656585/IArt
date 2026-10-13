import { CloudUpload, Globe, Palette, RefreshCw, Server, SlidersHorizontal, Terminal, type LucideIcon } from 'lucide-react';
import { Button, cn } from '@iart/ui';

/**
 * 设置页左侧锚点导航（spec docs/hub/hub-information-architecture.md §5.2）。
 * 列出全部两个一级分区的子单元（通用 6 + 服务商与模型 1），
 * 按分区分组、spec §5.1/§7.2 顺序排列。点击滚动定位由 SettingsTab 的 onSelect 处理，
 * 激活态由 SettingsTab 的 IntersectionObserver 反向同步。
 * 视觉与 Hub 主侧边栏同源（spec §5.2：ghost 按钮 + 选中态令牌 + 图标色）。
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

/** 全部子单元按分区与 spec §5.1/§7.2 顺序排列（id 即锚点目标 element id / 深链 hash） */
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
    items: [{ id: 'providers', label: '服务商', icon: Server }],
  },
];

export const SETTINGS_SECTION_IDS: ReadonlyArray<string> = SETTINGS_NAV_GROUPS.flatMap((g) => g.items.map((i) => i.id));

interface SettingsNavProps {
  /** 当前激活的子单元 id */
  activeId: string;
  /** 点击锚点项回调（由 SettingsTab 实现滚动定位） */
  onSelect: (id: string) => void;
}

export function SettingsNav({ activeId, onSelect }: SettingsNavProps) {
  return (
    <nav className="flex w-52 shrink-0 flex-col gap-4 overflow-y-auto border-r border-border p-2">
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
                className={cn('justify-start gap-2', active && 'bg-accent text-accent-foreground')}
                onClick={() => onSelect(item.id)}
              >
                <Icon className={cn('h-4 w-4', active ? 'text-primary' : 'text-muted-foreground')} />
                {item.label}
              </Button>
            );
          })}
        </div>
      ))}
    </nav>
  );
}

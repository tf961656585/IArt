import { Label, ToggleGroup, ToggleGroupItem } from '@iart/ui';
import { useTheme } from '../../client/theme/use-theme';
import type { ThemePreference } from '../../client/theme/theme-store';
import { SettingsSection } from './components/SettingsSection';

const THEME_OPTIONS: ReadonlyArray<{ value: ThemePreference; label: string }> = [
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
  { value: 'system', label: '跟随系统' },
];

/**
 * 设置页「外观」子单元（通用设置分区）：主题切换（浅色 / 深色 / 跟随系统）。
 * 走 localStorage 独立 themeStore，不经 backend config（切换机制见
 * docs/hub/hub-renderer-architecture.md §8.1）。视觉令牌与对比度约束见
 * docs/hub/visual-design.md §5.4 / §5.5。
 */
export function AppearanceSection() {
  const { preference, setPreference } = useTheme();

  return (
    <SettingsSection title="外观">
      {/* 纵向字段行 label↔控件 8px（visual-design §8.6 律一） */}
      <div className="flex flex-col gap-2">
        <Label>主题</Label>
        <ToggleGroup
          type="single"
          variant="outline"
          value={preference}
          onValueChange={(value) => {
            // Radix single 模式点击当前项会回传空串（取消选中），此处忽略保住单选常驻
            if (value === 'light' || value === 'dark' || value === 'system') {
              setPreference(value);
            }
          }}
        >
          {THEME_OPTIONS.map((opt) => (
            <ToggleGroupItem key={opt.value} value={opt.value}>
              {opt.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>
    </SettingsSection>
  );
}

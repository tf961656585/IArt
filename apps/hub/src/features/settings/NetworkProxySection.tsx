import { useEffect } from 'react';
import { Input, Label, ToggleGroup, ToggleGroupItem } from '@iart/ui';
import type { ProxyMode } from '@iart/contracts';
import { useNetworkProxy } from './NetworkProxySection.hooks';
import { SettingsSection } from './components/SettingsSection';

/**
 * 设置页「网络代理」子单元（通用设置分区）：
 * 三档单选（跟随系统代理 / 不使用代理 / 手动代理）+ 手动模式下的代理地址输入框。
 * 变更 debounce 300ms 自动保存，无手动保存/重载按钮；状态行仅错误留痕。
 * 保存即时生效（backend 出站 fetch dispatcher 重建，对新的生成请求启用）。
 * 配置经 PUT /api/config 落 backend.json（owner：config-store），生效语义见
 * apps/backend/src/local-server/fetch-dispatcher.cts。
 */

const MODE_OPTIONS: ReadonlyArray<{ value: ProxyMode; label: string }> = [
  { value: 'system', label: '跟随系统代理' },
  { value: 'direct', label: '不使用代理' },
  { value: 'manual', label: '手动代理' },
];

export function NetworkProxySection() {
  const {
    proxyMode,
    proxyUrl,
    statusMessage,
    loadSettings,
    changeProxyMode,
    changeProxyUrl,
  } = useNetworkProxy();

  useEffect(() => {
    void loadSettings(undefined);
  }, [loadSettings]);

  return (
    <SettingsSection title="网络代理">
      {/* 纵向字段行 label↔控件 8px（visual-design §8.6 律一） */}
      <div className="flex flex-col gap-2">
        <Label>代理模式</Label>
        <ToggleGroup
          type="single"
          variant="outline"
          value={proxyMode}
          onValueChange={(value) => {
            // Radix single 模式点击当前项会回传空串（取消选中），此处忽略保住单选常驻
            if (value === 'system' || value === 'direct' || value === 'manual') {
              changeProxyMode(value);
            }
          }}
        >
          {MODE_OPTIONS.map((opt) => (
            <ToggleGroupItem key={opt.value} value={opt.value}>
              {opt.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>

      {proxyMode === 'manual' ? (
        <div className="flex flex-col gap-2">
          <Label htmlFor="proxyUrl">代理地址</Label>
          <Input
            id="proxyUrl"
            type="text"
            placeholder="http://127.0.0.1:7890"
            value={proxyUrl}
            onChange={(event) => changeProxyUrl(event.target.value)}
            className="max-w-80"
          />
          <p className="text-xs text-muted-foreground">
            需要用户名和密码时，写成 http://用户名:密码@主机:端口。
          </p>
        </div>
      ) : null}

      {statusMessage !== null ? <div className="text-xs text-destructive">{statusMessage}</div> : null}
    </SettingsSection>
  );
}

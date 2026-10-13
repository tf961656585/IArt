import { useEffect } from 'react';
import { Input, Label } from '@iart/ui';
import { usePublicRelay } from './PublicRelaySection.hooks';
import { SettingsSection } from './components/SettingsSection';

/**
 * 设置页「公共中转」子单元（通用设置分区）：
 * 两个用户自带的公共中转端点（通用文件中转 / 图像中转）。
 * 变更 debounce 300ms 自动保存，无手动保存/重载按钮；状态行仅错误留痕。
 * 端点不再内置默认（用户自带，spec docs/runtime/public-relay-capability.md）；
 * 配置经 PUT /api/config 落 backend.json（owner：config-store）。
 */

export function PublicRelaySection() {
  const {
    cloudflareEndpoint,
    selfHostedEndpoint,
    statusMessage,
    loadSettings,
    changeCloudflareEndpoint,
    changeSelfHostedEndpoint,
  } = usePublicRelay();

  useEffect(() => {
    void loadSettings(undefined);
  }, [loadSettings]);

  return (
    <SettingsSection title="公共中转">
      <p className="text-xs text-muted-foreground">
        部分模型生成时，需要先把素材上传到你自己的中转服务，再交给模型方获取。未配置时，需要中转的模型暂不可用。
      </p>
      {/* 纵向字段行 label↔控件 8px（visual-design §8.6 律一） */}
      <div className="flex flex-col gap-2">
        <Label htmlFor="publicRelayCloudflareEndpoint">通用文件中转地址</Label>
        <Input
          id="publicRelayCloudflareEndpoint"
          type="text"
          placeholder="https://your-relay.example.com/upload"
          value={cloudflareEndpoint}
          onChange={(event) => changeCloudflareEndpoint(event.target.value)}
          className="max-w-80"
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="publicRelaySelfHostedEndpoint">图像中转地址</Label>
        <Input
          id="publicRelaySelfHostedEndpoint"
          type="text"
          placeholder="https://your-image-relay.example.com/api/upload"
          value={selfHostedEndpoint}
          onChange={(event) => changeSelfHostedEndpoint(event.target.value)}
          className="max-w-80"
        />
      </div>

      {statusMessage !== null ? <div className="text-xs text-destructive">{statusMessage}</div> : null}
    </SettingsSection>
  );
}

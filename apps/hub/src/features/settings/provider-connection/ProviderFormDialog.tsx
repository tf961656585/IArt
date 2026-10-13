import { useState } from 'react';
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
} from '@iart/ui';
import type { ProviderConnection } from '@iart/contracts';
import { FieldLabelRow } from './InfoHint';

/**
 * 添加 / 修改服务商的表单（同一组件的两种模式）。
 *
 * 口径：一次表单填完就能用，不再走多步引导——服务地址、密钥是用户已经熟悉的字段，
 * 拆成多步只会让每次添加都多花几次点击。接口类型不在这里配置（2026-09-29 起摘除
 * 连接级预选）：它是模型记录的属性，添加模型时再选。
 * 添加时「建连接」与「写密钥」是后端两次调用，密钥写入失败不回滚已建好的连接，
 * 由调用方给出「服务商已保存，密钥没写进去」的提示。
 */

export interface ProviderFormPayload {
  display_name: string;
  base_url: string;
  /** 仅添加模式有值；编辑模式密钥走独立入口 */
  credential?: string;
}

/**
 * 三个字段的触发式说明。添加表单与详情里的密钥弹层共用同一组文案
 * （spec `hub-information-architecture.md` §7.8、`provider-config-ui-design.md` §6），
 * 避免两处各写一份、改一处漏一处。
 */
export const PROVIDER_FIELD_HINTS = {
  name: { text: '用来在列表里区分不同服务商。', subject: '名称' },
  baseUrl: {
    text: '服务商给的服务地址，通常以 https:// 开头；服务商要求带上路径就一起写。',
    subject: '服务地址',
  },
  credential: { text: '在服务商后台生成的密钥。', subject: '密钥' },
} as const;

/** 服务地址的比较口径：去首尾空白与结尾的斜杠，其余按原文比。 */
const normalizeBaseUrl = (baseUrl: string): string => baseUrl.trim().replace(/\/+$/, '');

export function ProviderFormDialog({
  connection,
  existingBaseUrls,
  failureText = null,
  onClose,
  onSubmit,
}: {
  /** 传入表示修改，不传表示添加 */
  connection?: ProviderConnection | undefined;
  /** 已有服务商的服务地址（添加模式用来提示疑似重复；非阻断，不拦提交） */
  existingBaseUrls?: ReadonlyArray<string>;
  /**
   * 弹层内发起的写入失败原因。失败时弹层保持打开，页面顶部的提示条被遮罩挡住，
   * 原因必须显示在弹层里（spec hub-information-architecture §12）；修改模式提交后
   * 无论成败都关弹层、原因走页面提示条，用不到这一位。
   */
  failureText?: string | null;
  onClose: () => void;
  onSubmit: (payload: ProviderFormPayload) => Promise<void>;
}) {
  const editing = connection !== undefined;
  const [name, setName] = useState(connection?.display_name ?? '');
  const [baseUrl, setBaseUrl] = useState(connection?.base_url ?? '');
  const [credential, setCredential] = useState('');
  const [busy, setBusy] = useState(false);

  const ready = baseUrl.trim() !== '' && (editing || credential.trim() !== '');

  // 创建态的重复地址提示（非阻断）：与已有服务商同址时提醒确认，不阻止保存。
  // 只在创建态出现——编辑态的地址本来就在那条连接上，比对自己没有意义。
  const duplicateBaseUrlHint =
    !editing
    && baseUrl.trim() !== ''
    && (existingBaseUrls ?? []).some((existing) => normalizeBaseUrl(existing) === normalizeBaseUrl(baseUrl))
      ? '已有一个服务商在用这个服务地址。如果不是重复添加，继续保存即可'
      : null;

  return (
    <Dialog open onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent form="standard" size="standard">
        <DialogHeader>
          <DialogTitle>{editing ? '修改服务商' : '添加服务商'}</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-2">
            <FieldLabelRow htmlFor="provider-name" label="名称" hint={PROVIDER_FIELD_HINTS.name} />
            <Input
              id="provider-name"
              value={name}
              placeholder="例如：我的网关"
              onChange={(event) => setName(event.target.value)}
            />
          </div>

          <div className="flex flex-col gap-2">
            <FieldLabelRow htmlFor="provider-base-url" label="服务地址" hint={PROVIDER_FIELD_HINTS.baseUrl} />
            <Input
              id="provider-base-url"
              value={baseUrl}
              placeholder="https://..."
              onChange={(event) => setBaseUrl(event.target.value)}
            />
          </div>

          {editing ? null : (
            <div className="flex flex-col gap-2">
              <FieldLabelRow htmlFor="provider-credential" label="密钥" hint={PROVIDER_FIELD_HINTS.credential} />
              <Input
                id="provider-credential"
                type="password"
                value={credential}
                placeholder="粘贴服务商给的密钥"
                autoComplete="off"
                onChange={(event) => setCredential(event.target.value)}
              />
            </div>
          )}
        </div>

        {duplicateBaseUrlHint === null ? null : (
          <p className="text-2xs text-muted-foreground">{duplicateBaseUrlHint}</p>
        )}

        {failureText === null ? null : (
          <p role="alert" className="text-2xs text-destructive">{failureText}</p>
        )}

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button
            type="button"
            disabled={busy || !ready}
            onClick={() => {
              setBusy(true);
              const payload: ProviderFormPayload = {
                display_name: name.trim() === '' ? defaultName(baseUrl) : name.trim(),
                base_url: baseUrl.trim(),
                ...(editing ? {} : { credential: credential.trim() }),
              };
              void onSubmit(payload).finally(() => setBusy(false));
            }}
          >
            {editing ? '保存' : '添加'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 名称留空时按地址生成一个可区分的默认名 */
function defaultName(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  return trimmed === '' ? '我的服务商' : trimmed;
}

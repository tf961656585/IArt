import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ProviderConnection } from '@iart/contracts';

import { ProviderDetail } from '../ProviderDetail';
import { CREDENTIAL_WEAK_PROTECTION_HINT } from '../credentialDisplay';

/**
 * 服务商详情的密钥状态（2026-10-29）。
 *
 * 契约里 `credential_protection` / `credential_status` 都是 `nullable().optional()`：
 * 两个字段的 `undefined` 与 `null` 都必须按「没有该信息」处理——沿用改造前的「密钥已保存」，
 * 不出现新状态词、不挂解释入口。后端从不验证密钥有效性，界面只有「已保存 / 需要重新填写」，
 * 不出现「无效 / 验证失败」（`docs/ui-copy-standard.md` 第 9 条）。
 */

const connection: ProviderConnection = {
  connection_id: 'up_conn_credential1',
  display_name: '我的服务商',
  base_url: 'https://api.example.com',
  has_credential: true,
  lifecycle: 'enabled',
  revision: 1,
  created_at: '2026-10-29T00:00:00.000Z',
  updated_at: '2026-10-29T00:00:00.000Z',
};

const noop = () => undefined;

/** 只渲染详情头：模型表格给空清单，密钥状态的断言不依赖表格内容。 */
const renderDetail = (overrides: Partial<ProviderConnection> = {}): void => {
  const target: ProviderConnection = { ...connection, ...overrides };
  render(
    <ProviderDetail
      connection={target}
      onReload={noop}
      onEdit={noop}
      onCredential={noop}
      onToggle={noop}
      onClearCredential={noop}
      onDelete={noop}
      onAddModelByKind={noop}
      modelTable={{
        rows: [],
        catalog: [],
        chatCatalog: [],
        editable: true,
        modelListUnavailable: false,
        interfaceRecipes: [],
        interfaceRecipesUnavailable: false,
        agentDefaultModelId: null,
        generationDefaultModelId: null,
        onToggleAgentDefault: noop,
        onToggleGenerationDefault: noop,
        onEditChatModel: noop,
        onEditGenerationModel: noop,
        onDeleteGenerationModel: noop,
      }}
    />,
  );
};

describe('服务商详情：密钥状态词', () => {
  it('密钥读不出来：显示「密钥需要重新填写」并用异常态配色，主按钮改为「重新填写密钥」', () => {
    renderDetail({ credential_status: 'needs_reentry', credential_protection: 'os_safe_storage' });

    const status = screen.getByText('密钥需要重新填写');
    expect(status).toBeInTheDocument();
    // 异常色复用既有语义令牌（StatusDot 的 bad 档），不是自造颜色
    expect(status).toHaveClass('text-destructive');
    expect(screen.queryByText('密钥已保存')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重新填写密钥' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '更换密钥' })).not.toBeInTheDocument();
  });

  it('弱保护：显示「密钥已保存（弱保护）」，说明挂在「?」气泡上而不是常驻界面', async () => {
    renderDetail({ credential_status: 'ready', credential_protection: 'obfuscated' });

    expect(screen.getByText('密钥已保存（弱保护）')).toBeInTheDocument();
    // 说明默认不印在界面上
    expect(screen.queryByText(CREDENTIAL_WEAK_PROTECTION_HINT)).not.toBeInTheDocument();

    const hint = screen.getByRole('button', { name: '密钥说明' });
    fireEvent.focus(hint);
    await waitFor(() => {
      expect(screen.getByRole('tooltip')).toHaveTextContent(CREDENTIAL_WEAK_PROTECTION_HINT);
    });
    // 弱保护不影响动作：仍按「有密钥」给「更换密钥」
    expect(screen.getByRole('button', { name: '更换密钥' })).toBeInTheDocument();
  });

  it('弱保护且读不出来：先说恢复动作，不加弱保护后缀（气泡仍可查保护等级）', () => {
    renderDetail({ credential_status: 'needs_reentry', credential_protection: 'obfuscated' });

    expect(screen.getByText('密钥需要重新填写')).toBeInTheDocument();
    expect(screen.queryByText('密钥需要重新填写（弱保护）')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '密钥说明' })).toBeInTheDocument();
  });

  it('两个字段都是 undefined：与改造前一致（「密钥已保存」「更换密钥」，无气泡）', () => {
    renderDetail();

    expect(screen.getByText('密钥已保存')).toBeInTheDocument();
    expect(screen.queryByText(/弱保护/)).not.toBeInTheDocument();
    expect(screen.queryByText('密钥需要重新填写')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '密钥说明' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '更换密钥' })).toBeInTheDocument();
  });

  it('两个字段都是 null：同样按「没有该信息」处理，不显示成异常态', () => {
    renderDetail({ credential_status: null, credential_protection: null });

    expect(screen.getByText('密钥已保存')).toBeInTheDocument();
    expect(screen.queryByText(/弱保护/)).not.toBeInTheDocument();
    expect(screen.queryByText('密钥需要重新填写')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '密钥说明' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '更换密钥' })).toBeInTheDocument();
  });

  it('系统钥匙串保护且可读：仍是「密钥已保存」，不出气泡', () => {
    renderDetail({ credential_status: 'ready', credential_protection: 'os_safe_storage' });

    expect(screen.getByText('密钥已保存')).toBeInTheDocument();
    expect(screen.queryByText(/弱保护/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '密钥说明' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '更换密钥' })).toBeInTheDocument();
  });

  it('没有密钥：沿用「还没设置密钥」与「设置密钥」，忽略凭证投影字段', () => {
    renderDetail({ has_credential: false, credential_status: null, credential_protection: null });

    expect(screen.getByText('还没设置密钥')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '设置密钥' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '密钥说明' })).not.toBeInTheDocument();
  });
});

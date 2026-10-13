import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useState } from 'react';
import { PromptPresetTokenEditor } from '../PromptPresetTokenEditor';
import { assetMentionTokenOf } from '../../../../engine/promptAssetMentions';

const baseProps = {
  promptPresetSnapshots: undefined,
  readOnly: false,
  promptLimit: null,
  editingSessionActive: true,
  placeholder: undefined,
  containerClassName: undefined,
} as const;

function Harness(props: {
  initialValue: string;
  mentionDisplay: ReadonlyMap<string, { label: string }> | undefined;
}) {
  const [value, setValue] = useState(props.initialValue);
  return (
    <div>
      <PromptPresetTokenEditor
        value={value}
        onChange={(next) => setValue(next)}
        mentionDisplay={props.mentionDisplay}
        {...baseProps}
      />
      <div data-testid="raw">{value}</div>
    </div>
  );
}

describe('PromptPresetTokenEditor：@ 资产引用 token 渲染（PI-001）', () => {
  it('生效 token 渲染为 chip，显示执行期派生 label', () => {
    render(
      <Harness
        initialValue={`参考 ${assetMentionTokenOf('asset-1')} 生成`}
        mentionDisplay={new Map([['asset-1', { label: 'Image1' }]])}
      />,
    );
    const chip = screen.getByText('@Image1');
    expect(chip).toBeTruthy();
    const chipEl = chip.closest('[data-asset-id]');
    expect(chipEl?.getAttribute('data-asset-id')).toBe('asset-1');
    expect(chipEl?.getAttribute('contenteditable')).toBe('false');
  });

  it('失效 token（assetId 不在显示表中）渲染失效态，用户文本保留', () => {
    render(
      <Harness
        initialValue={`参考 ${assetMentionTokenOf('asset-gone')} 生成`}
        mentionDisplay={new Map()}
      />,
    );
    const chip = screen.getByText('@已失效引用');
    expect(chip).toBeTruthy();
    const chipEl = chip.closest('[data-asset-id]');
    expect(chipEl?.getAttribute('data-asset-id')).toBe('asset-gone');
    // 序列化后 token 字面量必须原样保留（禁止静默删除/改写）
    expect(screen.getByTestId('raw').textContent).toBe(
      `参考 ${assetMentionTokenOf('asset-gone')} 生成`,
    );
  });

  it('未提供 mentionDisplay 的编辑面：token 按字面量文本渲染，不转 chip', () => {
    render(
      <Harness
        initialValue={`参考 ${assetMentionTokenOf('asset-1')} 生成`}
        mentionDisplay={undefined}
      />,
    );
    expect(document.querySelector('[data-asset-id]')).toBeNull();
    expect(screen.getByTestId('raw').textContent).toBe(
      `参考 ${assetMentionTokenOf('asset-1')} 生成`,
    );
  });
});

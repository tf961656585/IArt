import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type {
  FamilyTemplateOfficialField,
  FamilyTemplateParameterDescriptor,
  ParameterOverrides,
} from '@iart/contracts';

import {
  ParameterOverridesEditor,
  collectOverrideIssues,
  emptyParameterOverrides,
} from '../ParameterOverridesEditor';

/**
 * 参数覆盖编辑器：官方参数的发出位置（请求体 / 查询参数 / 请求头）与按命名空间查重。
 *
 * 口径：别名只改「发出名称」，不改位置；同一个名字在不同命名空间是不同字段，只有同命名空间的
 * 重名才算冲突。自定义参数固定发到请求体（与后端一致），因此只占请求体的名字。
 */

const field = (over: Partial<FamilyTemplateOfficialField>): FamilyTemplateOfficialField => ({
  field_key: 'flag',
  label: '开关',
  component: 'switch',
  wire_name: 'flag',
  wire_location: 'body',
  required: false,
  default_value: null,
  enum_options: [],
  resolution_presets: [],
  aspect_presets: [],
  ...over,
});

const descriptor: FamilyTemplateParameterDescriptor = {
  family_adapter_id: 'openai-image-v1',
  official_fields: [
    field({ field_key: 'size', label: '尺寸', component: 'select', wire_name: 'size', enum_options: ['auto', '1k'], default_value: 'auto' }),
    field({ field_key: 'apiVersion', label: '接口版本', component: 'text', wire_name: 'api_version', wire_location: 'query' }),
    field({ field_key: 'client', label: '客户端标识', component: 'text', wire_name: 'x_client', wire_location: 'header' }),
  ],
  reserved_wire_names: {
    body: ['model', 'prompt'],
    query: ['key'],
    header: ['x_internal'],
  },
  supports_media_slots: [],
  required_media_slots: [],
};

const withOfficialAlias = (fieldKey: string, wireName: string): ParameterOverrides => ({
  official: [{ field_key: fieldKey, wire_name: wireName }],
  custom: [],
});

describe('参数覆盖：发出位置展示', () => {
  it('每个官方参数行显示自己的发出位置与发出名称', () => {
    render(
      <ParameterOverridesEditor
        descriptor={descriptor}
        value={emptyParameterOverrides()}
        onChange={() => undefined}
        liveMediaSlotIds={[]}
      />,
    );

    expect(screen.getByText('请求体')).toBeInTheDocument();
    expect(screen.getByText('查询参数')).toBeInTheDocument();
    expect(screen.getByText('请求头')).toBeInTheDocument();
    expect(screen.getByLabelText('「接口版本」的发送名称')).toHaveAttribute('placeholder', 'api_version');
    expect(screen.getByLabelText('「客户端标识」的发送名称')).toHaveAttribute('placeholder', 'x_client');
  });

  it('别名只改名称：失焦提交后写入 wire_name，位置保持不变', () => {
    const onChange = vi.fn();
    render(
      <ParameterOverridesEditor
        descriptor={descriptor}
        value={emptyParameterOverrides()}
        onChange={onChange}
        liveMediaSlotIds={[]}
      />,
    );

    const input = screen.getByLabelText('「接口版本」的发送名称');
    fireEvent.change(input, { target: { value: 'api_v2' } });
    fireEvent.blur(input);

    expect(onChange).toHaveBeenCalledWith({
      official: [{ field_key: 'apiVersion', wire_name: 'api_v2' }],
      custom: [],
    });
    // 位置上没有可改的入口（查询参数仍是查询参数）
    expect(screen.getByText('查询参数')).toBeInTheDocument();
  });
});

describe('参数覆盖：按命名空间查重', () => {
  it('查询参数与请求体的保留名同名不算冲突', () => {
    const issues = collectOverrideIssues(
      descriptor,
      withOfficialAlias('apiVersion', 'model'),
      [],
    );
    expect(issues).toEqual([]);
  });

  it('查询参数撞上查询命名空间的保留名时报冲突', () => {
    const issues = collectOverrideIssues(
      descriptor,
      withOfficialAlias('apiVersion', 'key'),
      [],
    );
    expect(issues.some((issue) => issue.target === 'apiVersion' && issue.message.includes('不能用了'))).toBe(true);
  });

  it('请求头撞上请求头命名空间的保留名时报冲突', () => {
    const issues = collectOverrideIssues(
      descriptor,
      withOfficialAlias('client', 'x_internal'),
      [],
    );
    expect(issues.some((issue) => issue.target === 'client' && issue.message.includes('不能用了'))).toBe(true);
  });

  it('请求体的祖孙路径与保留名的顶层对象重叠时算冲突', () => {
    const issues = collectOverrideIssues(
      descriptor,
      withOfficialAlias('size', 'model.hint'),
      [],
    );
    expect(issues.some((issue) => issue.target === 'size' && issue.message.includes('不能用了'))).toBe(true);
  });

  it('请求头别名可以用带短横线的请求头名；禁止头立即提示', () => {
    expect(collectOverrideIssues(descriptor, withOfficialAlias('client', 'x-api-key'), [])).toEqual([]);

    const issues = collectOverrideIssues(descriptor, withOfficialAlias('client', 'Content-Type'), []);
    expect(issues.some((issue) => issue.target === 'client' && issue.message.includes('自动管理'))).toBe(true);
  });

  it('查询参数别名按查询参数名字符集校验（允许短横线）', () => {
    expect(collectOverrideIssues(descriptor, withOfficialAlias('apiVersion', 'api-version'), [])).toEqual([]);
  });

  it('请求体参数改成查询参数占用的名字不算冲突', () => {
    const issues = collectOverrideIssues(
      descriptor,
      withOfficialAlias('size', 'key'),
      [],
    );
    expect(issues).toEqual([]);
  });

  it('自定义参数固定发到请求体：可与查询参数保留名同名，但与请求体保留名冲突', () => {
    const base: ParameterOverrides = {
      official: [],
      custom: [{ label: '接口版本', wire_name: 'key', value_type: 'string', required: false }],
    };
    expect(collectOverrideIssues(descriptor, base, [])).toEqual([]);

    const reserved: ParameterOverrides = {
      official: [],
      custom: [{ label: '模型名', wire_name: 'model', value_type: 'string', required: false }],
    };
    expect(
      collectOverrideIssues(descriptor, reserved, []).some((issue) => issue.target === 'custom:0'),
    ).toBe(true);
  });
});

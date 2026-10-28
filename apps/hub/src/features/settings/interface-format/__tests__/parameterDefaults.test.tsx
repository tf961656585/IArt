import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { InterfaceFormatEditor } from '../InterfaceFormatEditor';
import { ParameterDefaultValueField } from '../ParameterDefaultValueField';
import { coerceDefaultForType, parseDefaultValue } from '../parameterDefaults';
import { createHubApiClient } from '../../../../client/api/hub-api';
import { createHubHttpClient } from '../../../../client/adapters/http-client';

/**
 * 接口格式参数行的默认值：类型 → 控件映射、原始值 → 契约值的换算，以及自动清空后的提示。
 *
 * 断言分两层：纯函数覆盖值域换算（不依赖控件），编辑器用例覆盖「填进去 → 保存发什么」，
 * 后者用真 api 客户端、只在最外层挡掉网络。
 */

const BASE = 'http://localhost:4877';
const WRITE_TOKEN = 'a'.repeat(32);

const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

const writeResponse = {
  format_id: 'if_new',
  recipe_id: 'ir_new',
  detail: {
    summary: {
      format_id: 'if_new',
      display_name: '我的格式',
      family: 'generation',
      status: 'ready',
      supports_media_slots: [],
      required_media_slots: [],
      order: 100,
      origin: 'user',
      version: '1.0.0',
    },
    transport: null,
    media_slots: [],
    parameter_descriptor: null,
    builtin_behavior: null,
    used_by_model_count: 0,
    recipe_id: 'ir_new',
  },
};

type FetchMock = ReturnType<typeof vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>>;

const renderEditor = (): FetchMock => {
  const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
    async () => jsonResponse(writeResponse),
  );
  vi.stubGlobal('fetch', fetchMock);
  const api = createHubApiClient(createHubHttpClient(BASE, WRITE_TOKEN));
  render(
    <InterfaceFormatEditor
      mode="create"
      api={api}
      onCancel={() => undefined}
      onSaved={() => undefined}
    />,
  );
  return fetchMock;
};

const fillBasics = (): void => {
  fireEvent.change(screen.getByLabelText('名称'), { target: { value: '我的格式' } });
  fireEvent.change(screen.getByLabelText('提交路径'), { target: { value: '/v1/mine' } });
  fireEvent.change(screen.getByLabelText('产物路径（每行一个）'), { target: { value: 'data.url' } });
};

const addParam = (): void => {
  fireEvent.click(screen.getByRole('button', { name: '添加参数' }));
  fireEvent.change(screen.getByLabelText('第 1 行参数请求体路径'), { target: { value: 'size' } });
  fireEvent.change(screen.getByLabelText('第 1 行参数名称'), { target: { value: '画面尺寸' } });
};

const chooseOption = (comboboxName: string, optionName: string): void => {
  fireEvent.keyDown(screen.getByRole('combobox', { name: comboboxName }), { key: 'Enter' });
  fireEvent.click(screen.getByRole('option', { name: optionName }));
};

const firstPostBody = (fetchMock: FetchMock): { parameters: Array<Record<string, unknown>> } => {
  const call = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
  expect(call).toBeDefined();
  return JSON.parse(String(call?.[1]?.body)) as { parameters: Array<Record<string, unknown>> };
};

beforeEach(() => {
  // jsdom 不实现滚动；点保存定位第一个错误时会调用它
  Object.defineProperty(Element.prototype, 'scrollIntoView', {
    value: vi.fn(),
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('parameterDefaults：值域换算', () => {
  it('布尔三态：是 → true、否 → false、未设置 → 不设默认值', () => {
    expect(parseDefaultValue('boolean', 'true', [])).toEqual({ ok: true, value: true });
    expect(parseDefaultValue('boolean', 'false', [])).toEqual({ ok: true, value: false });
    expect(parseDefaultValue('boolean', '', [])).toEqual({ ok: true });
  });

  it('数字：有限数字写成 number，其它文本报错', () => {
    expect(parseDefaultValue('number', '1024', [])).toEqual({ ok: true, value: 1024 });
    expect(parseDefaultValue('number', '', [])).toEqual({ ok: true });
    expect(parseDefaultValue('number', 'abc', [])).toEqual({ ok: false, message: '默认值要填数字' });
  });

  it('枚举：必须是可选值之一，空表示不设', () => {
    expect(parseDefaultValue('enum', '1024x1024', ['1024x1024', '512x512'])).toEqual({
      ok: true,
      value: '1024x1024',
    });
    expect(parseDefaultValue('enum', '', ['1024x1024'])).toEqual({ ok: true });
    expect(parseDefaultValue('enum', '1792x1024', ['1024x1024'])).toEqual({
      ok: false,
      message: '默认值要从可选值里选',
    });
  });

  it('类型切换：装得下就保留，装不下就清空', () => {
    expect(coerceDefaultForType('true', 'number', [])).toEqual({ value: '', cleared: true });
    expect(coerceDefaultForType('1024', 'string', [])).toEqual({ value: '1024', cleared: false });
    expect(coerceDefaultForType('1024', 'number', [])).toEqual({ value: '1024', cleared: false });
    expect(coerceDefaultForType('1024', 'enum', ['512'])).toEqual({ value: '', cleared: true });
    expect(coerceDefaultForType('', 'boolean', [])).toEqual({ value: '', cleared: false });
  });
});

describe('ParameterDefaultValueField：按类型换控件', () => {
  it('开关类型给三项下拉，选「是」交回 true 原文', () => {
    const onChange = vi.fn();
    render(
      <ParameterDefaultValueField
        type="boolean"
        value=""
        enumValues={[]}
        onChange={onChange}
        id="default"
        ariaLabel="默认值"
      />,
    );

    fireEvent.keyDown(screen.getByRole('combobox', { name: '默认值' }), { key: 'Enter' });
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(['未设置', '是', '否']);
    fireEvent.click(screen.getByRole('option', { name: '是' }));
    expect(onChange).toHaveBeenCalledWith('true');
  });

  it('数字类型用十进制输入，输入原文直接交回父层', () => {
    const onChange = vi.fn();
    render(
      <ParameterDefaultValueField
        type="number"
        value=""
        enumValues={[]}
        onChange={onChange}
        id="default"
        ariaLabel="默认值"
      />,
    );

    const input = screen.getByLabelText('默认值');
    expect(input).toHaveAttribute('inputmode', 'decimal');
    fireEvent.change(input, { target: { value: '1024.5' } });
    expect(onChange).toHaveBeenCalledWith('1024.5');
  });

  it('枚举类型只列当前可选值', () => {
    render(
      <ParameterDefaultValueField
        type="enum"
        value=""
        enumValues={['1024x1024', '512x512']}
        onChange={() => undefined}
        id="default"
        ariaLabel="默认值"
      />,
    );

    fireEvent.keyDown(screen.getByRole('combobox', { name: '默认值' }), { key: 'Enter' });
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      '未设置',
      '1024x1024',
      '512x512',
    ]);
  });

  it('没有可选值时禁用并提示先填可选值', () => {
    render(
      <ParameterDefaultValueField
        type="enum"
        value=""
        enumValues={[]}
        onChange={() => undefined}
        id="default"
        ariaLabel="默认值"
      />,
    );

    expect(screen.getByRole('combobox', { name: '默认值' })).toBeDisabled();
    expect(screen.getByText('先填可选值')).toBeInTheDocument();
  });
});

describe('InterfaceFormatEditor：默认值写进草稿', () => {
  it('开关默认值选「是」时写出布尔 true', async () => {
    const fetchMock = renderEditor();
    fillBasics();
    addParam();
    chooseOption('第 1 行参数类型', '开关');
    chooseOption('第 1 行参数默认值', '是');

    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true));

    expect(firstPostBody(fetchMock).parameters[0]).toMatchObject({
      binding: { location: 'body', path: 'size' },
      label: '画面尺寸',
      type: 'boolean',
      default_value: true,
    });
  });

  it('开关默认值「未设置」时不写 default_value 键', async () => {
    const fetchMock = renderEditor();
    fillBasics();
    addParam();
    chooseOption('第 1 行参数类型', '开关');
    chooseOption('第 1 行参数默认值', '未设置');

    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true));

    const parameter = firstPostBody(fetchMock).parameters[0];
    expect(parameter).toBeDefined();
    expect(parameter).not.toHaveProperty('default_value');
  });

  it('数字默认值写成 number；非法数字点保存后拦住并聚焦，改成合法数字后可提交', async () => {
    const fetchMock = renderEditor();
    fillBasics();
    addParam();
    chooseOption('第 1 行参数类型', '数字');

    fireEvent.change(screen.getByLabelText('第 1 行参数默认值'), { target: { value: 'abc' } });
    // 未点保存前只保留顶部汇总，不铺行内红字
    expect(screen.queryByText('默认值要填数字')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByText('默认值要填数字')).toBeInTheDocument();
    expect(document.activeElement).toBe(screen.getByLabelText('第 1 行参数默认值'));

    fireEvent.change(screen.getByLabelText('第 1 行参数默认值'), { target: { value: '1024' } });
    expect(screen.queryByText('默认值要填数字')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true));

    expect(firstPostBody(fetchMock).parameters[0]).toMatchObject({ type: 'number', default_value: 1024 });
  });

  it('枚举：默认值只从可选值里选；删掉候选值后清空默认值并提示', async () => {
    const fetchMock = renderEditor();
    fillBasics();
    addParam();
    chooseOption('第 1 行参数类型', '选项');

    const addInput = screen.getByLabelText('第 1 行参数的新可选值');
    fireEvent.change(addInput, { target: { value: '1024x1024' } });
    fireEvent.keyDown(addInput, { key: 'Enter' });
    expect(screen.getByText('1024x1024')).toBeInTheDocument();

    chooseOption('第 1 行参数默认值', '1024x1024');
    expect(screen.getByRole('combobox', { name: '第 1 行参数默认值' })).toHaveTextContent('1024x1024');

    // 删掉唯一候选值：默认值随之清空，给出弱提示而不是留一个必然被拒的值
    fireEvent.click(screen.getByRole('button', { name: '删掉第 1 行参数的可选值「1024x1024」' }));
    expect(screen.getByText('默认值已不在可选值里，已清空')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: '第 1 行参数默认值' })).toHaveTextContent('先填可选值');

    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(fetchMock).not.toHaveBeenCalled();

    // 重新填候选值并选默认值后可以保存
    fireEvent.change(addInput, { target: { value: '1024x1024' } });
    fireEvent.keyDown(addInput, { key: 'Enter' });
    chooseOption('第 1 行参数默认值', '1024x1024');
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true));

    expect(firstPostBody(fetchMock).parameters[0]).toMatchObject({
      type: 'enum',
      enum_values: ['1024x1024'],
      default_value: '1024x1024',
    });
  });

  it('类型切换：开关 true 切到数字清空并提示；数字 1024 切到文本保留', () => {
    renderEditor();
    addParam();

    chooseOption('第 1 行参数类型', '开关');
    chooseOption('第 1 行参数默认值', '是');
    chooseOption('第 1 行参数类型', '数字');

    expect(screen.getByLabelText('第 1 行参数默认值')).toHaveValue('');
    expect(screen.getByText('原默认值和新类型不兼容，已清空')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('第 1 行参数默认值'), { target: { value: '1024' } });
    chooseOption('第 1 行参数类型', '文本');
    expect(screen.getByLabelText('第 1 行参数默认值')).toHaveValue('1024');
    expect(screen.queryByText('原默认值和新类型不兼容，已清空')).not.toBeInTheDocument();
  });
});

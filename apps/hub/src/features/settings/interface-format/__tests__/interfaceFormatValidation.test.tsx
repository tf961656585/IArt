import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { FamilyTemplateOfficialField, InterfaceFormatDetail, InterfaceRecipe } from '@iart/contracts';

import { InterfaceFormatEditor } from '../InterfaceFormatEditor';
import { createHubApiClient } from '../../../../client/api/hub-api';
import { createHubHttpClient } from '../../../../client/adapters/http-client';

/**
 * 接口格式编辑器的保存前校验：契约驱动 + 行内定位。
 *
 * 断言的是「点保存后到底发没发请求」与「错误落在哪一行、焦点在哪」，不是组件内部状态：
 * 错误文案必须来自同一份契约校验，用户能据此改对。
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
};

const save = (): void => {
  fireEvent.click(screen.getByRole('button', { name: '保存' }));
};

const chooseOption = (comboboxName: string, optionName: string): void => {
  fireEvent.keyDown(screen.getByRole('combobox', { name: comboboxName }), { key: 'Enter' });
  fireEvent.click(screen.getByRole('option', { name: optionName }));
};

/** 编辑态的详情夹具：只声明用例关心的部分，其余按一份可保存的同步格式补齐。 */
const editDetail = (
  over: {
    officialFields?: FamilyTemplateOfficialField[];
    mediaSlots?: InterfaceFormatDetail['media_slots'];
  } = {},
): InterfaceFormatDetail => ({
  summary: {
    format_id: 'if_edit',
    display_name: '我的格式',
    family: 'generation',
    status: 'ready',
    supports_media_slots: [],
    required_media_slots: [],
    order: 100,
    origin: 'user',
    version: '1.0.0',
  },
  transport: {
    auth: { kind: 'bearer', header_name: 'Authorization', prefix: 'Bearer' },
    endpoints: { submit: '/v1/things' },
    submit: {
      method: 'POST',
      path: '/v1/things',
      content_type: 'application/json',
      payload_format: 'json',
      headers: [],
      query: [],
      form_field_style: 'dotted',
      form_array_style: 'repeat',
    },
    async: null,
    prompt_binding: { location: 'body', path: 'prompt' },
    model_binding: { location: 'body', path: 'model' },
  },
  recipe_id: 'recipe-edit',
  media_slots: over.mediaSlots ?? [],
  parameter_descriptor: {
    family_adapter_id: 'if_edit',
    official_fields: over.officialFields ?? [],
    reserved_wire_names: { body: [], query: [], header: [] },
    supports_media_slots: [],
    required_media_slots: [],
  },
  builtin_behavior: null,
  used_by_model_count: 0,
});

const editRecipe: InterfaceRecipe = {
  recipe_id: 'recipe-edit',
  name: '可用判定',
  family_adapter_id: 'if_edit',
  success_when: { op: 'eq', path: 'status', value: 'succeeded' },
  result: { kind: 'direct_url', media_field_paths: ['data.url'], media_type: 'image' },
  requires_auth: false,
  created_at: '2026-10-24T00:00:00.000Z',
  updated_at: '2026-10-24T01:00:00.000Z',
};

const officialField = (over: Partial<FamilyTemplateOfficialField>): FamilyTemplateOfficialField => ({
  field_key: 'flag',
  label: '是否启用',
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

const renderEditEditor = (detail: InterfaceFormatDetail): FetchMock => {
  const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
    async () => jsonResponse(writeResponse),
  );
  vi.stubGlobal('fetch', fetchMock);
  const api = createHubApiClient(createHubHttpClient(BASE, WRITE_TOKEN));
  render(
    <InterfaceFormatEditor
      mode="edit"
      initial={{ detail, recipe: editRecipe }}
      api={api}
      onCancel={() => undefined}
      onSaved={() => undefined}
    />,
  );
  return fetchMock;
};

const hasPost = (fetchMock: FetchMock): boolean =>
  fetchMock.mock.calls.some(([, init]) => init?.method === 'POST');

/** 编辑态保存走 PUT（创建走 POST）。 */
const hasPut = (fetchMock: FetchMock): boolean =>
  fetchMock.mock.calls.some(([, init]) => init?.method === 'PUT');

const postBody = (fetchMock: FetchMock): Record<string, unknown> => {
  const call = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
  expect(call).toBeDefined();
  return JSON.parse(String(call?.[1]?.body)) as Record<string, unknown>;
};

const putBody = (fetchMock: FetchMock): Record<string, unknown> => {
  const call = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT');
  expect(call).toBeDefined();
  return JSON.parse(String(call?.[1]?.body)) as Record<string, unknown>;
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

describe('接口格式编辑器：保存前校验', () => {
  it('保存按钮始终可点；有缺口时只显示行内错误并聚焦第一个字段，不发请求', () => {
    const fetchMock = renderEditor();
    expect(screen.getByRole('button', { name: '保存' })).toBeEnabled();

    save();

    expect(hasPost(fetchMock)).toBe(false);
    expect(screen.getByText(/还差 \d+ 项/)).toBeInTheDocument();
    expect(document.activeElement).toBe(screen.getByLabelText('名称'));
    expect(screen.getByLabelText('名称')).toHaveAttribute('aria-invalid', 'true');
  });

  it('半填参数行：只填名称不填请求体路径时拦住保存，补全后参数进草稿', async () => {
    const fetchMock = renderEditor();
    fillBasics();
    addParam();
    fireEvent.change(screen.getByLabelText('第 1 行参数名称'), { target: { value: '画面尺寸' } });

    save();

    expect(hasPost(fetchMock)).toBe(false);
    expect(screen.getByText('请求体路径要填，例如 size')).toBeInTheDocument();
    expect(document.activeElement).toBe(screen.getByLabelText('第 1 行参数请求体路径'));

    fireEvent.change(screen.getByLabelText('第 1 行参数请求体路径'), { target: { value: 'size' } });
    save();

    await waitFor(() => expect(hasPost(fetchMock)).toBe(true));
    expect(postBody(fetchMock).parameters).toEqual([
      { binding: { location: 'body', path: 'size' }, label: '画面尺寸', type: 'string', required: false },
    ]);
  });

  it('重复的参数请求体路径：错误落在第二行，改掉后可提交', async () => {
    const fetchMock = renderEditor();
    fillBasics();
    addParam();
    fireEvent.change(screen.getByLabelText('第 1 行参数请求体路径'), { target: { value: 'size' } });
    fireEvent.change(screen.getByLabelText('第 1 行参数名称'), { target: { value: '尺寸' } });
    addParam();
    fireEvent.change(screen.getByLabelText('第 2 行参数请求体路径'), { target: { value: 'size' } });
    fireEvent.change(screen.getByLabelText('第 2 行参数名称'), { target: { value: '尺寸副本' } });

    save();

    expect(hasPost(fetchMock)).toBe(false);
    expect(screen.getByText('这个发送位置和另一行重复或重叠了')).toBeInTheDocument();
    expect(document.activeElement).toBe(screen.getByLabelText('第 2 行参数请求体路径'));

    fireEvent.change(screen.getByLabelText('第 2 行参数请求体路径'), { target: { value: 'quality' } });
    save();

    await waitFor(() => expect(hasPost(fetchMock)).toBe(true));
    expect(
      (postBody(fetchMock).parameters as Array<{ binding: { path: string } }>).map((row) => row.binding.path),
    ).toEqual(['size', 'quality']);
  });

  it('提示词位置和参数请求体路径冲突：提示词与参数行同时报错，改掉后可提交', async () => {
    const fetchMock = renderEditor();
    fillBasics();
    addParam();
    fireEvent.change(screen.getByLabelText('第 1 行参数请求体路径'), { target: { value: 'prompt' } });
    fireEvent.change(screen.getByLabelText('第 1 行参数名称'), { target: { value: '提示词' } });

    save();

    expect(hasPost(fetchMock)).toBe(false);
    expect(screen.getAllByText('提示词的位置不能和参数的发送位置重叠')).toHaveLength(2);
    expect(document.activeElement).toBe(screen.getByLabelText('提示词位置'));

    fireEvent.change(screen.getByLabelText('第 1 行参数请求体路径'), { target: { value: 'text' } });
    save();

    await waitFor(() => expect(hasPost(fetchMock)).toBe(true));
    expect(postBody(fetchMock).prompt_binding).toEqual({ location: 'body', path: 'prompt' });
  });

  it('参数占用系统保留键 __prompt 时拦住保存，并指向参数行', async () => {
    const fetchMock = renderEditor();
    fillBasics();
    addParam();
    fireEvent.change(screen.getByLabelText('第 1 行参数请求体路径'), { target: { value: '__prompt' } });
    fireEvent.change(screen.getByLabelText('第 1 行参数名称'), { target: { value: '提示词' } });

    save();

    expect(hasPost(fetchMock)).toBe(false);
    expect(
      screen.getByText('这个请求体路径是系统保留的，提示词请用「提示词发送到」填写'),
    ).toBeInTheDocument();
    expect(document.activeElement).toBe(screen.getByLabelText('第 1 行参数请求体路径'));
  });

  it('提示词路径 input.text 与参数 input 祖孙重叠：提示词与参数行同时报错，改成不重叠后可提交', async () => {
    const fetchMock = renderEditor();
    fillBasics();
    fireEvent.change(screen.getByLabelText('提示词位置'), { target: { value: 'input.text' } });
    addParam();
    fireEvent.change(screen.getByLabelText('第 1 行参数请求体路径'), { target: { value: 'input' } });
    fireEvent.change(screen.getByLabelText('第 1 行参数名称'), { target: { value: '输入' } });

    save();

    expect(hasPost(fetchMock)).toBe(false);
    expect(screen.getAllByText('提示词的位置不能和参数的发送位置重叠')).toHaveLength(2);
    expect(document.activeElement).toBe(screen.getByLabelText('提示词位置'));

    fireEvent.change(screen.getByLabelText('第 1 行参数请求体路径'), { target: { value: 'text' } });
    save();

    await waitFor(() => expect(hasPost(fetchMock)).toBe(true));
    expect(postBody(fetchMock).prompt_binding).toEqual({ location: 'body', path: 'input.text' });
  });

  it('半填素材位：只填字段位置不填名称时拦住保存，补全后写进草稿', async () => {
    const fetchMock = renderEditor();
    fillBasics();
    fireEvent.click(screen.getByRole('button', { name: '添加素材位' }));
    fireEvent.change(screen.getByLabelText(/素材位字段位置/), { target: { value: 'image' } });

    save();

    expect(hasPost(fetchMock)).toBe(false);
    expect(screen.getByText('名称要填')).toBeInTheDocument();
    expect(document.activeElement).toBe(screen.getByLabelText('第 1 行素材位名称'));

    fireEvent.change(screen.getByLabelText('第 1 行素材位名称'), { target: { value: '参考图' } });
    save();

    await waitFor(() => expect(hasPost(fetchMock)).toBe(true));
    expect(postBody(fetchMock).media_slots).toEqual([
      {
        slot_id: 'reference_image',
        field_key: 'image',
        label: '参考图',
        required: false,
        max_files: 1,
        carrier: 'public_url',
      },
    ]);
  });

  it('顶部汇总的每一项可点击，点击后展开行内错误并聚焦对应字段', () => {
    renderEditor();

    fireEvent.click(screen.getByRole('button', { name: '提交路径' }));

    expect(document.activeElement).toBe(screen.getByLabelText('提交路径'));
    expect(screen.getByLabelText('提交路径')).toHaveAttribute(
      'aria-describedby',
      'interface-format-submit-path-error',
    );
    expect(document.getElementById('interface-format-submit-path-error')).not.toBeNull();
  });

  it('「只给标识，需再取一次」配同步任务时，错误同时指到结果形态和任务模式', () => {
    const fetchMock = renderEditor();
    fillBasics();
    chooseOption('结果形态', '只给标识，需再取一次');
    fireEvent.change(screen.getByLabelText('再取一次的标识路径'), { target: { value: 'id' } });
    fireEvent.change(screen.getByLabelText('内容地址模板'), {
      target: { value: '/v1/files/{id}/content' },
    });

    save();

    expect(hasPost(fetchMock)).toBe(false);
    expect(screen.getAllByText('再取一次要先在任务模式里选「先返回任务，稍后再取」')).toHaveLength(2);
    expect(screen.getByRole('button', { name: '任务模式' })).toBeInTheDocument();
  });

  it('只改了参数类型的行不算空白：拦住保存并报出缺失的请求体路径与名称', () => {
    const fetchMock = renderEditor();
    fillBasics();
    addParam();
    chooseOption('第 1 行参数类型', '选项');

    save();

    expect(hasPost(fetchMock)).toBe(false);
    expect(screen.getByText('请求体路径要填，例如 size')).toBeInTheDocument();
    expect(screen.getByText('名称要填')).toBeInTheDocument();
  });

  it('只改了素材位上传方式的行不算空白：拦住保存并报出缺失的字段位置与名称', () => {
    const fetchMock = renderEditor();
    fillBasics();
    fireEvent.click(screen.getByRole('button', { name: '添加素材位' }));
    chooseOption('第 1 行素材位上传方式', '内嵌内容');

    save();

    expect(hasPost(fetchMock)).toBe(false);
    expect(screen.getByText('字段位置要填，例如 image')).toBeInTheDocument();
    expect(screen.getByText('名称要填')).toBeInTheDocument();
  });

  it('编辑态按官方组件回显参数类型：switch 显示「开关」，保存仍是 boolean', async () => {
    const fetchMock = renderEditEditor(editDetail({ officialFields: [officialField({})] }));

    expect(screen.getByRole('combobox', { name: '第 1 行参数类型' })).toHaveTextContent('开关');

    save();

    await waitFor(() => expect(hasPut(fetchMock)).toBe(true));
    expect((putBody(fetchMock).parameters as Array<{ type: string }>)[0]?.type).toBe('boolean');
  });

  it('编辑态按官方组件回显参数类型：number 显示「数字」，保存仍是 number', async () => {
    const fetchMock = renderEditEditor(editDetail({
      officialFields: [officialField({
        field_key: 'steps',
        label: '步数',
        component: 'number',
        wire_name: 'steps',
      })],
    }));

    expect(screen.getByRole('combobox', { name: '第 1 行参数类型' })).toHaveTextContent('数字');

    save();

    await waitFor(() => expect(hasPut(fetchMock)).toBe(true));
    expect((putBody(fetchMock).parameters as Array<{ type: string }>)[0]?.type).toBe('number');
  });

  it('字段位置格式非法时说明格式规则，而不是提示「要填」', () => {
    const fetchMock = renderEditor();
    fillBasics();
    addParam();
    fireEvent.change(screen.getByLabelText('第 1 行参数请求体路径'), { target: { value: 'a..b' } });
    fireEvent.change(screen.getByLabelText('第 1 行参数名称'), { target: { value: '坏路径' } });

    save();

    expect(hasPost(fetchMock)).toBe(false);
    expect(screen.getByText('只能用字母、数字、_、-，层级之间用点号分隔（例如 input.text）')).toBeInTheDocument();
    expect(screen.queryByText('请求体路径要填，例如 size')).not.toBeInTheDocument();
  });

  it('提交路径带域名时说明相对路径规则，而不是提示「要填」', () => {
    const fetchMock = renderEditor();
    fillBasics();
    fireEvent.change(screen.getByLabelText('提交路径'), { target: { value: 'example.com/v1' } });

    save();

    expect(hasPost(fetchMock)).toBe(false);
    expect(screen.getByText('提交路径要是相对路径：以 / 开头，不能带域名或 ..')).toBeInTheDocument();
  });

  it('素材位字段位置超长时说明长度上限', () => {
    const fetchMock = renderEditor();
    fillBasics();
    fireEvent.click(screen.getByRole('button', { name: '添加素材位' }));
    fireEvent.change(screen.getByLabelText('第 1 行素材位字段位置'), {
      target: { value: 'a'.repeat(201) },
    });
    fireEvent.change(screen.getByLabelText('第 1 行素材位名称'), { target: { value: '参考图' } });

    save();

    expect(hasPost(fetchMock)).toBe(false);
    expect(screen.getByText('字段位置太长了（最多 200 字）')).toBeInTheDocument();
  });

  it('参数换发送位置后清空旧值并提示，键名随位置变化', () => {
    renderEditor();
    addParam();
    fireEvent.change(screen.getByLabelText('第 1 行参数请求体路径'), { target: { value: 'size' } });

    chooseOption('第 1 行参数发送位置', '查询参数');

    expect(screen.getByLabelText('第 1 行参数查询参数名')).toHaveValue('');
    expect(
      screen.getByText('发送位置变了，原来的位置已清空，请按新的位置重新填'),
    ).toBeInTheDocument();
  });

  it('请求体切到纯文本时提示词自动改成纯文本正文，并隐藏位置输入', () => {
    renderEditor();

    chooseOption('请求体', '纯文本');

    expect(screen.getByRole('combobox', { name: '提示词发送到' })).toHaveTextContent('纯文本正文');
    expect(screen.queryByLabelText('提示词位置')).not.toBeInTheDocument();
    expect(screen.getByText('整个请求体就是提示词，不再单独填位置。')).toBeInTheDocument();
  });

  it('表单形态显示两套写法下拉；鉴权切到查询参数后只显示查询参数名', () => {
    renderEditor();

    chooseOption('请求体', '表单（x-www-form-urlencoded）');
    expect(screen.getByRole('combobox', { name: '嵌套字段写法' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: '数组写法' })).toBeInTheDocument();

    chooseOption('鉴权方式', 'API Key 查询参数');
    expect(screen.getByLabelText('鉴权查询参数名')).toBeInTheDocument();
    expect(screen.queryByLabelText('鉴权头名')).not.toBeInTheDocument();
  });

  it('固定请求头填禁止头时立刻在行内提示', () => {
    renderEditor();
    fireEvent.click(screen.getByRole('button', { name: '添加固定请求头' }));
    fireEvent.change(screen.getByLabelText('第 1 行固定请求头名称'), {
      target: { value: 'Content-Type' },
    });

    expect(
      screen.getByText('这个请求头会在发送时自动写入，不能在这里固定；换一个请求头名'),
    ).toBeInTheDocument();
  });

  it('固定查询参数与请求头各自写进草稿', async () => {
    const fetchMock = renderEditor();
    fillBasics();
    fireEvent.click(screen.getByRole('button', { name: '添加固定请求头' }));
    fireEvent.change(screen.getByLabelText('第 1 行固定请求头名称'), { target: { value: 'X-Client' } });
    fireEvent.change(screen.getByLabelText('第 1 行固定请求头取值'), { target: { value: 'hub' } });
    fireEvent.click(screen.getByRole('button', { name: '添加固定查询参数' }));
    fireEvent.change(screen.getByLabelText('第 1 行固定查询参数名称'), { target: { value: 'api-version' } });
    fireEvent.change(screen.getByLabelText('第 1 行固定查询参数取值'), { target: { value: '2026-01-01' } });

    save();

    await waitFor(() => expect(hasPost(fetchMock)).toBe(true));
    expect(postBody(fetchMock).submit).toMatchObject({
      headers: [{ name: 'X-Client', value: 'hub' }],
      query: [{ name: 'api-version', value: '2026-01-01' }],
    });
  });

  it('模型 ID 选地址路径时隐藏名称输入并提示提交路径要含 {model}；选查询参数时显示名称输入', () => {
    renderEditor();

    chooseOption('模型 ID 发送到', '地址路径（{model}）');
    expect(screen.queryByLabelText('模型 ID 位置')).not.toBeInTheDocument();
    expect(screen.getByText('提交路径里要包含 {model}，发送时换成实际模型 ID。')).toBeInTheDocument();

    chooseOption('模型 ID 发送到', '查询参数');
    expect(screen.getByLabelText('模型 ID 查询参数名')).toBeInTheDocument();
  });

  it('POST 轮询才显示请求体与形态；GET 时不渲染，切到 POST 后出现', () => {
    renderEditor();
    chooseOption('任务模式', '先返回任务，稍后再取');

    expect(screen.queryByLabelText('轮询请求体')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '添加固定请求头' })).toBeInTheDocument();

    chooseOption('轮询方法', 'POST');

    expect(screen.getByLabelText('轮询请求体')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: '轮询请求体形态' })).toBeInTheDocument();
    expect(screen.getByLabelText('轮询 Content-Type')).toBeInTheDocument();
  });

  it('编辑态素材位载体判不出来时显示占位；保存被拦住，选了上传方式后才提交', async () => {
    const fetchMock = renderEditEditor(editDetail({
      mediaSlots: [{
        slot_id: 'reference_image',
        field_key: 'image',
        required: false,
        max_files: 1,
        carrier: null,
      }],
    }));

    const carrierSelect = screen.getByRole('combobox', { name: '第 1 行素材位上传方式' });
    expect(carrierSelect).toHaveTextContent('请选择上传方式');

    save();

    expect(hasPost(fetchMock)).toBe(false);
    expect(screen.getByRole('alert')).toHaveTextContent('请选择上传方式');
    expect(document.activeElement).toBe(carrierSelect);

    chooseOption('第 1 行素材位上传方式', '公网 URL');
    save();

    await waitFor(() => expect(hasPut(fetchMock)).toBe(true));
    expect(putBody(fetchMock).media_slots).toEqual([
      {
        slot_id: 'reference_image',
        field_key: 'image',
        label: '参考图',
        required: false,
        max_files: 1,
        carrier: 'public_url',
      },
    ]);
  });
});

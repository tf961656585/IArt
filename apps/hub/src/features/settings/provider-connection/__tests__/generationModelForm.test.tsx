import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type {
  FamilyTemplateParameterDescriptor,
  GenerationMediaSlotId,
} from '@iart/contracts';

import {
  GenerationModelFields,
  useGenerationModelForm,
  type GenerationModelFormPayload,
} from '../GenerationModelForm';
import { PRESET_FORMAT_OPTIONS } from './formatOptionsFixture';

/**
 * 自建生成模型的表单体（docs/custom-providers/生成模型自建声明试点-design.md §3.7）。
 *
 * 2026-09-26 界面收敛后它是合并弹窗（AddModelDialog）的「自定义接口的模型」区块：
 * 状态与提交逻辑在 `useGenerationModelForm`（挂在弹窗壳层，footer 按钮才拿得到可提交性），
 * 字段树在 `GenerationModelFields`。这里的 Harness 按合并弹窗的真实接线组装两者，
 * 底部按钮与弹窗 footer 同构（disabled = busy 或不可提交）。
 *
 * 2026-10-19 起素材位改为**按所选接口格式的族能力逐项勾选**（能力来自族模板描述符的
 * `supports_media_slots`），本文件保护：
 * - 接口格式空态起步、必选（2026-09-29 起连接级预选摘除）；模型 ID 必填、格式非法即拦；
 * - 只呈现该族支持的素材位（OpenAI / Gemini 一位、Seedance 五位），0 位族不渲染素材区块；
 * - 换接口格式时旧勾选被清空并给出可见反馈（不静默清空）；
 * - 协议必填位（可灵图生视频的首帧）进入界面即已勾且不可取消，且必随提交体交回；
 * - 族能力还没读到时不放行提交（否则会落一条素材位未知的记录）；
 * - 没动「高级参数自定义」时提交 parameterOverrides 为 null；失败原因显示在表单底部。
 */

/** 各族的素材位能力（与注册表 `supportsMediaSlots` 同值；测试夹具按族给）。 */
const SUPPORTED_SLOTS: Record<string, GenerationMediaSlotId[]> = {
  'openai-image-v1': ['reference_image'],
  'gemini-image-interactions-v1': ['reference_image'],
  'seedance-2-0-v1': ['first_frame', 'last_frame', 'reference_image', 'reference_video', 'reference_audio'],
  'veo-v1': ['first_frame', 'last_frame'],
  'kling-text2video-v1': [],
  'kling-image2video-v1': ['first_frame', 'last_frame'],
  'kling-omni-video-v1': ['first_frame', 'last_frame', 'reference_image', 'feature_video', 'base_video'],
};

/**
 * 各族的「协议必选素材位」：由契约随描述符下发（唯一来源是 Runtime Backend 族注册表）。
 *
 * 测试在这里复刻一份是为了喂假描述符，不是第二处事实源——它不同步于产品行为，只表达
 * 「可灵图生视频的端点每次提交都必须带首帧」这一条的界面后果。
 */
const REQUIRED_SLOTS: Readonly<Partial<Record<string, GenerationMediaSlotId[]>>> = {
  'kling-image2video-v1': ['first_frame'],
};

/** 描述符的最小合法形状：素材位能力是本案的被测面，官方参数区与保留键给空。 */
const descriptorFor = (familyAdapterId: string): FamilyTemplateParameterDescriptor => ({
  family_adapter_id: familyAdapterId,
  official_fields: [],
  reserved_wire_names: { body: [], query: [], header: [] },
  supports_media_slots: SUPPORTED_SLOTS[familyAdapterId] ?? [],
  required_media_slots: [...(REQUIRED_SLOTS[familyAdapterId] ?? [])],
});

const Harness = ({
  onSubmit,
  onClose,
  loadParameterTemplate,
  failureText = null,
}: {
  onSubmit: (payload: GenerationModelFormPayload) => Promise<boolean>;
  onClose: () => void;
  loadParameterTemplate: (familyAdapterId: string) => Promise<FamilyTemplateParameterDescriptor>;
  failureText?: string | null;
}) => {
  const form = useGenerationModelForm({
    loadParameterTemplate,
    recipes: [],
    formatOptions: PRESET_FORMAT_OPTIONS,
    onSubmit,
    onClose,
  });
  return (
    <>
      <GenerationModelFields form={form} />
      {failureText === null ? null : <p role="alert" className="text-2xs text-destructive">{failureText}</p>}
      <button type="button" disabled={form.busy || !form.canSubmit} onClick={form.submit}>
        添加
      </button>
    </>
  );
};

const renderForm = (
  overrides: {
    failureText?: string | null;
    onClose?: () => void;
    onSubmit?: (payload: GenerationModelFormPayload) => Promise<boolean>;
    loadParameterTemplate?: (familyAdapterId: string) => Promise<FamilyTemplateParameterDescriptor>;
  } = {},
) => {
  const onSubmit = overrides.onSubmit ?? vi.fn(async () => true);
  const loadParameterTemplate =
    overrides.loadParameterTemplate ?? ((familyAdapterId: string) => Promise.resolve(descriptorFor(familyAdapterId)));
  const view = render(
    <Harness
      loadParameterTemplate={loadParameterTemplate}
      failureText={overrides.failureText ?? null}
      onClose={overrides.onClose ?? (() => undefined)}
      onSubmit={onSubmit}
    />,
  );
  return { onSubmit, loadParameterTemplate, unmount: view.unmount };
};

/** 打开「接口格式」下拉并选中一个选项（jsdom 无 PointerEvent：键盘开下拉，click 选中）。 */
const chooseAdapter = (displayName: string): void => {
  fireEvent.keyDown(screen.getByLabelText('接口格式'), { key: 'Enter' });
  fireEvent.click(screen.getByRole('option', { name: displayName }));
};

/** 素材位勾选框名称（与界面文案同一套业务词）。 */
const slotCheckbox = (label: string) => screen.getByRole('checkbox', { name: label });

describe('GenerationModelForm（添加）', () => {
  it('接口格式空态起步且必填：填了模型 ID 没选接口格式仍不能提交', () => {
    renderForm();

    fireEvent.change(screen.getByLabelText('模型 ID'), { target: { value: 'my-image-model' } });
    expect(screen.getByRole('button', { name: '添加' })).toBeDisabled();
    expect(screen.getByLabelText('接口格式')).toHaveTextContent('请选择接口格式');
  });

  it('选 OpenAI 图像：只出现「参考图」一项，勾选随提交体交回', async () => {
    const { onSubmit } = renderForm();

    fireEvent.change(screen.getByLabelText('模型 ID'), { target: { value: 'my-image-model' } });
    fireEvent.change(screen.getByLabelText('服务商那边的模型 ID'), { target: { value: 'remote-name' } });
    chooseAdapter('OpenAI Image');

    // 该族只能表达参考图：其余素材位不出现（不呈现「能选但一提交就失败」的入口）
    await waitFor(() => {
      expect(slotCheckbox('参考图')).toBeInTheDocument();
    });
    expect(screen.getAllByRole('checkbox')).toHaveLength(1);
    expect(screen.queryByRole('checkbox', { name: '首帧' })).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: '参考视频' })).not.toBeInTheDocument();

    fireEvent.click(slotCheckbox('参考图'));
    fireEvent.click(screen.getByRole('button', { name: '添加' }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith({
        familyAdapterId: 'openai-image-v1',
        modelId: 'my-image-model',
        remoteModelId: 'remote-name',
        acceptedMediaSlots: ['reference_image'],
        parameterOverrides: null,
        recipeId: null,
      });
    });
  });

  it('选 Seedance：五个素材位都能勾，随提交体交回；默认都不勾（除协议必填位）', async () => {
    const { onSubmit } = renderForm();

    fireEvent.change(screen.getByLabelText('模型 ID'), { target: { value: 'my-video-model' } });
    chooseAdapter('Seedance 2.0');

    await waitFor(() => {
      expect(slotCheckbox('首帧')).toBeInTheDocument();
    });
    const labels = screen.getAllByRole('checkbox').map((element) => element.getAttribute('aria-label'));
    expect(labels).toEqual(['首帧', '尾帧', '参考图', '参考视频', '参考音频']);
    // Seedance 的首帧不是协议必填位：默认不勾
    expect(slotCheckbox('首帧')).not.toBeChecked();

    fireEvent.click(slotCheckbox('首帧'));
    fireEvent.click(slotCheckbox('参考视频'));
    fireEvent.click(screen.getByRole('button', { name: '添加' }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith({
        familyAdapterId: 'seedance-2-0-v1',
        modelId: 'my-video-model',
        remoteModelId: null,
        acceptedMediaSlots: ['first_frame', 'reference_video'],
        parameterOverrides: null,
        recipeId: null,
      });
    });
  });

  it('选 Kling 文生视频：这个族没有任何素材位，不渲染素材区块（不是空框）', async () => {
    const { onSubmit } = renderForm();

    fireEvent.change(screen.getByLabelText('模型 ID'), { target: { value: 'my-t2v-model' } });
    chooseAdapter('Kling 文生视频');

    // 素材区块加载完成后仍然没有勾选框，也没有区块标题
    await waitFor(() => {
      expect(screen.queryByText('正在读取这个接口格式能用的素材…')).not.toBeInTheDocument();
    });
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    expect(screen.queryByText('这个模型接受的素材')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '添加' }));
    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith({
        familyAdapterId: 'kling-text2video-v1',
        modelId: 'my-t2v-model',
        remoteModelId: null,
        acceptedMediaSlots: [],
        parameterOverrides: null,
        recipeId: null,
      });
    });
  });

  it('换接口格式：旧勾选被清空，并给出可见反馈（不静默清空）', async () => {
    renderForm();

    fireEvent.change(screen.getByLabelText('模型 ID'), { target: { value: 'my-model' } });
    chooseAdapter('OpenAI Image');
    await waitFor(() => {
      expect(slotCheckbox('参考图')).toBeInTheDocument();
    });
    fireEvent.click(slotCheckbox('参考图'));
    expect(slotCheckbox('参考图')).toBeChecked();

    // 换成可灵图生视频（只支持首帧/尾帧，不含参考图）：参考图这一位在新族根本不存在
    chooseAdapter('Kling 图生视频');
    await waitFor(() => {
      expect(slotCheckbox('尾帧')).toBeInTheDocument();
    });

    expect(screen.queryByRole('checkbox', { name: '参考图' })).not.toBeInTheDocument();
    expect(slotCheckbox('尾帧')).not.toBeChecked();
    // 反馈点名换成了哪个接口格式，并说清旧勾选已清掉
    expect(screen.getByText('已换成「Kling 图生视频」，之前勾的素材都清掉了。')).toBeInTheDocument();
  });

  it('可灵图生视频的首帧是协议必填位：进入即已勾且不能取消，必随提交体交回', async () => {
    const { onSubmit } = renderForm();

    fireEvent.change(screen.getByLabelText('模型 ID'), { target: { value: 'my-i2v-model' } });
    chooseAdapter('Kling 图生视频');

    await waitFor(() => {
      expect(slotCheckbox('首帧')).toBeInTheDocument();
    });
    // 不勾首帧就会造出一个永远生成不成功的模型：界面直接替用户勾上并锁住
    expect(slotCheckbox('首帧')).toBeChecked();
    expect(slotCheckbox('首帧')).toBeDisabled();

    fireEvent.click(slotCheckbox('首帧'));
    expect(slotCheckbox('首帧')).toBeChecked();

    fireEvent.click(screen.getByRole('button', { name: '添加' }));
    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith({
        familyAdapterId: 'kling-image2video-v1',
        modelId: 'my-i2v-model',
        remoteModelId: null,
        acceptedMediaSlots: ['first_frame'],
        parameterOverrides: null,
        recipeId: null,
      });
    });
  });

  it('读不到族能力时：给一行原因且不放行提交（不猜素材位）', async () => {
    const { onSubmit } = renderForm({
      loadParameterTemplate: () => Promise.reject(new Error('boom')),
    });

    fireEvent.change(screen.getByLabelText('模型 ID'), { target: { value: 'my-model' } });
    chooseAdapter('OpenAI Image');

    await waitFor(() => {
      expect(
        screen.getByText('暂时读不到这个接口格式能用的素材。关掉这个窗口后点「刷新」再试。'),
      ).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: '添加' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '添加' }));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('模型 ID 格式非法时拦下：失焦即显示格式文案，提交不发请求；改一个字符即撤掉提示', async () => {
    const { onSubmit } = renderForm();

    const input = screen.getByLabelText('模型 ID');
    fireEvent.change(input, { target: { value: 'my image!' } });
    fireEvent.blur(input);
    expect(screen.getByRole('alert')).toHaveTextContent(
      '模型 ID 只能用字母、数字、.、_、-，且以字母或数字开头',
    );

    chooseAdapter('OpenAI Image');
    await waitFor(() => {
      expect(slotCheckbox('参考图')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: '添加' }));
    expect(onSubmit).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: 'my-image' } });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('提交失败时返回 false 不关弹层，输入不丢', async () => {
    const onClose = vi.fn();
    const { onSubmit } = renderForm({ onClose, onSubmit: vi.fn(async () => false) });

    fireEvent.change(screen.getByLabelText('模型 ID'), { target: { value: 'my-image-model' } });
    chooseAdapter('OpenAI Image');
    await waitFor(() => {
      expect(slotCheckbox('参考图')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: '添加' }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalled();
    });
    expect(onClose).not.toHaveBeenCalled();
    expect((screen.getByLabelText('模型 ID') as HTMLInputElement).value).toBe('my-image-model');
  });

  it('失败原因显示在表单底部（顶部提示条被遮罩挡住），没有失败就不占位', () => {
    const { unmount } = renderForm();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    unmount();

    // 后端确定性拒绝的可操作原因由调用方原样透传进来，弹层只负责显示
    renderForm({ failureText: '「my-image-model」已经添加到这个服务商了。' });
    expect(screen.getByRole('alert')).toHaveTextContent('「my-image-model」已经添加到这个服务商了。');
  });

  it('尚未选择接口格式时展开高级区不拉参数描述；选好后再展开按所选接口格式拉取', async () => {
    const loadParameterTemplate = vi.fn<(familyAdapterId: string) => Promise<FamilyTemplateParameterDescriptor>>(
      (familyAdapterId: string) => Promise.resolve(descriptorFor(familyAdapterId)),
    );
    renderForm({ loadParameterTemplate });

    // 接口格式未选：展开高级区不发起装载，折叠区按「先选接口格式」指引呈现
    fireEvent.click(screen.getByRole('button', { name: '高级参数自定义' }));
    await waitFor(() => {
      expect(screen.getByText('先选好接口格式，再看能调哪些参数。')).toBeInTheDocument();
    });
    expect(loadParameterTemplate).not.toHaveBeenCalled();

    // 选好接口格式：收起再展开，按所选接口格式拉取
    fireEvent.click(screen.getByRole('button', { name: '高级参数自定义' }));
    chooseAdapter('OpenAI Image');
    await waitFor(() => {
      expect(slotCheckbox('参考图')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: '高级参数自定义' }));
    // 素材位装载已按所选接口格式拉过一次（高级区复用同一份描述符装载）
    await waitFor(() => {
      expect(loadParameterTemplate).toHaveBeenCalledWith('openai-image-v1');
    });
  });
});

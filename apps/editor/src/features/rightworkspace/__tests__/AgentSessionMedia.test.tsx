import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { toast } from 'sonner';

import type { AgentMessageRecord } from '@iart/contracts';
import { ensureAgentMessagesLoaded } from '@/features/agent/agentSessionStore';
import type * as AgentSessionStoreModule from '@/features/agent/agentSessionStore';
import { addNodesToReferences } from '@/features/promptdock/referenceOps';
import type * as ReferenceOpsModule from '@/features/promptdock/referenceOps';
import { usePromptDockStore } from '@/features/promptdock/promptDockStore';
import { useCanvasStore } from '@/features/canvas/store/canvasStore';
import { AgentSessionView } from '../components/AgentSessionView';
import { seed, seedCanvas, sessionRecord, toolResultMessage } from './agentSessionViewFixtures';

/**
 * 会话视图「媒体统一件」（spec docs/agent/02「会话视图与多轮历史」、06「附件与多模态」；
 * 参考区按素材 ID 兜底入口见 docs/agent/04 · AG-EX-002）。
 *
 * 保护：媒体格按资产真实宽高比撑开（比例来自 original.width/height，不裁切）；视频海报帧只认
 * ready 缩略图（未 ready 走类型占位，绝不把视频文件塞给 img）；音频条可播放、时长未知显示
 * 「--:--」、seek 控件键盘可达；产物未就绪时占位呈现且不给预览与「用作参考」出口；
 * 预览与「用作参考」走既有预览浮层与 referenceOps 唯一入口。
 * 「用作参考」按**素材 ID** 直加（不要求画布上存在持有该产物的节点——存量会话产物只有资产
 * 记录、没有节点）；准入不过时给可见提示（不再静默丢弃）。
 * 承载宿主是**条目卡组**的工具条目卡（含媒体带）——图片生成结果已改走相册形态
 * （spec 02「连续生成相册」：一次调用一格的方格 cover，另有专门用例），这里的载体换成
 * 非相册形态的图片加工工具，媒体统一件本身的口径不变。
 */

/** 非相册形态的图片加工结果（媒体带宿主；相册只聚合同名图片生成工具的调用序列）。 */
const cropResultMessage: AgentMessageRecord = {
  ...toolResultMessage,
  body: {
    kind: 'tool_result',
    toolCallId: 'call_1',
    toolName: 'crop_image',
    status: 'succeeded',
    summary: '已裁剪出 1 张图片',
    assetIds: ['asset_1'],
    errorSummary: null,
  },
};

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));

vi.mock('@/features/agent/agentSessionStore', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentSessionStoreModule>();
  return { ...actual, ensureAgentMessagesLoaded: vi.fn(async () => {}) };
});

// referenceOps 只替换节点路径入口：按素材 ID 直加走真实实现（断言它真的把引用写进草稿）。
vi.mock('@/features/promptdock/referenceOps', async (importOriginal) => {
  const actual = await importOriginal<typeof ReferenceOpsModule>();
  return {
    ...actual,
    addNodesToReferences: vi.fn(() => ({ added: [], alreadyInRefs: [], rejected: [] })),
  };
});

beforeEach(() => {
  cleanup();
  vi.mocked(ensureAgentMessagesLoaded).mockClear();
  vi.mocked(addNodesToReferences).mockClear();
  vi.mocked(toast.warning).mockClear();
  usePromptDockStore.setState({
    draft: { ...usePromptDockStore.getState().draft, references: [] },
  });
  seedCanvas();
});

afterEach(() => {
  vi.restoreAllMocks();
  useCanvasStore.setState({ mediaAssets: {}, nodeGraph: null });
});

/** 参考区当前持有的素材 id（草稿是参考区唯一事实源）。 */
const referenceAssetIds = (): string[] =>
  usePromptDockStore.getState().draft.references.map((ref) => ref.assetId);

describe('会话视图媒体统一件', () => {
  it('产物缩略图是按钮：点击打开资产预览（spec 02「可预览」）', async () => {
    seed({ session: sessionRecord(), messages: [cropResultMessage] });
    seedCanvas({ withAsset: true, withNode: true });
    render(<AgentSessionView agentSessionId="sess_1" />);

    const trigger = screen.getByRole('button', { name: '预览 柴犬雨中.png' });
    expect(trigger).toBeInTheDocument();
    fireEvent.click(trigger);

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it('产物缩略图 hover 层「用作参考」按素材 ID 直加（不建第二引用入口；有持有节点时标签沿用节点标签）', () => {
    seed({ session: sessionRecord(), messages: [cropResultMessage] });
    seedCanvas({ withAsset: true, withNode: true });
    render(<AgentSessionView agentSessionId="sess_1" />);

    const refButton = screen.getByRole('button', { name: '将「柴犬雨中.png」用作参考' });
    fireEvent.click(refButton);

    // 真实写入参考区（不是「调了某个函数」）：assetId 直加，节点路径入口不被绕回调用。
    expect(referenceAssetIds()).toEqual(['asset_1']);
    expect(usePromptDockStore.getState().draft.references[0]?.label).toBe('柴犬雨中.png');
    expect(vi.mocked(addNodesToReferences)).not.toHaveBeenCalled();
  });

  // @spec: AG-EX-002
  it('画布上没有持有该产物的节点（存量会话产物）：「用作参考」仍可达，按素材 ID 加入参考区', () => {
    seed({ session: sessionRecord(), messages: [cropResultMessage] });
    // 资产记录在（产物可用），画布上没有任何持有它的节点——存量历史产物不补落节点的形态。
    seedCanvas({ withAsset: true, withNode: false });
    render(<AgentSessionView agentSessionId="sess_1" />);

    const refButton = screen.getByTestId('agent-asset-use-as-reference');
    fireEvent.click(refButton);

    expect(referenceAssetIds()).toEqual(['asset_1']);
    // 没有节点标签可取时退回 assetId（仅呈现口径，不影响引用本身）
    expect(usePromptDockStore.getState().draft.references[0]?.label).toBe('asset_1');
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it('视频产物用作参考：按素材 ID 直加成功（准入按当前模型能力判定，不再按媒体类型拒绝）', () => {
    const videoResultMessage: AgentMessageRecord = {
      ...cropResultMessage,
      body: {
        kind: 'tool_result',
        toolCallId: 'call_video',
        toolName: 'generate_video',
        status: 'succeeded',
        summary: '已生成 1 段视频',
        assetIds: ['asset_video'],
        errorSummary: null,
      },
    };
    seed({ session: sessionRecord(), messages: [videoResultMessage] });
    seedCanvas({ withVideoAsset: true, withVideoNode: true });
    render(<AgentSessionView agentSessionId="sess_1" />);

    fireEvent.click(screen.getByTestId('agent-asset-use-as-reference'));

    expect(referenceAssetIds()).toEqual(['asset_video']);
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it('注册表无资产条目时按产物未就绪占位（非按钮、不显示破图），无「用作参考」出口（产物未就绪档）', () => {
    seed({ session: sessionRecord(), messages: [cropResultMessage] });
    seedCanvas();
    render(<AgentSessionView agentSessionId="sess_1" />);

    const box = screen.getByTestId('agent-media-box');
    expect(box).toHaveAttribute('data-state', 'unsettled');
    expect(box).toHaveTextContent('产物未就绪');
    expect(screen.queryByRole('button', { name: /预览/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '将「柴犬雨中.png」用作参考' })).not.toBeInTheDocument();
  });

  it('产物媒体格按资产真实宽高比撑开，单产物卡宽随比例收窄（比例真实、无裁切）', () => {
    seed({ session: sessionRecord(), messages: [cropResultMessage] });
    seedCanvas({ withAsset: true, withNode: true });
    render(<AgentSessionView agentSessionId="sess_1" />);

    // 画布资产 800×600 → 宽高比 1.3333（来自 original.width/height，同步可得，不靠 DOM 探测）。
    const box = screen.getByTestId('agent-media-box');
    expect(box).toHaveAttribute('data-media-kind', 'image');
    expect((box as HTMLElement).style.aspectRatio).toBe('1.3333');
    // 单产物独占：条目卡宽 = min(100%, 240 × 比例)。
    expect((screen.getByTestId('agent-session-tool-result') as HTMLElement).style.maxWidth).toBe(
      'min(100%, 320px)',
    );
  });

  it('视频产物：缩略图未 ready 时走类型占位 + 播放钮，绝不把视频文件塞给 img', () => {
    const videoResultMessage: AgentMessageRecord = {
      ...toolResultMessage,
      body: {
        kind: 'tool_result',
        toolCallId: 'call_video',
        toolName: 'generate_video',
        status: 'succeeded',
        summary: '已生成 1 段视频',
        assetIds: ['asset_video'],
        errorSummary: null,
      },
    };
    seed({ session: sessionRecord(), messages: [videoResultMessage] });
    seedCanvas({ withVideoAsset: true, withVideoNode: true });
    render(<AgentSessionView agentSessionId="sess_1" />);

    const box = screen.getByTestId('agent-media-box');
    expect(box).toHaveAttribute('data-media-kind', 'video');
    // 海报帧只认 ready 缩略图：未 ready 时没有面（图/视频元素都不渲染，更不把视频文件塞给 img）。
    expect(box.querySelector('img')).toBeNull();
    expect(box.querySelector('video')).toBeNull();
    // 时长角标走共享时长口径（4200ms → 0:04）；播放钮仍在（点击开预览播放）。
    expect(screen.getByTestId('agent-media-video-duration')).toHaveTextContent('0:04');
    expect(screen.getByRole('button', { name: '播放 雨中等车.mp4' })).toBeInTheDocument();
  });

  it('音频产物：音频条可播放、时长未知显示 --:--、seek 控件键盘可达', () => {
    const playSpy = vi
      .spyOn(HTMLMediaElement.prototype, 'play')
      .mockImplementation(() => Promise.resolve());
    const audioResultMessage: AgentMessageRecord = {
      ...toolResultMessage,
      body: {
        kind: 'tool_result',
        toolCallId: 'call_audio',
        toolName: 'generate_video',
        status: 'succeeded',
        summary: '已生成 1 段音频',
        assetIds: ['asset_audio'],
        errorSummary: null,
      },
    };
    seed({ session: sessionRecord(), messages: [audioResultMessage] });
    seedCanvas({ withAudioAsset: true, withAudioNode: true });
    render(<AgentSessionView agentSessionId="sess_1" />);

    // 未知时长档：显示「--:--」，不臆造时长。
    expect(screen.getByTestId('agent-media-audio-duration')).toHaveTextContent('--:--');
    const seek = screen.getByTestId('agent-media-audio-seek');
    expect(seek).toHaveAttribute('type', 'range');
    expect(seek).toHaveAttribute('min', '0');
    expect(seek).toHaveAttribute('max', '1000');
    expect(seek).not.toBeDisabled();

    fireEvent.click(screen.getByTestId('agent-media-audio-play'));
    expect(playSpy).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('agent-media-audio-play')).toHaveAttribute('aria-pressed', 'true');

    // seek 命中区（原生 range）可拖动/键盘调整：进度前沿随值更新。
    fireEvent.change(seek, { target: { value: '500' } });
    expect((seek as HTMLInputElement).value).toBe('500');
    // 预览出口走既有预览浮层（那里有原生 audio controls）。
    expect(screen.getByRole('button', { name: '预览 旁白.mp3' })).toBeInTheDocument();
  });

  it('用户消息内的媒体 part 与产物媒体共用同一套呈现（图走媒体格 + 预览，音频走音频条）', () => {
    const mediaMessage: AgentMessageRecord = {
      agentSessionId: 'sess_1',
      seq: 1,
      role: 'user',
      requestId: 'req_1',
      body: {
        kind: 'chat',
        content: [
          { type: 'image', url: 'local-media://project/attach.png' },
          { type: 'audio', url: 'local-media://project/attach.mp3' },
        ],
      },
      plan: null,
      createdAt: 1_770_000_000_000,
      isPartial: false,
    };
    seed({ session: sessionRecord(), messages: [mediaMessage] });
    render(<AgentSessionView agentSessionId="sess_1" />);

    // 图片：媒体格 + 预览触发器（无画布资产语义，故不出现「用作参考」）。
    expect(screen.getByTestId('agent-media-box')).toHaveAttribute('data-media-kind', 'image');
    // 比例未知时的类型缺省档（图 3/2）——真实比例由加载探针回填。
    expect((screen.getByTestId('agent-media-box') as HTMLElement).style.aspectRatio).toBe('1.5');
    expect(screen.getByRole('button', { name: '预览 图片' })).toBeInTheDocument();
    expect(screen.queryByTestId('agent-asset-use-as-reference')).not.toBeInTheDocument();
    // 音频：音频条（时长未知 → --:--）。
    expect(screen.getByTestId('agent-media-audio')).toHaveAttribute('data-state', 'ready');
    expect(screen.getByTestId('agent-media-audio-duration')).toHaveTextContent('--:--');
  });

  it('正文内图片：渲染成可聚焦的预览触发器（点击 / 键盘都能开预览），block 满宽 + max-h-320 + contain', () => {
    const markdownMessage: AgentMessageRecord = {
      ...toolResultMessage,
      seq: 1,
      role: 'assistant',
      // 正文内图片走 streamdown 默认 sanitize 档（img.src 只放行 http/https/data），故用远端地址。
      body: { kind: 'chat', content: '参考这张：\n\n![参考图](https://example.com/inline.png)' },
    };
    seed({ session: sessionRecord(), messages: [markdownMessage] });
    render(<AgentSessionView agentSessionId="sess_1" />);

    const trigger = screen.getByRole('button', { name: '预览 参考图' });
    const image = trigger.querySelector('img');
    expect(image).not.toBeNull();
    expect(image?.className).toContain('max-h-80');
    expect(image?.className).toContain('object-contain');
    expect(image?.className).toContain('w-full');
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';

import type { AgentMessageRecord } from '@iart/contracts';
import { ensureAgentMessagesLoaded } from '@/features/agent/agentSessionStore';
import type * as AgentSessionStoreModule from '@/features/agent/agentSessionStore';
import { agentSocket } from '@/features/agent/agentSocket';
import { addNodesToReferences } from '@/features/promptdock/referenceOps';
import type * as ReferenceOpsModule from '@/features/promptdock/referenceOps';
import { usePromptDockStore } from '@/features/promptdock/promptDockStore';
import { useCanvasStore } from '@/features/canvas/store/canvasStore';
import { createTestNodeGraph } from '@/features/canvas/components/__tests__/fixtures/canvasTestBuilders';
import { AgentSessionView } from '../components/AgentSessionView';
import {
  assistantMessage,
  generateImageCall,
  generateImageResult,
  imageAsset,
  seed,
  seedImageAssets,
  sessionRecord,
  toolCallLive,
} from './agentSessionViewFixtures';

/**
 * 连续生成相册（spec docs/agent/02「会话视图与多轮历史」2026-09-21 裁决，原型
 * prototypes/agent-session-media-album/ 为形态对照）。
 *
 * 保护：连续同名图片生成调用聚合成一个相册组（中间插入其他条目即断组）；组头「N 次调用 ·
 * M 张图」双计数 + 状态 fragments；**诚实判定**（全组 distinct prompt = 1 才给摘要，≥ 2 沉默）；
 * 待审批提案不进相册、不被聚合藏起来；prompt ↔ 图配对四层（组头 / 格信息条 + 同调用兄弟格
 * 高亮 / 预览翻页层 / 提示词明细跳转）；方格 1:1 cover 与 N=1 真实比例独立带；生成中 / 失败 /
 * 未执行状态格与失败详情；产物未就绪在格内占位且不给预览出口。
 */

vi.mock('@/features/agent/agentSessionStore', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentSessionStoreModule>();
  return { ...actual, ensureAgentMessagesLoaded: vi.fn(async () => {}) };
});

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
  // 参考区事实源（草稿）在每个用例前清空：断言「加入参考区」看的就是它。
  usePromptDockStore.setState({
    draft: { ...usePromptDockStore.getState().draft, references: [] },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  useCanvasStore.setState({ mediaAssets: {}, nodeGraph: null });
});

/** 相册格的查询顺序即为填充顺序（调用次序，同调用多图天然相邻）。 */
const albumCells = (): HTMLElement[] => screen.queryAllByTestId('agent-album-cell');
const stateCells = (): HTMLElement[] => screen.queryAllByTestId('agent-album-cell-state');

/** 两格调用（第一次 1 张、第二次 2 张），用于网格 / 翻页 / 明细 / 配对相关用例。 */
const seedTwoCalls = (): void => {
  seed({
    session: sessionRecord(),
    messages: [
      generateImageCall({ toolCallId: 'call_1', seq: 11, prompt: '霓虹街巷全景' }),
      generateImageResult({ toolCallId: 'call_1', seq: 12, assetIds: ['a1'] }),
      generateImageCall({ toolCallId: 'call_2', seq: 13, prompt: '雨夜路面倒影' }),
      generateImageResult({ toolCallId: 'call_2', seq: 14, assetIds: ['a2', 'a3'] }),
    ],
  });
  seedImageAssets(['a1', 'a2', 'a3']);
};

describe('连续生成相册', () => {
  it('聚合：连续同名图片生成调用收进一个相册组，组头给「N 次调用 · M 张图」双计数', () => {
    seedTwoCalls();
    render(<AgentSessionView agentSessionId="sess_1" />);

    const group = screen.getByTestId('agent-session-tool-group');
    expect(group).toHaveAttribute('data-album', 'true');
    expect(group).toHaveAttribute('data-collapsed', 'false');
    expect(screen.getByTestId('agent-album-counts')).toHaveTextContent('2 次调用 · 3 张图');
    expect(screen.getAllByTestId('agent-album-grid')).toHaveLength(1);
    expect(albumCells()).toHaveLength(3);
    // 自适应方格（任何面板宽度档不退化单列）与 6px 间距。
    const grid = screen.getByTestId('agent-album-grid');
    expect(grid.className).toContain('repeat(auto-fill,minmax(150px,1fr))');
    expect(grid.className).toContain('gap-1.5');
    // 填充顺序 = 调用次序：前两格属于第二次调用（同调用多图相邻），格内信息条给出调用序号 · 图序。
    const cells = albumCells();
    expect(cells[1]).toHaveAttribute('data-call-id', 'call_2');
    expect(cells[1]).toHaveTextContent('第 2 次调用 · 图 1/2');
    expect(cells[2]).toHaveTextContent('第 2 次调用 · 图 2/2');
    expect(cells[0]).toHaveTextContent('第 1 次调用');
    // 格是 1:1 cover 的缩略（构图判断移交预览层）。
    expect(cells[0]?.className).toContain('aspect-square');
    expect(cells[0]?.querySelector('img')?.className).toContain('object-cover');
  });

  it('诚实判定：全组 distinct prompt ≥ 2 时一行摘要都不显示（宁沉默不误导）', () => {
    seedTwoCalls();
    render(<AgentSessionView agentSessionId="sess_1" />);

    expect(screen.queryByTestId('agent-album-summary')).not.toBeInTheDocument();
    // 也不给「N 条提示词」这类伪摘要：组头只有工具名与双计数、状态。
    expect(screen.getByTestId('agent-session-tool-group')).not.toHaveTextContent('提示词');
  });

  it('诚实判定：全组 prompt 相同（字符串精确比较）才显示一行摘要', () => {
    seed({
      session: sessionRecord(),
      messages: [
        generateImageCall({ toolCallId: 'call_1', seq: 11, prompt: '雨夜便利店门口，暖光与冷雨对比' }),
        generateImageResult({ toolCallId: 'call_1', seq: 12, assetIds: ['a1'] }),
        generateImageCall({ toolCallId: 'call_2', seq: 13, prompt: '雨夜便利店门口，暖光与冷雨对比' }),
        generateImageResult({ toolCallId: 'call_2', seq: 14, assetIds: ['a2'] }),
      ],
    });
    seedImageAssets(['a1', 'a2']);
    render(<AgentSessionView agentSessionId="sess_1" />);

    expect(screen.getByTestId('agent-album-summary')).toHaveTextContent(
      '雨夜便利店门口，暖光与冷雨对比',
    );
    // 摘要缩到 12px 次要文字、单行截断（不抢组头信息层级）。
    const summary = screen.getByTestId('agent-album-summary');
    expect(summary.className).toContain('text-[12px]');
    expect(summary.className).toContain('truncate');
    expect(summary.className).toContain('text-muted-foreground');
  });

  it('断组：中间插入其他条目即分成两个相册组（沿用流内既有分组，不重写）', () => {
    seed({
      session: sessionRecord(),
      messages: [
        generateImageCall({ toolCallId: 'call_1', seq: 11, prompt: '第一组的一次调用' }),
        generateImageResult({ toolCallId: 'call_1', seq: 12, assetIds: ['a1', 'a2'] }),
        assistantMessage,
        generateImageCall({ toolCallId: 'call_2', seq: 13, prompt: '第二组的一次调用' }),
        generateImageResult({ toolCallId: 'call_2', seq: 14, assetIds: ['a3', 'a4'] }),
      ],
    });
    seedImageAssets(['a1', 'a2', 'a3', 'a4']);
    render(<AgentSessionView agentSessionId="sess_1" />);

    const groups = screen.getAllByTestId('agent-session-tool-group');
    expect(groups).toHaveLength(2);
    for (const group of groups) {
      expect(group).toHaveAttribute('data-album', 'true');
      expect(within(group).getByTestId('agent-album-counts')).toHaveTextContent('1 次调用 · 2 张图');
    }
    expect(screen.getAllByTestId('agent-album-grid')).toHaveLength(2);
  });

  it('待审批提案不进相册：相册只统计已调用，提案卡独立渲染且不随相册收起', () => {
    const pendingCall: AgentMessageRecord = generateImageCall({
      toolCallId: 'call_3',
      seq: 15,
      prompt: '便利店门口 · 暖光',
    });
    seed({
      session: sessionRecord(),
      messages: [
        generateImageCall({ toolCallId: 'call_1', seq: 11, prompt: '霓虹街巷全景' }),
        generateImageResult({ toolCallId: 'call_1', seq: 12, assetIds: ['a1'] }),
        generateImageCall({ toolCallId: 'call_2', seq: 13, prompt: '雨夜路面倒影' }),
        generateImageResult({ toolCallId: 'call_2', seq: 14, assetIds: ['a2'] }),
        pendingCall,
      ],
      inFlight: true,
      toolCallLive: { call_3: toolCallLive({ toolCallId: 'call_3', status: 'proposed' }) },
    });
    seedImageAssets(['a1', 'a2']);
    render(<AgentSessionView agentSessionId="sess_1" />);

    // 待审批的这次调用不进相册的计数与网格。
    expect(screen.getByTestId('agent-album-counts')).toHaveTextContent('2 次调用 · 2 张图');
    const grid = screen.getByTestId('agent-album-grid');
    expect(grid.querySelectorAll('[data-testid="agent-album-cell"]')).toHaveLength(2);

    // 提案卡按既有形态渲染在相册之外（审批行动入口立即可点）。
    const pendingBlock = screen.getByTestId('agent-album-pending');
    const proposalCard = within(pendingBlock).getByTestId('agent-session-tool-call');
    expect(proposalCard).toHaveAttribute('data-status', 'proposed');
    expect(proposalCard).toHaveTextContent('便利店门口 · 暖光');
    expect(grid).not.toContainElement(proposalCard);

    // 收起相册只收相册体：提案卡不跟着消失。
    fireEvent.click(screen.getByTestId('agent-tool-group-toggle'));
    expect(screen.queryByTestId('agent-album-body')).not.toBeInTheDocument();
    expect(screen.getByTestId('agent-album-pending')).toBeInTheDocument();
  });

  it('组头状态 fragments 与折叠：生成中 / 失败计数上组头，收起只留组头与「M 张图」', () => {
    seed({
      session: sessionRecord(),
      messages: [
        generateImageCall({ toolCallId: 'call_1', seq: 11, prompt: '已完成的一次调用' }),
        generateImageResult({ toolCallId: 'call_1', seq: 12, assetIds: ['a1', 'a2'] }),
        generateImageCall({ toolCallId: 'call_2', seq: 13, prompt: '生成中的一次调用' }),
        generateImageCall({ toolCallId: 'call_3', seq: 14, prompt: '失败的一次调用' }),
        generateImageResult({
          toolCallId: 'call_3',
          seq: 15,
          status: 'failed',
          summary: '生成失败',
          errorSummary: '上游连接中断，该次调用没有产出。',
        }),
      ],
      inFlight: true,
      toolCallLive: { call_2: toolCallLive({ toolCallId: 'call_2', status: 'running' }) },
    });
    seedImageAssets(['a1', 'a2']);
    render(<AgentSessionView agentSessionId="sess_1" />);

    expect(screen.getByTestId('agent-album-counts')).toHaveTextContent('3 次调用 · 4 张图');
    expect(screen.getByTestId('agent-album-generating-count')).toHaveTextContent('1 生成中');
    expect(screen.getByTestId('agent-album-failed-count')).toHaveTextContent('1 失败');
    // 状态 fragment 走既有状态色令牌。
    expect(screen.getByTestId('agent-album-generating-count').className).toContain(
      'text-(--st-generating-text)',
    );
    expect(screen.getByTestId('agent-album-failed-count').className).toContain('text-(--st-failed-text)');

    // 折叠钮文案与状态：收起只留组头一行 + 「M 张图」。
    const fold = screen.getByTestId('agent-tool-group-toggle');
    expect(fold).toHaveAttribute('aria-label', '收起相册');
    fireEvent.click(fold);
    expect(screen.getByTestId('agent-session-tool-group')).toHaveAttribute('data-collapsed', 'true');
    expect(fold).toHaveAttribute('aria-label', '展开相册');
    expect(screen.queryByTestId('agent-album-body')).not.toBeInTheDocument();
    expect(screen.getByTestId('agent-album-counts')).toHaveTextContent('3 次调用 · 4 张图');
    expect(screen.getByTestId('agent-album-collapsed-count')).toHaveTextContent('4 张图');
  });

  it('提示词明细：组头点击切换，逐调用一行；点已完成行跳到该调用首图（预览起始索引）', () => {
    seedTwoCalls();
    render(<AgentSessionView agentSessionId="sess_1" />);

    const toggle = screen.getByTestId('agent-album-detail-toggle');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId('agent-album-detail')).not.toBeInTheDocument();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const detail = screen.getByTestId('agent-album-detail');
    expect(detail).toHaveAttribute('aria-label', '提示词明细');
    const rows = within(detail).getAllByTestId('agent-album-detail-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('霓虹街巷全景');
    expect(rows[0]).toHaveTextContent('1 张');
    expect(rows[1]).toHaveTextContent('雨夜路面倒影');
    expect(rows[1]).toHaveTextContent('2 张');

    // 第二次调用的首图在整组序列里排第 2 位：跳转要落到该索引上。
    fireEvent.click(rows[1] as HTMLElement);
    expect(screen.getByTestId('agent-album-preview-count')).toHaveTextContent('2 / 3');
    expect(screen.getByTestId('agent-album-preview-prompt')).toHaveTextContent('雨夜路面倒影');
  });

  it('预览翻页：同调用内 prompt 不变，跨调用切到该调用 prompt（含 ← → 键）', () => {
    seedTwoCalls();
    render(<AgentSessionView agentSessionId="sess_1" />);

    // 点第二次调用的第一格 → 序列第 2 位。
    fireEvent.click(albumCells()[1] as HTMLElement);
    expect(screen.getByTestId('agent-album-preview-count')).toHaveTextContent('2 / 3');
    expect(screen.getByTestId('agent-album-preview-prompt')).toHaveTextContent('雨夜路面倒影');

    // 同一次调用的第二张：prompt 不变。
    fireEvent.click(screen.getByTestId('agent-album-preview-next'));
    expect(screen.getByTestId('agent-album-preview-count')).toHaveTextContent('3 / 3');
    expect(screen.getByTestId('agent-album-preview-prompt')).toHaveTextContent('雨夜路面倒影');
    expect(screen.getByTestId('agent-album-preview-next')).toBeDisabled();

    // 跨调用翻页：prompt 随图切换。
    fireEvent.click(screen.getByTestId('agent-album-preview-prev'));
    fireEvent.click(screen.getByTestId('agent-album-preview-prev'));
    expect(screen.getByTestId('agent-album-preview-count')).toHaveTextContent('1 / 3');
    expect(screen.getByTestId('agent-album-preview-prompt')).toHaveTextContent('霓虹街巷全景');
    expect(screen.getByTestId('agent-album-preview-prev')).toBeDisabled();

    // 方向键翻页：← → 与按钮等效；含修饰键不消费（留给系统）。
    fireEvent.keyDown(screen.getByTestId('agent-album-preview-count'), { key: 'ArrowRight' });
    expect(screen.getByTestId('agent-album-preview-count')).toHaveTextContent('2 / 3');
    fireEvent.keyDown(screen.getByTestId('agent-album-preview-count'), {
      key: 'ArrowRight',
      ctrlKey: true,
    });
    expect(screen.getByTestId('agent-album-preview-count')).toHaveTextContent('2 / 3');
    fireEvent.keyDown(screen.getByTestId('agent-album-preview-count'), { key: 'ArrowLeft' });
    expect(screen.getByTestId('agent-album-preview-count')).toHaveTextContent('1 / 3');
  });

  it('预览层：「用作参考」走既有 referenceOps 入口按素材 ID 直加，参考图 chips 随调用切换', () => {
    seed({
      session: sessionRecord(),
      messages: [
        generateImageCall({ toolCallId: 'call_1', seq: 11, prompt: '带参考图的一次调用', referenceAssetIds: ['a1'] }),
        generateImageResult({ toolCallId: 'call_1', seq: 12, assetIds: ['a2'] }),
        generateImageCall({ toolCallId: 'call_2', seq: 13, prompt: '不带参考图的一次调用' }),
        generateImageResult({ toolCallId: 'call_2', seq: 14, assetIds: ['a3'] }),
      ],
    });
    seedImageAssets(['a1', 'a2', 'a3']);
    render(<AgentSessionView agentSessionId="sess_1" />);

    fireEvent.click(albumCells()[0] as HTMLElement);
    const meta = screen.getByTestId('agent-album-preview-meta');
    expect(within(meta).getAllByTestId('agent-media-reference')).toHaveLength(1);

    fireEvent.click(screen.getByTestId('agent-album-preview-next'));
    // 跨调用后参考图随之切换：第二次调用没有参考图。
    expect(screen.queryByTestId('agent-media-reference')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('agent-album-preview-prev'));
    fireEvent.click(screen.getByTestId('agent-album-preview-reference'));
    // 当前页的产物按素材 ID 直加进参考区（不依赖画布节点，不建第二引用入口）。
    expect(usePromptDockStore.getState().draft.references.map((ref) => ref.assetId)).toEqual(['a2']);
    expect(vi.mocked(addNodesToReferences)).not.toHaveBeenCalled();
  });

  // @spec: AG-EX-002
  it('画布上没有产物节点（存量会话产物）：预览层「用作参考」仍按素材 ID 加入参考区', () => {
    seed({
      session: sessionRecord(),
      messages: [
        generateImageCall({ toolCallId: 'call_1', seq: 11, prompt: '存量产物的一次调用' }),
        generateImageResult({ toolCallId: 'call_1', seq: 12, assetIds: ['a2'] }),
      ],
    });
    // 资产记录在、画布上没有持有它的节点。
    useCanvasStore.setState({
      mediaAssets: { a2: imageAsset('a2') },
      nodeGraph: createTestNodeGraph({ nodes: [] }),
    });
    render(<AgentSessionView agentSessionId="sess_1" />);

    fireEvent.click(albumCells()[0] as HTMLElement);
    fireEvent.click(screen.getByTestId('agent-album-preview-reference'));

    expect(usePromptDockStore.getState().draft.references.map((ref) => ref.assetId)).toEqual(['a2']);
  });

  it('N=1 例外：全组仅 1 张已就绪产物走真实比例独立带，不进方格', () => {
    seed({
      session: sessionRecord(),
      messages: [
        generateImageCall({ toolCallId: 'call_1', seq: 11, prompt: '霓虹招牌竖版特写' }),
        generateImageResult({ toolCallId: 'call_1', seq: 12, assetIds: ['a1'] }),
      ],
    });
    seedImageAssets(['a1']);
    render(<AgentSessionView agentSessionId="sess_1" />);

    expect(screen.getByTestId('agent-album-solo')).toBeInTheDocument();
    expect(screen.queryByTestId('agent-album-grid')).not.toBeInTheDocument();
    const cell = albumCells()[0] as HTMLElement;
    // 真实比例（800×600 = 1.3333）与 240px 高上限 × 比例推出的宽上限；不走 1:1 裁切。
    expect(cell.className).toContain('aspect-auto');
    expect(cell.style.aspectRatio).toBe('1.3333');
    expect(cell.style.maxWidth).toBe('min(100%, 320px)');
  });

  it('状态格：生成中格是非按钮占位、失败格可点开错误详情（prompt + 失败原因），未完成行不可跳转', () => {
    seed({
      session: sessionRecord(),
      messages: [
        generateImageCall({ toolCallId: 'call_1', seq: 11, prompt: '已完成的一次调用' }),
        generateImageResult({ toolCallId: 'call_1', seq: 12, assetIds: ['a1'] }),
        generateImageCall({ toolCallId: 'call_2', seq: 13, prompt: '生成中的一次调用' }),
        generateImageCall({ toolCallId: 'call_3', seq: 14, prompt: '失败的一次调用' }),
        generateImageResult({
          toolCallId: 'call_3',
          seq: 15,
          status: 'failed',
          summary: '生成失败',
          errorSummary: '上游连接中断，该次调用没有产出。',
        }),
      ],
      inFlight: true,
      toolCallLive: { call_2: toolCallLive({ toolCallId: 'call_2', status: 'running' }) },
    });
    seedImageAssets(['a1']);
    render(<AgentSessionView agentSessionId="sess_1" />);

    const states = stateCells();
    expect(states).toHaveLength(2);
    const generating = states.find((cell) => cell.getAttribute('data-state') === 'generating');
    const failed = states.find((cell) => cell.getAttribute('data-state') === 'failed');
    // 生成中格：占位底 + 呼吸点 + 「生成中」，不是按钮（没有可点的出口）。
    expect(generating?.tagName).toBe('DIV');
    expect(generating).toHaveTextContent('生成中');
    expect(generating?.querySelector('.agent-session-breathe')).not.toBeNull();
    expect(failed?.tagName).toBe('BUTTON');
    expect(failed).toHaveTextContent('生成失败');

    // 明细里未完成的调用行不可点击（只有已完成行能跳该调用首图）；状态词的调用序号在格内信息条上。
    fireEvent.click(screen.getByTestId('agent-album-detail-toggle'));
    const rows = screen.getAllByTestId('agent-album-detail-row');
    expect(rows).toHaveLength(3);
    expect(rows[0]?.tagName).toBe('BUTTON');
    expect(rows[1]?.tagName).toBe('DIV');
    expect(rows[1]).toHaveTextContent('生成中');
    expect(rows[2]).toHaveTextContent('失败');
    expect(generating).toHaveTextContent('第 2 次调用 · 生成中');

    // 失败格点开错误详情：prompt + 失败原因都给出（走同一个预览壳，不做第二套弹层）。
    fireEvent.click(failed as HTMLElement);
    const detail = screen.getByTestId('agent-album-error-detail');
    expect(detail).toHaveAttribute('data-call-id', 'call_3');
    const errorMeta = screen.getByTestId('agent-album-error-meta');
    expect(errorMeta).toHaveTextContent('失败的一次调用');
    expect(errorMeta).toHaveTextContent('上游连接中断，该次调用没有产出。');
    // 状态格不进翻页序列：错误详情层没有导航控件。
    expect(screen.queryByTestId('agent-album-preview-nav')).not.toBeInTheDocument();
  });

  it('产物未就绪：占位留在格内不给预览出口；该产物仍是序列里的一页（空态占位，不阻塞翻页）', () => {
    seed({
      session: sessionRecord(),
      messages: [
        generateImageCall({ toolCallId: 'call_1', seq: 11, prompt: '一张就绪一张未就绪' }),
        generateImageResult({ toolCallId: 'call_1', seq: 12, assetIds: ['a1', 'missing'] }),
      ],
    });
    seedImageAssets(['a1']);
    render(<AgentSessionView agentSessionId="sess_1" />);

    const cells = albumCells();
    expect(cells).toHaveLength(2);
    const unsettled = cells[1] as HTMLElement;
    expect(unsettled.tagName).toBe('DIV');
    expect(unsettled).toHaveTextContent('产物未就绪');
    expect(unsettled.querySelector('img')).toBeNull();
    fireEvent.click(unsettled);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    // 就绪的那张可预览：序列按调用产出算，因此是 1 / 2。
    fireEvent.click(cells[0] as HTMLElement);
    expect(screen.getByTestId('agent-album-preview-count')).toHaveTextContent('1 / 2');
    // 翻到未就绪那页：显示空态占位，翻页不被阻塞（契约「预览地址缺失」）。
    fireEvent.click(screen.getByTestId('agent-album-preview-next'));
    expect(screen.getByTestId('agent-album-preview-count')).toHaveTextContent('2 / 2');
    expect(screen.getByText('暂无图片输出')).toBeInTheDocument();
    expect(screen.getByTestId('agent-album-preview-prompt')).toHaveTextContent('一张就绪一张未就绪');
    fireEvent.click(screen.getByTestId('agent-album-preview-prev'));
    expect(screen.getByTestId('agent-album-preview-count')).toHaveTextContent('1 / 2');
  });

  it('同调用兄弟格高亮：hover 与键盘 focus 等效，离开干净复位', () => {
    seedTwoCalls();
    render(<AgentSessionView agentSessionId="sess_1" />);

    const cells = albumCells();
    // hover 第二次调用的第一格：其余调用的格加 scrim 暗遮罩，同调用兄弟格保持清晰。
    fireEvent.mouseOver(cells[1] as HTMLElement);
    expect(cells[0]).toHaveAttribute('data-dimmed', 'true');
    expect(cells[1]).toHaveAttribute('data-dimmed', 'false');
    expect(cells[2]).toHaveAttribute('data-dimmed', 'false');

    // 键盘 focus 等效（纯键盘用户拿到同一份归属信息）。
    fireEvent.mouseOut(cells[1] as HTMLElement, { relatedTarget: document.body });
    expect(albumCells().every((cell) => cell.getAttribute('data-dimmed') === 'false')).toBe(true);
    fireEvent.focusIn(cells[2] as HTMLElement);
    expect(albumCells()[0]).toHaveAttribute('data-dimmed', 'true');
    expect(albumCells()[2]).toHaveAttribute('data-dimmed', 'false');

    // focus 离开干净复位。
    fireEvent.focusOut(cells[2] as HTMLElement, { relatedTarget: document.body });
    expect(albumCells().every((cell) => cell.getAttribute('data-dimmed') === 'false')).toBe(true);
  });

  it('yolo 自动执行：相册组里的单条取消带调用序号，仍走既有 agent:cancel 单条通道', () => {
    const sendCancelSpy = vi.spyOn(agentSocket, 'sendCancel').mockImplementation(() => {});
    seed({
      session: sessionRecord({ approvalMode: 'yolo' }),
      messages: [
        generateImageCall({ toolCallId: 'call_1', seq: 11, prompt: '已完成的一次调用' }),
        generateImageResult({ toolCallId: 'call_1', seq: 12, assetIds: ['a1'] }),
        generateImageCall({ toolCallId: 'call_2', seq: 13, prompt: '自动执行中的一次调用' }),
      ],
      inFlight: true,
      toolCallLive: { call_2: toolCallLive({ toolCallId: 'call_2', status: 'running' }) },
    });
    seedImageAssets(['a1']);
    render(<AgentSessionView agentSessionId="sess_1" />);

    // 相册里每个格没有卡头，取消入口必须指明取消的是哪一次调用。
    const cancelRow = screen.getByTestId('agent-tool-yolo-cancel');
    expect(cancelRow).toHaveTextContent('第 2 次调用');
    expect(cancelRow).toHaveTextContent('已自动开始执行，可取消');
    fireEvent.click(within(cancelRow).getByRole('button', { name: '取消' }));
    expect(sendCancelSpy).toHaveBeenCalledTimes(1);
    expect(sendCancelSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'agent:cancel', agentSessionId: 'sess_1', toolCallId: 'call_2' }),
    );
    // 只中止该条目（spec 04 单条取消），同组其他调用不受影响。
    expect(screen.getByTestId('agent-album-cell')).toBeInTheDocument();

    // 收起相册收不掉在跑动作的取消入口（行动出口不能被聚合藏起来）。
    fireEvent.click(screen.getByTestId('agent-tool-group-toggle'));
    expect(screen.queryByTestId('agent-album-body')).not.toBeInTheDocument();
    expect(screen.getByTestId('agent-tool-yolo-cancel')).toBeInTheDocument();
  });
});

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

import type { AgentMessageRecord } from '@iart/contracts';
import {
  ensureAgentMessagesLoaded,
  useAgentSessionStore,
} from '@/features/agent/agentSessionStore';
import type * as AgentSessionStoreModule from '@/features/agent/agentSessionStore';
import { agentSocket } from '@/features/agent/agentSocket';
import { addNodesToReferences } from '@/features/promptdock/referenceOps';
import type * as ReferenceOpsModule from '@/features/promptdock/referenceOps';
import { useCanvasStore } from '@/features/canvas/store/canvasStore';
import { formatBeijingDateDivider } from '@/shared/utils/time';
import { AgentSessionView } from '../components/AgentSessionView';
import {
  assistantMessage,
  generateImageCall,
  generateImageResult,
  secondToolCallMessage,
  seed,
  seedCanvas,
  seedImageAssets,
  sessionRecord,
  toolCallLive,
  toolCallMessage,
  toolResultMessage,
  userMessage,
} from './agentSessionViewFixtures';

/**
 * Agent 会话视图（spec docs/agent/02「会话视图与多轮历史」）。
 *
 * 保护：只读多轮历史按时间顺序渲染并区分角色；流式回复实时渲染；打开时按需读取消息
 * （读取完成前是加载态，完成后无消息才是空态）；会话数据缺失给明确说明；
 * 该轮失败在列表尾部给错误条（文案按错误码映射，不印后端原文、不给重发按钮）；
 * 视图内不提供输入框（继续对话回到 PromptDock）；工具调用卡片按活跃态/历史渲染，
 * 无活跃态时不提供会静默失败的操作出口；
 * 产物缩略图可点开预览、hover/键盘聚焦出现「用作参考」（走 referenceOps 唯一入口）；
 * 发送留痕先于受理可见（尚无正式 user 消息对应的留痕渲染进会话流，已受理的不重复渲染）；
 * yolo 自动执行的工具卡给短提示与单条取消（走既有 agent:cancel，不造协议）；
 * confirm 档未决提案由批量审批面板承载（默认全勾选、取消勾选即过滤、批级倒计时、
 * 提交与整轮驳回各一枚、投递失败给反馈且可重试、提交后禁用防重复提交）。
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
  seedCanvas();
});

afterEach(() => {
  vi.restoreAllMocks();
  useCanvasStore.setState({ mediaAssets: {}, nodeGraph: null });
});

describe('Agent 会话视图', () => {
  it('按时间顺序渲染多轮消息并区分角色，打开时按需读取消息', () => {
    seed({ session: sessionRecord(), messages: [userMessage, assistantMessage] });
    render(<AgentSessionView agentSessionId="sess_1" />);

    expect(ensureAgentMessagesLoaded).toHaveBeenCalledWith('sess_1');

    const rendered = screen.getAllByTestId('agent-session-message');
    expect(rendered).toHaveLength(2);
    expect(rendered[0]).toHaveAttribute('data-role', 'user');
    expect(rendered[1]).toHaveAttribute('data-role', 'assistant');
    expect(rendered[0]).toHaveTextContent('画一只在雨中弹吉他的柴犬');
    expect(rendered[1]).toHaveTextContent('好的，我先理一下步骤。');
  });

  it('Agent 回复按 markdown 渲染，用户消息保持原文不解释', () => {
    const markdownReply: AgentMessageRecord = {
      ...assistantMessage,
      body: { kind: 'chat', content: '## 步骤\n\n**重点**：先引用素材。' },
    };
    seed({ session: sessionRecord(), messages: [userMessage, markdownReply] });
    render(<AgentSessionView agentSessionId="sess_1" />);

    const messages = screen.getAllByTestId('agent-session-message');
    // Agent 消息：markdown 结构化（标题 / 强调），不是纯文本段。
    // streamdown 的强调不是 <strong> 元素，是 data-streamdown 标记的 span；
    // 代码块经 shiki 异步高亮（jsdom 无网络不加载），其行为归 streamdown 上游，不在本用例断言。
    expect(messages[1]?.querySelector('h2')?.textContent).toBe('步骤');
    expect(messages[1]?.querySelector('[data-streamdown="strong"]')?.textContent).toBe('重点');
    // 用户消息：原样呈现输入文本，不把 markdown 语法解释成结构
    expect(messages[0]?.querySelector('h2')).toBeNull();
    expect(messages[0]?.querySelector('[data-streamdown="strong"]')).toBeNull();
  });

  it('流式增量按 markdown 渲染（未闭合结构不崩、文本可见）', async () => {
    seed({ session: sessionRecord(), messages: [userMessage], inFlight: true });
    const { rerender } = render(<AgentSessionView agentSessionId="sess_1" />);

    await act(async () => {
      useAgentSessionStore.setState({
        streamingBySessionId: { sess_1: '## 计划\n\n- 第一步\n- 第二' },
      });
    });
    rerender(<AgentSessionView agentSessionId="sess_1" />);

    const streaming = screen.getByTestId('agent-session-streaming');
    expect(streaming.querySelector('h2')?.textContent).toBe('计划');
    expect(streaming).toHaveTextContent('第二');
    // 流式态：左侧品牌色呼吸条保留；文本尾光标由 markdown 渲染容器上的 caret 类承载（2px 闪烁，CSS 动画）。
    expect(streaming.querySelector('.agent-session-pulse')).not.toBeNull();
    expect(streaming.querySelector('.agent-session-caret-host')).not.toBeNull();
  });

  it('视图内不再重复会话摘要：标题 / 模型 / 消息量 / 最新时间都不在内容区（标题归面板标题栏）', () => {
    seed({ session: sessionRecord(), messages: [userMessage, assistantMessage] });
    render(<AgentSessionView agentSessionId="sess_1" />);

    // 摘要头整块退役：消息流直接顶到面板标题栏下（避免同一份会话信息在面板里说两遍）。
    expect(screen.queryByTestId('agent-session-view-header')).not.toBeInTheDocument();
    const view = screen.getByTestId('agent-session-view');
    expect(view).not.toHaveTextContent('my-llm');
    expect(view).not.toHaveTextContent('2 条消息');
    expect(view).not.toHaveTextContent('最新 ');
    // 消息流本身照常渲染
    expect(screen.getAllByTestId('agent-session-message')).toHaveLength(2);
  });

  it('流式回复实时渲染：在途文本与回复中状态可见', async () => {
    const { rerender } = render(<AgentSessionView agentSessionId="sess_1" />);

    await act(async () => {
      seed({ session: sessionRecord(), messages: [userMessage], inFlight: true });
    });
    rerender(<AgentSessionView agentSessionId="sess_1" />);
    expect(screen.getByTestId('agent-session-streaming')).toHaveTextContent('正在回复…');

    await act(async () => {
      useAgentSessionStore.setState({ streamingBySessionId: { sess_1: '正在起草第一步' } });
    });
    rerender(<AgentSessionView agentSessionId="sess_1" />);
    expect(screen.getByTestId('agent-session-streaming')).toHaveTextContent('正在起草第一步');
  });

  it('空会话给引导文案，不显示空串或零值面板', () => {
    seed({ session: sessionRecord({ messageCount: 0 }), messagesLoaded: true });
    render(<AgentSessionView agentSessionId="sess_1" />);

    expect(screen.getByTestId('agent-session-view-empty')).toHaveTextContent(
      '还没有消息，在创作条里说说你想做什么吧。',
    );
    expect(screen.queryAllByTestId('agent-session-message')).toHaveLength(0);
  });

  it('空态居中呈现 11px 指引（读取态留在顶部）', () => {
    seed({ session: sessionRecord({ messageCount: 0 }), messagesLoaded: true });
    render(<AgentSessionView agentSessionId="sess_1" />);

    const empty = screen.getByTestId('agent-session-view-empty');
    expect(empty).toHaveTextContent('还没有消息，在创作条里说说你想做什么吧。');
    expect(empty.className).toContain('text-[11px]');
    // 终态容器居中（列表里没有别的内容时才居中，读取态不居中以免内容到达时跳动）
    const container = empty.parentElement;
    expect(container?.className).toContain('items-center');
    expect(container?.className).toContain('justify-center');
  });

  it('按需读取未完成：显示加载态而不是空态（不把「还没读到」说成「没有消息」）', () => {
    seed({ session: sessionRecord({ messageCount: 0 }), messagesLoaded: false });
    render(<AgentSessionView agentSessionId="sess_1" />);

    expect(screen.getByTestId('agent-session-view-loading')).toHaveTextContent('正在读取…');
    expect(screen.queryByTestId('agent-session-view-empty')).not.toBeInTheDocument();
  });

  it('按需读取失败：给读取失败出口，不停在「正在读取…」', () => {
    seed({ session: sessionRecord({ messageCount: 0 }), messagesLoaded: false, messagesLoadFailed: true });
    render(<AgentSessionView agentSessionId="sess_1" />);

    const failed = screen.getByTestId('agent-session-view-load-failed');
    expect(failed).toHaveTextContent('会话内容没能读出来，关掉这个面板再打开试试。');
    expect(failed.className).toContain('text-[11px]');
    expect(failed.parentElement?.className).toContain('items-center');
    expect(screen.queryByTestId('agent-session-view-loading')).not.toBeInTheDocument();
    expect(screen.queryByTestId('agent-session-view-empty')).not.toBeInTheDocument();
  });

  it('失败轮在流内呈现：错误文案按错误码映射 + 出口指引回到输入框，视图内不提供重试按钮（spec 02 只读）', () => {
    seed({
      session: sessionRecord(),
      messages: [userMessage],
      error: { code: 'execution_failed', message: 'stream broke: ECONNRESET' },
    });
    render(<AgentSessionView agentSessionId="sess_1" />);

    const errorRow = screen.getByTestId('agent-session-error');
    expect(errorRow).toHaveTextContent('这一轮回复中断了，可以再发一次。');
    expect(errorRow).not.toHaveTextContent('ECONNRESET');
    // 指引只说出口，不提供第二入口：视图内没有「重试 / 重新发送」按钮。
    // 出口指认真实可达的位置：本视图没有输入区，「下方输入框」是不存在的出口（PromptDock 在画布底部）。
    expect(screen.getByTestId('agent-session-error-hint')).toHaveTextContent(
      '可在画布底部的创作条里重新发送',
    );
    expect(screen.queryByRole('button', { name: /重新发送|重试/ })).not.toBeInTheDocument();
    expect(errorRow.querySelector('button')).toBeNull();
  });

  it('会话数据缺失时给明确说明与出口（不显示空白面板）', () => {
    seed({ session: null });
    render(<AgentSessionView agentSessionId="sess_missing" />);

    expect(screen.getByTestId('agent-session-view-unavailable')).toHaveTextContent(
      '这个会话已经不在了，删掉这个节点后可以重新开始。',
    );
    expect(screen.queryByTestId('agent-session-view')).not.toBeInTheDocument();
  });

  it('只读：视图内没有输入框与发送/重发出口（继续对话回到 PromptDock）', () => {
    seed({ session: sessionRecord(), messages: [userMessage] });
    render(<AgentSessionView agentSessionId="sess_1" />);

    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    // 唯一合法按钮是「回到底部」（跟随恢复出口，2026-09-23 评审通过）；
    // 不得出现发送、重发、重试类对话出口。
    const buttons = screen.getAllByRole('button');
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual(['回到底部']);
  });

  it('消息流视觉形态：用户消息右对齐气泡、Agent 回复左对齐平铺', () => {
    seed({ session: sessionRecord(), messages: [userMessage, assistantMessage] });
    render(<AgentSessionView agentSessionId="sess_1" />);

    const [userEntry, assistantEntry] = screen.getAllByTestId('agent-session-message');
    const bubble = screen.getByTestId('agent-message-user-bubble');
    // 气泡：按内容收缩、最多占面板 85%、右下角小圆角；配色维持填充底，不加边框。
    expect(bubble.className).toContain('w-fit');
    expect(bubble.className).toContain('max-w-[85%]');
    expect(bubble.className).toContain('rounded-2xl');
    expect(bubble.className).toContain('rounded-br-md');
    expect(bubble.className).toContain('bg-secondary/60');
    expect(bubble.className).not.toContain('border');
    // 气泡与 meta 行同侧右对齐（外层 items-end），user 条目里不再有左对齐的裸文本块。
    const row = bubble.parentElement;
    expect(row?.className).toContain('items-end');
    expect(userEntry).toContainElement(bubble);
    // Agent 回复保持左对齐、无气泡盒。
    expect(assistantEntry?.querySelector('[data-testid="agent-message-user-bubble"]')).toBeNull();
    expect(assistantEntry?.textContent).toContain('好的，我先理一下步骤。');
  });

  it('转发留痕（role: user）与正式用户消息同形态：右对齐气泡', () => {
    seed({
      session: sessionRecord(),
      messages: [assistantMessage],
      sendRecords: [
        {
          recordId: 'rec_pending',
          agentSessionId: 'sess_1',
          nodeId: 'node_1',
          requestId: 'req_pending',
          createdAt: 1_770_000_900_000,
          content: '再来一张夜景版',
          referenceAssetIds: [],
          snapshot: {
            modelId: 'my-llm',
            thinkingTier: 'off',
            approvalMode: 'confirm' as const,
            referenceAssetIds: [],
            submittedAt: 1_770_000_900_000,
          },
        },
      ],
    });
    render(<AgentSessionView agentSessionId="sess_1" />);

    const record = screen.getByTestId('agent-session-send-record');
    const bubble = screen.getByTestId('agent-message-user-bubble');
    expect(record).toContainElement(bubble);
    expect(bubble.parentElement?.className).toContain('items-end');
    expect(bubble).toHaveTextContent('再来一张夜景版');
  });

  it('消息流按北京时间日期分界插入分隔条（同日不插，跨日插一条）', () => {
    // 2026-09-19 23:50 / 2026-09-20 00:10（北京时间）：跨日两条消息
    const firstAt = Date.parse('2026-09-19T15:50:00.000Z');
    const secondAt = Date.parse('2026-09-19T16:10:00.000Z');
    seed({
      session: sessionRecord(),
      messages: [
        { ...userMessage, createdAt: firstAt },
        { ...assistantMessage, createdAt: secondAt },
      ],
    });
    render(<AgentSessionView agentSessionId="sess_1" />);

    const dividers = screen.getAllByTestId('agent-session-date-divider');
    expect(dividers).toHaveLength(2);
    expect(dividers[0]).toHaveAttribute('data-date', '2026-09-19');
    expect(dividers[1]).toHaveAttribute('data-date', '2026-09-20');
    // 文案走共享的北京时间格式化（AGENTS.md 时间戳规范），不自行拼本地时间
    expect(dividers[0]).toHaveTextContent(formatBeijingDateDivider(firstAt));
    expect(dividers[0]?.textContent ?? '').toMatch(/9月19日/);
  });

  it('同一天的多条消息只插一条分隔条', () => {
    seed({ session: sessionRecord(), messages: [userMessage, assistantMessage] });
    render(<AgentSessionView agentSessionId="sess_1" />);

    expect(screen.getAllByTestId('agent-session-date-divider')).toHaveLength(1);
  });

  it('消息流是 role="log" 区域（追加式历史；不设 aria-live，不打断式播报）', () => {
    seed({ session: sessionRecord(), messages: [userMessage, assistantMessage] });
    render(<AgentSessionView agentSessionId="sess_1" />);

    const list = screen.getByTestId('agent-session-message-list');
    expect(list).toHaveAttribute('role', 'log');
    expect(list).not.toHaveAttribute('aria-live');
  });

  it('粘底跟随：库引擎在位（滚动容器+内容层结构），回底按钮随在底状态显隐；行为验收走真实浏览器', async () => {
    // use-stick-to-bottom 的跟随判定由 ResizeObserver 驱动，jsdom 无布局引擎也不实现
    // ResizeObserver 观察回调——几何行为（贴底/停跟随/回底恢复）在真实浏览器验收
    // （设计文档 §7）。这里守住 jsdom 能观察的结构与状态接线：
    // ① 滚动容器内必须有内容包裹层（库的 contentRef 挂载点，尺寸监听对象）；
    // ② 回底按钮在 DOM 且 aria 正确，在底状态不挡内容（不脱灰布局）。
    // 同时防回归：组件不得再引入 onScroll 驱动的自研信号清单（本轮缺陷根因）。
    seed({ session: sessionRecord(), messages: [userMessage, assistantMessage] });
    render(<AgentSessionView agentSessionId="sess_1" />);

    const list = screen.getByTestId('agent-session-message-list');
    expect(list.querySelector(':scope > div')).not.toBeNull();

    const bottomBtn = screen.getByTestId('agent-session-scroll-to-bottom');
    expect(bottomBtn).toHaveAttribute('aria-label', '回到底部');

    // scroll 事件后库把「在底」置回 true（jsdom 里 scrollTop 恒 0 = 距底 0）：
    // 按钮隐藏（opacity-0 + 不截获点击）——显隐与 isAtBottom 真实接线。
    fireEvent.scroll(list);
    expect(bottomBtn.className).toContain('opacity-0');
    expect(bottomBtn.className).toContain('pointer-events-none');

    // 上翻历史（jsdom 无滚动引擎，滚动位置不变，但事件通路可达）：
    // 组件不崩溃、按钮仍在 DOM（jsdom 中几何不变化，显隐断言留给真实浏览器）。
    expect(() => fireEvent.scroll(list)).not.toThrow();
    expect(screen.getByTestId('agent-session-scroll-to-bottom')).toBeInTheDocument();
  });

  it('工具调用提案条目卡：无活跃态时按「等待确认」呈现且不给决裁出口，不崩溃也不误报内容', () => {
    seed({
      session: sessionRecord(),
      messages: [toolCallMessage],
    });
    render(<AgentSessionView agentSessionId="sess_1" />);

    // 工具条目走工具活动组（不再按 agent-session-message 单条渲染）：
    // 组头轻行 + 条目卡；提案卡片按工具名渲染状态（恢复语义以运行域事实为准，不臆造可执行状态）。
    const group = screen.getByTestId('agent-session-tool-group');
    expect(group).toHaveAttribute('data-collapsed', 'false');
    expect(group).toHaveTextContent('生成图像 · 1 项');
    expect(screen.queryAllByTestId('agent-session-message')).toHaveLength(0);

    const card = screen.getByTestId('agent-session-tool-call');
    expect(card).toHaveAttribute('data-tool-name', 'generate_image');
    expect(card).toHaveAttribute('data-status', 'proposed');
    expect(screen.getByTestId('agent-tool-call-status')).toHaveTextContent('等待确认');
    // 提案条目内容（spec 06）：prompt 摘要可见；卡片上不再有逐条决裁出口，也没有审批面板。
    expect(screen.getByTestId('agent-tool-proposal-details')).toHaveTextContent('一只柴犬');
    expect(screen.queryByRole('button', { name: '确认执行' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '跳过' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('agent-tool-proposal-panel')).not.toBeInTheDocument();
  });

  it('组本身无背景无边框：相册组以格为媒体容器，条目卡组以卡为唯一容器（去 folder 化，无组级/条目级状态色条）', () => {
    // 图片生成结果走相册形态：多个产物格是媒体容器（1:1 cover + 圆角边框），组壳只有上方 1px 分隔线。
    seed({
      session: sessionRecord(),
      messages: [
        generateImageCall({ toolCallId: 'call_1', seq: 11, prompt: '一只柴犬' }),
        generateImageResult({ toolCallId: 'call_1', seq: 12, assetIds: ['asset_1'] }),
        generateImageCall({ toolCallId: 'call_2', seq: 13, prompt: '一只柴犬' }),
        generateImageResult({ toolCallId: 'call_2', seq: 14, assetIds: ['asset_2'] }),
      ],
    });
    seedImageAssets(['asset_1', 'asset_2']);
    const { unmount } = render(<AgentSessionView agentSessionId="sess_1" />);

    const group = screen.getByTestId('agent-session-tool-group');
    expect(group.className).toContain('border-t');
    expect(group.className).not.toContain('rounded');
    expect(group.className).not.toContain('bg-card');

    const cell = screen.getAllByTestId('agent-album-cell')[0];
    expect(cell?.className).toContain('rounded-md');
    expect(cell?.className).toContain('border');
    expect(cell?.className).toContain('overflow-hidden');
    expect(cell?.className).toContain('aspect-square');
    // 状态只由组头摘要与状态格表达：格里没有左侧状态色条元素。
    expect(cell?.querySelector('.absolute.inset-y-1.left-0')).toBeNull();
    unmount();

    // 非相册工具（条目卡组）仍是条目卡承载 1px 边框 + 卡底：收敛没有波及这一形态。
    seed({
      session: sessionRecord(),
      messages: [
        {
          ...toolResultMessage,
          body: {
            kind: 'tool_result',
            toolCallId: 'call_1',
            toolName: 'generate_video',
            status: 'succeeded',
            summary: '已生成 1 段视频',
            assetIds: ['asset_1'],
            errorSummary: null,
          },
        },
      ],
    });
    render(<AgentSessionView agentSessionId="sess_1" />);
    const card = screen.getByTestId('agent-session-tool-result');
    expect(card.className).toContain('rounded-lg');
    expect(card.className).toContain('bg-card');
    expect(card.className).toContain('overflow-hidden');
    expect(card.querySelector('.absolute.inset-y-1.left-0')).toBeNull();
  });

  it('工具活动组：含产物的条目永不自动折叠（纯文本组全部终态且 >2 项才默认折叠）', () => {
    const textResult = (toolCallId: string, seq: number): AgentMessageRecord => ({
      ...toolResultMessage,
      seq,
      body: {
        kind: 'tool_result',
        toolCallId,
        toolName: 'generate_image',
        status: 'succeeded',
        summary: '已生成 1 张图片',
        assetIds: [],
        errorSummary: null,
      },
    });
    const assetResult = (toolCallId: string, seq: number): AgentMessageRecord => ({
      ...toolResultMessage,
      seq,
      body: {
        kind: 'tool_result',
        toolCallId,
        toolName: 'generate_image',
        status: 'succeeded',
        summary: '已生成 1 张图片',
        assetIds: ['asset_1'],
        errorSummary: null,
      },
    });

    seed({ session: sessionRecord(), messages: [textResult('call_a', 11), textResult('call_b', 12), textResult('call_c', 13)] });
    seedCanvas({ withAsset: true, withNode: true });
    const { unmount } = render(<AgentSessionView agentSessionId="sess_1" />);
    expect(screen.getByTestId('agent-session-tool-group')).toHaveAttribute('data-collapsed', 'true');
    unmount();

    seed({
      session: sessionRecord(),
      messages: [assetResult('call_a', 11), assetResult('call_b', 12), assetResult('call_c', 13)],
    });
    render(<AgentSessionView agentSessionId="sess_1" />);
    expect(screen.getByTestId('agent-session-tool-group')).toHaveAttribute('data-collapsed', 'false');
    // 折叠钮可展开/收起（含产物组默认展开，用户仍可手动折叠）。
    fireEvent.click(screen.getByTestId('agent-tool-group-toggle'));
    expect(screen.getByTestId('agent-session-tool-group')).toHaveAttribute('data-collapsed', 'true');
    expect(screen.queryAllByTestId('agent-session-tool-result')).toHaveLength(0);
  });

  it('发送留痕先于受理可见：尚无正式 user 消息对应的留痕按时间序渲染进会话流', () => {
    const pendingRecord = {
      recordId: 'rec_pending',
      agentSessionId: 'sess_1',
      nodeId: 'node_1',
      requestId: 'req_pending',
      createdAt: 1_770_000_650_000,
      content: '再来一张夜景版',
      referenceAssetIds: [],
      snapshot: {
        modelId: 'my-llm',
        thinkingTier: 'off',
        approvalMode: 'confirm' as const,
        referenceAssetIds: [],
        submittedAt: 1_770_000_650_000,
      },
    };
    seed({
      session: sessionRecord(),
      messages: [userMessage, assistantMessage],
      sendRecords: [pendingRecord],
    });
    render(<AgentSessionView agentSessionId="sess_1" />);

    const record = screen.getByTestId('agent-session-send-record');
    expect(record).toHaveTextContent('再来一张夜景版');
    // 排序对齐：留痕 createdAt 在两条正式消息之间（不强制断言 DOM 顺序，但内容不得丢失）
    expect(screen.getAllByTestId('agent-session-message')).toHaveLength(2);
  });

  it('已受理的发送留痕不重复渲染（正式 user 消息已承载，同一 requestId 只出现一次）', () => {
    const acceptedRecord = {
      recordId: 'rec_accepted',
      agentSessionId: 'sess_1',
      nodeId: 'node_1',
      requestId: 'req_1',
      createdAt: 1_770_000_000_000,
      content: '画一只在雨中弹吉他的柴犬',
      referenceAssetIds: [],
      snapshot: {
        modelId: 'my-llm',
        thinkingTier: 'off',
        approvalMode: 'confirm' as const,
        referenceAssetIds: [],
        submittedAt: 1_770_000_000_000,
      },
    };
    seed({
      session: sessionRecord(),
      messages: [userMessage, assistantMessage],
      sendRecords: [acceptedRecord],
    });
    render(<AgentSessionView agentSessionId="sess_1" />);

    expect(screen.queryByTestId('agent-session-send-record')).not.toBeInTheDocument();
    // 正式消息照常渲染（留痕不重复承载同一句话）
    expect(screen.getAllByTestId('agent-session-message')).toHaveLength(2);
  });

  it('yolo 自动执行的工具卡：执行中给短提示与单条取消，取消走既有 agent:cancel（不造协议）', () => {
    const sendCancelSpy = vi.spyOn(agentSocket, 'sendCancel').mockImplementation(() => {});
    seed({
      session: sessionRecord({ approvalMode: 'yolo' }),
      messages: [toolCallMessage],
      inFlight: true,
      toolCallLive: {
        call_1: toolCallLive({ toolCallId: 'call_1', status: 'running' }),
      },
    });
    render(<AgentSessionView agentSessionId="sess_1" />);

    const yoloRow = screen.getByTestId('agent-tool-yolo-cancel');
    expect(yoloRow).toHaveTextContent('已自动开始执行，可取消');
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(sendCancelSpy).toHaveBeenCalledTimes(1);
    expect(sendCancelSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'agent:cancel',
        agentSessionId: 'sess_1',
        requestId: 'req_2',
        toolCallId: 'call_1',
      }),
    );
  });

  it('confirm 档执行中的生成调用不出现 yolo 取消入口（取消入口只属于自动执行场景）', () => {
    const sendCancelSpy = vi.spyOn(agentSocket, 'sendCancel').mockImplementation(() => {});
    seed({
      session: sessionRecord({ approvalMode: 'confirm' }),
      messages: [toolCallMessage],
      inFlight: true,
      toolCallLive: {
        call_1: toolCallLive({ toolCallId: 'call_1', status: 'running' }),
      },
    });
    render(<AgentSessionView agentSessionId="sess_1" />);

    // 执行中的图片生成调用走相册形态：生成中占位格表达进度，没有 yolo 单条取消。
    expect(screen.getByTestId('agent-album-cell-state')).toHaveAttribute('data-state', 'generating');
    expect(screen.getByTestId('agent-album-cell-state')).toHaveTextContent('生成中');
    expect(screen.queryByTestId('agent-tool-yolo-cancel')).not.toBeInTheDocument();
    // 已派发条目不再是未决提案：审批面板不出现，也没有第二条取消路径。
    expect(screen.queryByTestId('agent-tool-proposal-panel')).not.toBeInTheDocument();
    expect(sendCancelSpy).not.toHaveBeenCalled();
  });

  it('批量审批面板：本批未决提案平铺成勾选行，批级动作各一枚，卡片不再逐条给出决裁出口', () => {
    seed({
      session: sessionRecord(),
      messages: [toolCallMessage, secondToolCallMessage],
      inFlight: true,
      toolCallLive: {
        call_1: toolCallLive({ toolCallId: 'call_1', status: 'proposed' }),
        call_2: toolCallLive({ toolCallId: 'call_2', status: 'proposed' }),
      },
    });
    render(<AgentSessionView agentSessionId="sess_1" />);

    expect(screen.getAllByTestId('agent-tool-proposal-panel')).toHaveLength(1);
    expect(screen.getByTestId('agent-tool-proposal-panel')).toHaveAttribute('data-request-id', 'req_2');
    // 整批平铺：两条提案各一行，没有逐条「确认执行 / 跳过」按钮。
    expect(screen.getAllByTestId('agent-tool-proposal-item')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: '确认执行' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '跳过' })).not.toBeInTheDocument();
    // 批级动作各一枚（提交与整轮驳回都在面板内）。
    expect(screen.getAllByTestId('agent-tool-proposal-submit')).toHaveLength(1);
    expect(screen.getAllByTestId('agent-tool-proposal-reject')).toHaveLength(1);
    // 逐条状态卡仍按 live 态呈现提案内容与状态。
    expect(screen.getAllByTestId('agent-session-tool-call')).toHaveLength(2);
    expect(screen.getAllByTestId('agent-tool-call-status')[0]).toHaveTextContent('等待确认');
  });

  it('提案行展示条目摘要（工具名 / 目标模型 model_id / prompt / 状态），默认全部勾选', () => {
    seed({
      session: sessionRecord(),
      messages: [toolCallMessage, secondToolCallMessage],
      inFlight: true,
      toolCallLive: {
        call_1: toolCallLive({
          toolCallId: 'call_1',
          status: 'proposed',
          argsJson: '{"prompt":"一只柴犬","reference_asset_ids":["asset_1"]}',
        }),
        call_2: toolCallLive({ toolCallId: 'call_2', status: 'proposed' }),
      },
    });
    seedCanvas({ withAsset: true, withNode: true });
    render(<AgentSessionView agentSessionId="sess_1" />);

    const rows = screen.getAllByTestId('agent-tool-proposal-item');
    const firstRow = rows[0];
    expect(firstRow).toHaveAttribute('data-tool-call-id', 'call_1');
    expect(firstRow).toHaveTextContent('生成图像');
    expect(firstRow).toHaveTextContent('gpt-image-2');
    expect(firstRow).toHaveTextContent('一只柴犬');
    expect(screen.getAllByTestId('agent-tool-proposal-status')[0]).toHaveTextContent('等待确认');
    // 引用资产以紧凑缩略图呈现（面板是决裁面，引用不占媒体带），仍可点开预览。
    expect(firstRow?.querySelector('[data-testid="agent-media-references"]')).not.toBeNull();
    expect(screen.getByRole('button', { name: '查看参考：柴犬雨中.png' })).toBeInTheDocument();
    // 默认全部勾选（用户没改过就是执行）。
    const checkboxes = screen.getAllByRole('checkbox');
    expect(checkboxes).toHaveLength(2);
    for (const checkbox of checkboxes) expect(checkbox).toBeChecked();
    expect(screen.getByTestId('agent-tool-proposal-summary')).toHaveTextContent('共 2 项 · 将执行 2 项');
    // 全勾选态下切换钮说「全不选」。
    expect(screen.getByTestId('agent-tool-proposal-toggle-all')).toHaveTextContent('全不选');
  });

  it('全不选 ⇄ 全选：切换钮一次清空/恢复整批勾选（提交映射语义不变）', () => {
    seed({
      session: sessionRecord(),
      messages: [toolCallMessage, secondToolCallMessage],
      inFlight: true,
      toolCallLive: {
        call_1: toolCallLive({ toolCallId: 'call_1', status: 'proposed' }),
        call_2: toolCallLive({ toolCallId: 'call_2', status: 'proposed' }),
      },
    });
    render(<AgentSessionView agentSessionId="sess_1" />);

    const toggleAll = screen.getByTestId('agent-tool-proposal-toggle-all');
    fireEvent.click(toggleAll);

    expect(toggleAll).toHaveTextContent('全选');
    expect(screen.getByTestId('agent-tool-proposal-summary')).toHaveTextContent('共 2 项 · 将执行 0 项');
    for (const checkbox of screen.getAllByRole('checkbox')) expect(checkbox).not.toBeChecked();

    fireEvent.click(toggleAll);
    expect(toggleAll).toHaveTextContent('全不选');
    expect(screen.getByTestId('agent-tool-proposal-summary')).toHaveTextContent('共 2 项 · 将执行 2 项');
    for (const checkbox of screen.getAllByRole('checkbox')) expect(checkbox).toBeChecked();
  });

  it('取消勾选即过滤：提交载荷携带本批完整映射（未勾选条目 execute=false）', () => {
    const sendDecisionSpy = vi
      .spyOn(agentSocket, 'sendToolDecision')
      .mockImplementation(() => ({ delivered: true }));
    seed({
      session: sessionRecord(),
      messages: [toolCallMessage, secondToolCallMessage],
      inFlight: true,
      toolCallLive: {
        call_1: toolCallLive({ toolCallId: 'call_1', status: 'proposed' }),
        call_2: toolCallLive({ toolCallId: 'call_2', status: 'proposed' }),
      },
    });
    render(<AgentSessionView agentSessionId="sess_1" />);

    fireEvent.click(screen.getAllByRole('checkbox')[1] as HTMLElement);
    expect(screen.getByTestId('agent-tool-proposal-summary')).toHaveTextContent('共 2 项 · 将执行 1 项');

    fireEvent.click(screen.getByTestId('agent-tool-proposal-submit'));

    expect(sendDecisionSpy).toHaveBeenCalledTimes(1);
    expect(sendDecisionSpy).toHaveBeenCalledWith({
      type: 'agent:tool_decision',
      requestId: 'req_2',
      agentSessionId: 'sess_1',
      decision: 'submit',
      decisions: [
        { toolCallId: 'call_1', execute: true },
        { toolCallId: 'call_2', execute: false },
      ],
    });
  });

  it('全部不勾选后提交仍是合法结果：载荷整批 execute=false（不拦截、不自动改成勾选）', () => {
    const sendDecisionSpy = vi
      .spyOn(agentSocket, 'sendToolDecision')
      .mockImplementation(() => ({ delivered: true }));
    seed({
      session: sessionRecord(),
      messages: [toolCallMessage],
      inFlight: true,
      toolCallLive: { call_1: toolCallLive({ toolCallId: 'call_1', status: 'proposed' }) },
    });
    render(<AgentSessionView agentSessionId="sess_1" />);

    fireEvent.click(screen.getAllByRole('checkbox')[0] as HTMLElement);
    fireEvent.click(screen.getByTestId('agent-tool-proposal-submit'));

    expect(sendDecisionSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: 'submit',
        decisions: [{ toolCallId: 'call_1', execute: false }],
      }),
    );
  });

  it('点击整轮驳回发出 reject_round 决裁（整批不执行，不带条目标识）', () => {
    const sendDecisionSpy = vi
      .spyOn(agentSocket, 'sendToolDecision')
      .mockImplementation(() => ({ delivered: true }));
    seed({
      session: sessionRecord(),
      messages: [toolCallMessage, secondToolCallMessage],
      inFlight: true,
      toolCallLive: {
        call_1: toolCallLive({ toolCallId: 'call_1', status: 'proposed' }),
        call_2: toolCallLive({ toolCallId: 'call_2', status: 'proposed' }),
      },
    });
    render(<AgentSessionView agentSessionId="sess_1" />);

    fireEvent.click(screen.getByTestId('agent-tool-proposal-reject'));

    expect(sendDecisionSpy).toHaveBeenCalledTimes(1);
    expect(sendDecisionSpy).toHaveBeenCalledWith({
      type: 'agent:tool_decision',
      requestId: 'req_2',
      agentSessionId: 'sess_1',
      decision: 'reject_round',
    });
  });

  it('批级倒计时：标题行右侧显示数字倒计时（tabular-nums），进度条按剩余比例呈现', () => {
    // 批级总时长由「截止时刻 − 本批提案消息落库时刻」得出（不另立超时常量）：10 分钟批、刚送达。
    const now = Date.now();
    const expiresAt = now + 10 * 60 * 1000;
    // 提案消息与该批同属在途轮次（requestId 一致）：面板据此回溯批级总时长。
    const proposalMessage: AgentMessageRecord = {
      ...toolCallMessage,
      requestId: 'req_2',
      createdAt: now,
    };
    seed({
      session: sessionRecord(),
      messages: [proposalMessage],
      inFlight: true,
      toolCallLive: {
        call_1: toolCallLive({
          toolCallId: 'call_1',
          status: 'proposed',
          proposalExpiresAt: expiresAt,
        }),
      },
    });
    render(<AgentSessionView agentSessionId="sess_1" />);

    // 剩余时长随运行时刻漂移，只断形态（m:ss 数字倒计时），不断具体数字。
    expect(screen.getByTestId('agent-tool-proposal-clock')).toHaveTextContent(/^\d+:\d{2}$/);
    const bar = screen.getByTestId('agent-tool-proposal-progress');
    expect(bar.className).toContain('bg-(--st-generating)');
    expect(bar.style.width).toBe('100%');
  });

  it('倒计时进入临界档（剩余 < 25%）：进度条换琥珀档', () => {
    // 60 秒批：已过去 50 秒，剩 10 秒（≈17% < 25%）→ 临界档。
    const now = Date.now();
    const startedAt = now - 50 * 1000;
    const expiresAt = startedAt + 60 * 1000;
    seed({
      session: sessionRecord(),
      messages: [{ ...toolCallMessage, requestId: 'req_2', createdAt: startedAt }],
      inFlight: true,
      toolCallLive: {
        call_1: toolCallLive({
          toolCallId: 'call_1',
          status: 'proposed',
          proposalExpiresAt: expiresAt,
        }),
      },
    });
    render(<AgentSessionView agentSessionId="sess_1" />);

    const panel = screen.getByTestId('agent-tool-proposal-panel');
    expect(panel).toHaveAttribute('data-phase', 'critical');
    const bar = screen.getByTestId('agent-tool-proposal-progress');
    expect(bar.className).toContain('bg-(--st-polling)');
    expect(Number.parseInt(bar.style.width, 10)).toBeLessThanOrEqual(25);
  });

  it('倒计时归零后界面只读：进度条满格转失败档、两钮禁用、条目列表内滚，等 Backend 结算（前端不改状态、不收起面板）', () => {
    const now = Date.now();
    seed({
      session: sessionRecord(),
      messages: [{ ...toolCallMessage, requestId: 'req_2', createdAt: now - 10 * 60 * 1000 }],
      inFlight: true,
      toolCallLive: {
        call_1: toolCallLive({
          toolCallId: 'call_1',
          status: 'proposed',
          proposalExpiresAt: now - 1000,
        }),
      },
    });
    render(<AgentSessionView agentSessionId="sess_1" />);

    const panel = screen.getByTestId('agent-tool-proposal-panel');
    expect(panel).toHaveAttribute('data-phase', 'expired');
    expect(panel).toHaveAttribute('data-locked', 'true');
    // 过期文案 + 出口指引（输入与继续一律回 PromptDock）。
    const expiredNote = screen.getByTestId('agent-tool-proposal-expired-note');
    expect(expiredNote).toHaveTextContent('已超时，本轮未执行。');
    expect(expiredNote).toHaveTextContent('可回到下方输入框重新发送');
    // 进度条满格 + 失败档。
    const bar = screen.getByTestId('agent-tool-proposal-progress');
    expect(bar).toHaveAttribute('aria-hidden', 'true');
    expect(bar.className).toContain('bg-(--st-failed)');
    expect(bar.style.width).toBe('100%');
    expect(screen.getByTestId('agent-tool-proposal-clock')).toHaveTextContent('0:00');
    expect(screen.getAllByRole('checkbox')[0]).toBeDisabled();
    expect(screen.getByTestId('agent-tool-proposal-submit')).toBeDisabled();
    expect(screen.getByTestId('agent-tool-proposal-reject')).toBeDisabled();
    expect(screen.getByTestId('agent-tool-proposal-toggle-all')).toBeDisabled();
    // 条目列表固定高度内滚（窄面板不把决裁动作挤出视野）。
    expect(screen.getByTestId('agent-tool-proposal-item').parentElement?.className).toContain(
      'max-h-[240px]',
    );
    // 面板不自行收起、状态不自行改写：条目仍是等待确认，由 Backend 的超时结算驱动。
    expect(panel).toBeInTheDocument();
    expect(screen.getAllByTestId('agent-tool-call-status')[0]).toHaveTextContent('等待确认');
  });

  it('提交中（locked）：执行钮带 aria-busy 与 spinner，两枚动作禁用', () => {
    const sendDecisionSpy = vi
      .spyOn(agentSocket, 'sendToolDecision')
      .mockImplementation(() => ({ delivered: true }));
    seed({
      session: sessionRecord(),
      messages: [toolCallMessage],
      inFlight: true,
      toolCallLive: { call_1: toolCallLive({ toolCallId: 'call_1', status: 'proposed' }) },
    });
    render(<AgentSessionView agentSessionId="sess_1" />);

    fireEvent.click(screen.getByTestId('agent-tool-proposal-submit'));

    expect(sendDecisionSpy).toHaveBeenCalledTimes(1);
    const submit = screen.getByTestId('agent-tool-proposal-submit');
    expect(submit).toHaveAttribute('aria-busy', 'true');
    expect(submit.querySelector('.agent-session-spin')).not.toBeNull();
    expect(submit).toBeDisabled();
    expect(screen.getByTestId('agent-tool-proposal-reject')).toBeDisabled();
  });

  it('防重复提交：投递后两枚动作禁用，再次点击不再发送', () => {
    const sendDecisionSpy = vi
      .spyOn(agentSocket, 'sendToolDecision')
      .mockImplementation(() => ({ delivered: true }));
    seed({
      session: sessionRecord(),
      messages: [toolCallMessage],
      inFlight: true,
      toolCallLive: { call_1: toolCallLive({ toolCallId: 'call_1', status: 'proposed' }) },
    });
    render(<AgentSessionView agentSessionId="sess_1" />);

    fireEvent.click(screen.getByTestId('agent-tool-proposal-submit'));
    expect(sendDecisionSpy).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('agent-tool-proposal-submit')).toBeDisabled();
    expect(screen.getByTestId('agent-tool-proposal-reject')).toBeDisabled();

    fireEvent.click(screen.getByTestId('agent-tool-proposal-submit'));
    fireEvent.click(screen.getByTestId('agent-tool-proposal-reject'));
    expect(sendDecisionSpy).toHaveBeenCalledTimes(1);
    // live 态离开 proposed 后面板才收起（这里 live 未变，面板仍在、只是只读）。
    expect(screen.getByTestId('agent-tool-proposal-panel')).toBeInTheDocument();
  });

  it('提交没发出去（连接不可用）：面板给对应反馈并保留重试出口（不谎报成功）', () => {
    const sendDecisionSpy = vi
      .spyOn(agentSocket, 'sendToolDecision')
      .mockImplementation(() => ({ delivered: false, reason: 'connection_unavailable' }));
    seed({
      session: sessionRecord(),
      messages: [toolCallMessage],
      inFlight: true,
      toolCallLive: { call_1: toolCallLive({ toolCallId: 'call_1', status: 'proposed' }) },
    });
    render(<AgentSessionView agentSessionId="sess_1" />);

    fireEvent.click(screen.getByTestId('agent-tool-proposal-submit'));

    expect(screen.getByTestId('agent-tool-proposal-failure')).toHaveTextContent(
      '连不上，恢复后再点一次。',
    );
    expect(screen.getByTestId('agent-tool-proposal-submit')).toBeEnabled();

    sendDecisionSpy.mockImplementation(() => ({ delivered: true }));
    fireEvent.click(screen.getByTestId('agent-tool-proposal-submit'));
    expect(screen.queryByTestId('agent-tool-proposal-failure')).not.toBeInTheDocument();
    expect(screen.getByTestId('agent-tool-proposal-submit')).toBeDisabled();
  });

  it('无待决提案时不出现审批面板（已决裁/本轮不在途都不给批级出口）', () => {
    seed({
      session: sessionRecord(),
      messages: [toolCallMessage, secondToolCallMessage],
      inFlight: true,
      toolCallLive: {
        call_1: toolCallLive({ toolCallId: 'call_1', status: 'running' }),
        call_2: toolCallLive({ toolCallId: 'call_2', status: 'skipped' }),
      },
    });
    const { unmount } = render(<AgentSessionView agentSessionId="sess_1" />);
    expect(screen.queryByTestId('agent-tool-proposal-panel')).not.toBeInTheDocument();
    unmount();

    // 提案仍为待决但本轮不在途（重开项目后回放该会话）：批级出口同样不出现。
    seed({
      session: sessionRecord(),
      messages: [toolCallMessage],
      toolCallLive: { call_1: toolCallLive({ toolCallId: 'call_1', status: 'proposed' }) },
    });
    render(<AgentSessionView agentSessionId="sess_1" />);
    expect(screen.getByTestId('agent-tool-call-status')).toHaveTextContent('等待确认');
    expect(screen.queryByTestId('agent-tool-proposal-panel')).not.toBeInTheDocument();
  });
});

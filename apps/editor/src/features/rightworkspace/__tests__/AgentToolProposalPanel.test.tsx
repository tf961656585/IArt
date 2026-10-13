import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { AgentMessageRecord } from '@iart/contracts';
import type { AgentToolCallLive } from '@/features/agent/agentSessionState';
import { useAgentSessionStore } from '@/features/agent/agentSessionStore';
import type * as AgentSessionStoreModule from '@/features/agent/agentSessionStore';
import { AgentToolProposalPanel } from '../components/AgentToolProposalPanel';

/**
 * 批量审批面板的文案与决裁出口（spec docs/agent/05「Confirm 决裁流程」）。
 *
 * 覆盖会话视图（端到端）不便触达的出口：投递结果按原因分流文案（连接不可用可重试 /
 * 该轮已收口重试无效）、批级倒计时的进度条三档（进行中 / 临界 / 过期）、
 * 全不选 ⇄ 全选切换、提交中的 locked 态与面板批级文案。
 * store 只替换两个决裁出口（其余走真实实现），因此面板的取数口径仍由 store 承担；
 * 批级总时长由「截止时刻 − 本批提案消息落库时刻」回溯，故用例按真实链路播种提案消息。
 */

const h = vi.hoisted(() => ({
  submitResult: { delivered: true } as
    | { delivered: true }
    | { delivered: false; reason: 'connection_unavailable' | 'round_closed' },
  rejectResult: { delivered: true } as
    | { delivered: true }
    | { delivered: false; reason: 'connection_unavailable' | 'round_closed' },
}));

vi.mock('@/features/agent/agentSessionStore', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentSessionStoreModule>();
  return {
    ...actual,
    submitAgentToolDecisions: vi.fn(() => h.submitResult),
    rejectAgentToolRound: vi.fn(() => h.rejectResult),
  };
});

const TEN_MINUTES_MS = 10 * 60 * 1000;

const proposedItem = (toolCallId: string, prompt: string, expiresAt: number): AgentToolCallLive => ({
  toolCallId,
  requestId: 'req_2',
  toolName: 'generate_image',
  toolKind: 'generation',
  modelId: 'gpt-image-2',
  argsJson: `{"prompt":"${prompt}"}`,
  status: 'proposed',
  proposalExpiresAt: expiresAt,
});

/** 本批提案消息（落库时刻即批起点：批级总时长 = 截止时刻 − 该时刻）。 */
const proposalMessage = (createdAt: number, toolCallIds: readonly string[]): AgentMessageRecord => ({
  agentSessionId: 'sess_1',
  seq: 1,
  role: 'assistant',
  requestId: 'req_2',
  body: {
    kind: 'tool_call',
    toolCallId: toolCallIds[0] ?? 'call_1',
    toolName: 'generate_image',
    toolKind: 'generation',
    modelId: 'gpt-image-2',
    argsJson: '{"prompt":"一只柴犬"}',
  },
  plan: null,
  createdAt,
  isPartial: false,
});

const renderPanel = (params: { expiresAt: number; batchStartedAt: number }): void => {
  useAgentSessionStore.setState({
    messagesBySessionId: {
      sess_1: [proposalMessage(params.batchStartedAt, ['call_1', 'call_2'])],
    },
  });
  render(
    <AgentToolProposalPanel
      agentSessionId="sess_1"
      batch={{
        requestId: 'req_2',
        expiresAt: params.expiresAt,
        items: [
          proposedItem('call_1', '一只柴犬', params.expiresAt),
          proposedItem('call_2', '一段雨中等车的镜头', params.expiresAt),
        ],
      }}
    />,
  );
};

/** 默认档：10 分钟批、刚送达（剩余 = 总时长 → 进行中）。 */
const renderFreshBatch = (): void => {
  const now = Date.now();
  renderPanel({ batchStartedAt: now, expiresAt: now + TEN_MINUTES_MS });
};

beforeEach(() => {
  h.submitResult = { delivered: true };
  h.rejectResult = { delivered: true };
});

afterEach(() => {
  cleanup();
  useAgentSessionStore.setState({ messagesBySessionId: {} });
  vi.clearAllMocks();
});

describe('批量审批面板', () => {
  it('批级文案：标题短名词、汇总与按钮动作词对齐、组名说清「待你确认的操作」', () => {
    renderFreshBatch();

    const panel = screen.getByTestId('agent-tool-proposal-panel');
    // 组名与可见标题各司其职：标题是控件名，组名补出「谁在等谁做什么」。
    expect(panel).toHaveAttribute('aria-label', '待你确认的操作');
    expect(panel).toHaveTextContent('勾选确认');
    expect(screen.getByTestId('agent-tool-proposal-summary')).toHaveTextContent('共 2 项 · 将执行 2 项');
    expect(screen.getByTestId('agent-tool-proposal-submit')).toHaveTextContent('执行所选');
    expect(screen.getByTestId('agent-tool-proposal-reject')).toHaveTextContent('整轮驳回');
    // 默认全部勾选；取消勾选即过滤。
    expect(screen.getAllByRole('checkbox')[1]).toBeChecked();
    fireEvent.click(screen.getAllByRole('checkbox')[1] as HTMLElement);
    expect(screen.getByTestId('agent-tool-proposal-summary')).toHaveTextContent('共 2 项 · 将执行 1 项');
  });

  it('倒计时：标题行右侧 11px 数字倒计时（tabular-nums），不解释系统机制', () => {
    renderFreshBatch();

    const clock = screen.getByTestId('agent-tool-proposal-clock');
    expect(clock).toHaveTextContent(/^\d+:\d{2}$/);
    expect(clock.className).toContain('tabular-nums');
    expect(clock.className).toContain('text-[11px]');
  });

  it('进度条（进行中档）：宽度 = 剩余 / 总时长，颜色走生成中档', () => {
    renderFreshBatch();

    const panel = screen.getByTestId('agent-tool-proposal-panel');
    expect(panel).toHaveAttribute('data-phase', 'active');
    const bar = screen.getByTestId('agent-tool-proposal-progress');
    expect(bar.className).toContain('bg-(--st-generating)');
    expect(bar.style.width).toBe('100%');
  });

  it('进度条（临界档）：剩余 < 25% 换派生深琥珀档（--st-polling 浅色原值对白底不达标）', () => {
    // 60 秒批、已过去 50 秒：剩 10 秒（≈17%）→ 临界。
    const startedAt = Date.now() - 50 * 1000;
    renderPanel({ batchStartedAt: startedAt, expiresAt: startedAt + 60 * 1000 });

    expect(screen.getByTestId('agent-tool-proposal-panel')).toHaveAttribute('data-phase', 'critical');
    const bar = screen.getByTestId('agent-tool-proposal-progress');
    // 浅色走 color-mix 派生档（混黑加深），深色取原值（暗底黄本就达标）。
    expect(bar.className).toContain('color-mix(in_srgb,var(--st-polling)_72%,black)');
    expect(bar.className).toContain('dark:bg-(--st-polling)');
    expect(Number.parseInt(bar.style.width, 10)).toBeLessThanOrEqual(25);
  });

  it('过期档：进度条满格转失败档、两钮与切换钮禁用、文案说清这一轮未执行并给出回到输入框的出口', () => {
    const now = Date.now();
    renderPanel({ batchStartedAt: now - TEN_MINUTES_MS, expiresAt: now - 1000 });

    const panel = screen.getByTestId('agent-tool-proposal-panel');
    expect(panel).toHaveAttribute('data-phase', 'expired');
    expect(panel).toHaveAttribute('data-locked', 'true');
    const bar = screen.getByTestId('agent-tool-proposal-progress');
    expect(bar.className).toContain('bg-(--st-failed)');
    expect(bar.style.width).toBe('100%');
    const note = screen.getByTestId('agent-tool-proposal-expired-note');
    expect(note).toHaveTextContent('已超时，本轮未执行。');
    expect(note).toHaveTextContent('可回到下方输入框重新发送');
    expect(screen.getByTestId('agent-tool-proposal-submit')).toBeDisabled();
    expect(screen.getByTestId('agent-tool-proposal-reject')).toBeDisabled();
    expect(screen.getByTestId('agent-tool-proposal-toggle-all')).toBeDisabled();
    for (const checkbox of screen.getAllByRole('checkbox')) expect(checkbox).toBeDisabled();
  });

  it('全不选 ⇄ 全选：一次清空/恢复整批勾选（提交映射语义不变）', () => {
    renderFreshBatch();

    const toggleAll = screen.getByTestId('agent-tool-proposal-toggle-all');
    expect(toggleAll).toHaveTextContent('全不选');
    fireEvent.click(toggleAll);

    expect(toggleAll).toHaveTextContent('全选');
    expect(screen.getByTestId('agent-tool-proposal-summary')).toHaveTextContent('共 2 项 · 将执行 0 项');
    for (const checkbox of screen.getAllByRole('checkbox')) expect(checkbox).not.toBeChecked();

    fireEvent.click(toggleAll);
    expect(toggleAll).toHaveTextContent('全不选');
    expect(screen.getByTestId('agent-tool-proposal-summary')).toHaveTextContent('共 2 项 · 将执行 2 项');
    for (const checkbox of screen.getAllByRole('checkbox')) expect(checkbox).toBeChecked();
  });

  it('提交中（locked）：执行钮 aria-busy + spinner，两枚动作禁用', () => {
    renderFreshBatch();

    fireEvent.click(screen.getByTestId('agent-tool-proposal-submit'));

    const submit = screen.getByTestId('agent-tool-proposal-submit');
    expect(submit).toHaveAttribute('aria-busy', 'true');
    // loading 态由共享 Button 内建 spinner 承载（spec docs/ui-button-standard.md §6）。
    expect(submit.querySelector('.animate-spin')).not.toBeNull();
    expect(submit).toBeDisabled();
    expect(screen.getByTestId('agent-tool-proposal-reject')).toBeDisabled();
  });

  it('连接不可用：给「恢复后再点一次」的出口，面板保持可操作', () => {
    h.submitResult = { delivered: false, reason: 'connection_unavailable' };
    renderFreshBatch();

    fireEvent.click(screen.getByTestId('agent-tool-proposal-submit'));

    expect(screen.getByTestId('agent-tool-proposal-failure')).toHaveTextContent(
      '连不上，恢复后再点一次。',
    );
    expect(screen.getByTestId('agent-tool-proposal-submit')).toBeEnabled();
  });

  it('该轮已收口：如实告知这一批不会再执行（不给恒无效的重试指令），面板保持可操作', () => {
    h.submitResult = { delivered: false, reason: 'round_closed' };
    renderFreshBatch();

    fireEvent.click(screen.getByTestId('agent-tool-proposal-submit'));

    expect(screen.getByTestId('agent-tool-proposal-failure')).toHaveTextContent(
      '这一轮已经结束，这一批不会再执行。',
    );
    expect(screen.getByTestId('agent-tool-proposal-submit')).toBeEnabled();
  });

  it('整轮驳回同样按原因分流（两个动作共用一个出口映射）', () => {
    h.rejectResult = { delivered: false, reason: 'round_closed' };
    renderFreshBatch();

    fireEvent.click(screen.getByTestId('agent-tool-proposal-reject'));

    expect(screen.getByTestId('agent-tool-proposal-failure')).toHaveTextContent(
      '这一轮已经结束，这一批不会再执行。',
    );
  });
});

/**
 * 临界档进度条的对比度证据（非文本对比度 WCAG 1.4.11 ≥ 3:1）。
 *
 * 令牌真值从 `globals.css` 现读（不复制色值）：浅色 `--st-polling` 原值对白底 2.94:1 不达标，
 * 临界档改用 spec §5.4.2 的 color-mix 派生模式（72% + black）；深色档取原值。
 * 本用例按同一个 color-mix 公式复算派生色，断言浅色 / 深色两档对各自卡底都 ≥ 3:1。
 */

type Rgb = { r: number; g: number; b: number };

/**
 * 三个令牌块：`:root`（浅色）/ `[data-theme='dark']`（项目语义令牌，含 --st-*）/
 * `.dark`（shadcn 中性令牌，含 --card 等表面色）。两轨主题由 AppThemeProvider 同时写入。
 */
const readCssTokenBlocks = (): {
  light: Record<string, string>;
  dark: Record<string, string>;
  darkSurface: Record<string, string>;
} => {
  const css = readFileSync(join(process.cwd(), 'apps/editor/src/app/globals.css'), 'utf8');
  const blockOf = (selector: string): Record<string, string> => {
    const start = css.indexOf(selector);
    if (start === -1) throw new Error(`globals.css 缺少 ${selector}`);
    const open = css.indexOf('{', start);
    const end = css.indexOf('}', open);
    const body = css.slice(open + 1, end);
    const tokens: Record<string, string> = {};
    for (const match of body.matchAll(/--([A-Za-z0-9-]+)\s*:\s*([^;]+);/g)) {
      const name = match[1];
      const value = match[2];
      if (name !== undefined && value !== undefined) tokens[name] = value.trim();
    }
    return tokens;
  };
  return {
    light: blockOf(':root {'),
    dark: blockOf("[data-theme='dark'] {"),
    darkSurface: blockOf('.dark {'),
  };
};

/** 只解析用到的两种色值写法：`#rrggbb` 与 `oklch(L C H)`（卡底为无彩度中性档）。 */
const parseColor = (value: string): Rgb => {
  const hex = /^#([0-9a-f]{6})$/i.exec(value.trim());
  if (hex !== null && hex[1] !== undefined) {
    const int = Number.parseInt(hex[1], 16);
    return { r: (int >> 16) & 0xff, g: (int >> 8) & 0xff, b: int & 0xff };
  }
  const oklch = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)/.exec(value.trim());
  if (oklch === null) throw new Error(`未支持的色值写法：${value}`);
  const [l, c, h] = [Number(oklch[1]), Number(oklch[2]), Number(oklch[3])];
  const hr = (h * Math.PI) / 180;
  const a = c * Math.cos(hr);
  const b = c * Math.sin(hr);
  const lCubed = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const mCubed = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const sCubed = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const encode = (linear: number): number =>
    Math.round(Math.min(1, Math.max(0, linear <= 0.0031308 ? 12.92 * linear : 1.055 * linear ** (1 / 2.4) - 0.055)) * 255);
  return {
    r: encode(4.0767416621 * lCubed - 3.3077115913 * mCubed + 0.2309699292 * sCubed),
    g: encode(-1.2684380046 * lCubed + 2.6097574011 * mCubed - 0.3413193965 * sCubed),
    b: encode(-0.0041960863 * lCubed - 0.7034186147 * mCubed + 1.707614701 * sCubed),
  };
};

/** color-mix(in srgb, color weight%, black)：逐通道按 sRGB 线性插值后取整。 */
const mixWithBlack = (color: Rgb, weight: number): Rgb => ({
  r: Math.round(color.r * weight),
  g: Math.round(color.g * weight),
  b: Math.round(color.b * weight),
});

const relativeLuminance = ({ r, g, b }: Rgb): number => {
  const channel = (raw: number): number => {
    const value = raw / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
};

const contrastRatio = (a: Rgb, b: Rgb): number => {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
};

describe('临界档进度条对比度', () => {
  it('浅色派生档对卡底 ≥ 3:1（--st-polling 原值 2.94:1 不达标，故走 color-mix 派生）', () => {
    const { light, dark, darkSurface } = readCssTokenBlocks();
    const pollingLight = parseColor(light['st-polling'] ?? '');
    const cardLight = parseColor(light['card'] ?? '');
    const cardDark = parseColor(darkSurface['card'] ?? '');
    const pollingDark = parseColor(dark['st-polling'] ?? '');

    // 原值不达标（这就是必须派生加深的证据）。
    expect(contrastRatio(pollingLight, cardLight)).toBeLessThan(3);
    // 派生档（面板临界档实现同公式：72% + black）达标。
    const derived = mixWithBlack(pollingLight, 0.72);
    expect(contrastRatio(derived, cardLight)).toBeGreaterThanOrEqual(3);
    // 深色档取原值即达标（混黑反而降对比）。
    expect(contrastRatio(pollingDark, cardDark)).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(mixWithBlack(pollingDark, 0.72), cardDark)).toBeLessThan(
      contrastRatio(pollingDark, cardDark),
    );
  });
});

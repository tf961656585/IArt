import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

/**
 * Agent 删除确认框宿主（AG-CT-011，文案口径 docs/editor/画布对象右键菜单.md §7.2b）。
 *
 * 删除 Agent 的唯一放行口：所有不经确认的删除入口（键盘 Delete、工具栏、菜单、
 * 选中集删除）都经 requestAgentDeleteConfirm 通道汇聚到这里。本测试钉：
 * - 钉死确认文案（标题/说明/按钮）；
 * - 确认 → 先串行终止在途会话，再走 removeNodes 同一删除咽喉，toast 钉死文案；
 * - 取消 → 不产生任何删除与终止。
 */

const mocks = vi.hoisted(() => ({
  cancelAgentSessionForNode: vi.fn(),
  removeNodes: vi.fn(),
  clearAgentDeleteConfirmRequest: vi.fn(),
  successToast: vi.fn(),
}));

const storeRef: { state: Record<string, unknown> } = { state: {} };

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    info: vi.fn(),
    success: (...args: unknown[]) => {
      mocks.successToast(...args);
    },
    warning: vi.fn(),
  },
}));

vi.mock('../../../store/canvasStore', () => ({
  useCanvasStore: Object.assign(
    (selector: (s: Record<string, unknown>) => unknown) => selector(storeRef.state),
    {
      getState: () => storeRef.state,
      setState: (fn: (s: Record<string, unknown>) => void) => fn(storeRef.state),
    },
  ),
}));

vi.mock('@/features/agent/agentSessionStore', () => ({
  cancelAgentSessionForNode: mocks.cancelAgentSessionForNode,
}));

import { AgentDeleteConfirmHost } from '../AgentDeleteConfirmHost';

const seedRequest = (nodeIds: string[] | null) => {
  storeRef.state = {
    pendingAgentDeleteConfirmNodeIds: nodeIds,
    clearAgentDeleteConfirmRequest: mocks.clearAgentDeleteConfirmRequest,
    removeNodes: mocks.removeNodes,
  };
};

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.cancelAgentSessionForNode.mockResolvedValue(undefined);
});

describe('AgentDeleteConfirmHost · 钉死文案', () => {
  it('无请求时不渲染确认框', () => {
    seedRequest(null);
    render(<AgentDeleteConfirmHost />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('有请求时呈现钉死文案：标题「删除这个 Agent？」、说明与「删除」「取消」按钮', () => {
    seedRequest(['agent-1']);
    render(<AgentDeleteConfirmHost />);

    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toContain('删除这个 Agent？');
    expect(dialog.textContent).toContain(
      '删除这个 Agent 后，它的会话和全部消息记录将被清除，无法恢复。生成的内容仍保留在画布。',
    );
    expect(screen.getByRole('button', { name: '删除' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '取消' })).toBeTruthy();
  });
});

describe('AgentDeleteConfirmHost · 确认与取消', () => {
  it('确认 → 先串行终止在途会话再 removeNodes（同一删除咽喉），toast 钉死文案，清空请求', async () => {
    seedRequest(['agent-1', 'agent-2']);
    const cancelGate: { release: (() => void) | null } = { release: null };
    mocks.cancelAgentSessionForNode.mockImplementation(
      (nodeId: string): Promise<void> =>
        nodeId === 'agent-1'
          ? new Promise<void>((resolve) => {
              cancelGate.release = resolve;
            })
          : Promise.resolve(),
    );
    render(<AgentDeleteConfirmHost />);

    fireEvent.click(screen.getByRole('button', { name: '删除' }));

    await waitFor(() =>
      expect(mocks.cancelAgentSessionForNode).toHaveBeenCalledWith('agent-1'),
    );
    // 在途终止未收口前不动图形
    expect(mocks.removeNodes).not.toHaveBeenCalled();
    const release = cancelGate.release;
    expect(release).not.toBeNull();
    release?.();

    await waitFor(() =>
      expect(mocks.removeNodes).toHaveBeenCalledWith(['agent-1', 'agent-2'], undefined),
    );
    expect(
      mocks.cancelAgentSessionForNode.mock.calls.map(
        (call: unknown[]) => call[0],
      ),
    ).toEqual(['agent-1', 'agent-2']);
    expect(
      mocks.cancelAgentSessionForNode.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.removeNodes.mock.invocationCallOrder[0] as number);
    expect(mocks.successToast).toHaveBeenCalledWith('Agent 已删除，生成的内容保留在画布');
    expect(mocks.clearAgentDeleteConfirmRequest).toHaveBeenCalled();
  });

  it('取消 → 清空请求，不终止会话、不删除', () => {
    seedRequest(['agent-1']);
    render(<AgentDeleteConfirmHost />);

    fireEvent.click(screen.getByRole('button', { name: '取消' }));

    expect(mocks.clearAgentDeleteConfirmRequest).toHaveBeenCalled();
    expect(mocks.cancelAgentSessionForNode).not.toHaveBeenCalled();
    expect(mocks.removeNodes).not.toHaveBeenCalled();
  });
});

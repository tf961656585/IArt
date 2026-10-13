import { beforeEach, describe, expect, it } from 'vitest';

import {
  RIGHT_WORKSPACE_WIDTH_DEFAULT,
  openAgentSessionView,
  toggleAgentSessionView,
  useRightWorkspaceStore,
} from '../rightWorkspaceStore';

/**
 * 右侧工作区的会话视图入口（spec docs/agent/02「会话视图与多轮历史」、
 * spec docs/editor/右侧工作区与打包区服务.md「打开模型」「宽度治理」、
 * spec docs/agent/06「历史承载与会话视图」）。
 *
 * 保护：会话视图与打包区单内容互斥；同一会话重复打开幂等（选中驱动重击、续作重复触发
 * 不复位状态）；「展开 / 收起」再触同入口语义（右键菜单显式开关）；宽度按内容种类独立持久化；
 * 打开/关闭只改容器状态（不触碰画布，因此不可能移动 viewport 或兄弟节点）。
 */

const widthKey = (kind: 'packageArea' | 'agentSession'): string =>
  `iarts.editor.rightWorkspace.width.${kind}`;

const createMockStorage = (): Storage => {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear() {
      data.clear();
    },
    getItem(key: string) {
      return data.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(data.keys())[index] ?? null;
    },
    removeItem(key: string) {
      data.delete(key);
    },
    setItem(key: string, value: string) {
      data.set(key, value);
    },
  };
};

beforeEach(() => {
  // jsdom 环境下 localStorage 不保证可用：宽度持久化断言在本文件内装一份内存实现。
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: createMockStorage(),
  });
  useRightWorkspaceStore.setState({
    activeKind: null,
    agentSessionId: null,
    width: RIGHT_WORKSPACE_WIDTH_DEFAULT,
  });
});

describe('右侧工作区：Agent 会话视图入口', () => {
  it('打开会话视图：种类与会话一次性写入，打包区被互斥关闭', () => {
    const store = useRightWorkspaceStore.getState();
    store.open('packageArea');
    expect(useRightWorkspaceStore.getState().activeKind).toBe('packageArea');

    openAgentSessionView('sess_1');

    const state = useRightWorkspaceStore.getState();
    expect(state.activeKind).toBe('agentSession');
    expect(state.agentSessionId).toBe('sess_1');
  });

  it('同一会话重复打开幂等：状态与宽度保持现状（选中驱动重击、续作重复触发不复位）', () => {
    openAgentSessionView('sess_1');
    useRightWorkspaceStore.getState().setWidth(500);
    useRightWorkspaceStore.getState().commitWidth();
    // 拖拽中已改、尚未提交的宽度也不得被重复打开复位
    useRightWorkspaceStore.getState().setWidth(520);

    openAgentSessionView('sess_1');

    const state = useRightWorkspaceStore.getState();
    expect(state.activeKind).toBe('agentSession');
    expect(state.agentSessionId).toBe('sess_1');
    expect(state.width).toBe(520);
  });

  it('展开/收起再触同入口：同一会话再触关闭，不同会话再触切换到新会话', () => {
    toggleAgentSessionView('sess_1');
    expect(useRightWorkspaceStore.getState().agentSessionId).toBe('sess_1');

    toggleAgentSessionView('sess_1');
    expect(useRightWorkspaceStore.getState().activeKind).toBeNull();
    expect(useRightWorkspaceStore.getState().agentSessionId).toBeNull();

    toggleAgentSessionView('sess_1');
    toggleAgentSessionView('sess_2');
    expect(useRightWorkspaceStore.getState().activeKind).toBe('agentSession');
    expect(useRightWorkspaceStore.getState().agentSessionId).toBe('sess_2');
  });

  it('宽度按内容种类独立持久化：会话视图与打包区各记各的宽度', () => {
    const store = useRightWorkspaceStore.getState();
    store.open('packageArea');
    useRightWorkspaceStore.getState().setWidth(480);
    useRightWorkspaceStore.getState().commitWidth();

    openAgentSessionView('sess_1');
    // 会话视图首次打开读自己的命名空间：未被设置过 → 默认宽度
    expect(useRightWorkspaceStore.getState().width).toBe(RIGHT_WORKSPACE_WIDTH_DEFAULT);

    useRightWorkspaceStore.getState().setWidth(500);
    useRightWorkspaceStore.getState().commitWidth();
    expect(window.localStorage.getItem(widthKey('agentSession'))).toBe('500');

    useRightWorkspaceStore.getState().open('packageArea');
    expect(useRightWorkspaceStore.getState().width).toBe(480);
    expect(window.localStorage.getItem(widthKey('packageArea'))).toBe('480');
  });

  it('打开打包区时清掉陈旧会话引用（避免面板留着上一段对话的标识）', () => {
    openAgentSessionView('sess_1');
    useRightWorkspaceStore.getState().open('packageArea');
    expect(useRightWorkspaceStore.getState().agentSessionId).toBeNull();
  });

  it('空会话标识不打开面板（留痕跳过，不出现空白会话视图）', () => {
    openAgentSessionView('');
    expect(useRightWorkspaceStore.getState().activeKind).toBeNull();

    toggleAgentSessionView('');
    expect(useRightWorkspaceStore.getState().activeKind).toBeNull();
  });
});

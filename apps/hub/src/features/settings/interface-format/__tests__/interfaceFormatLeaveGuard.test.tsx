import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';

import { InterfaceFormatEditor } from '../InterfaceFormatEditor';
import { InterfaceFormatPage } from '../InterfaceFormatPage';
import { SettingsTab } from '../../SettingsTab';
import { createHubApiClient } from '../../../../client/api/hub-api';
import { createHubHttpClient } from '../../../../client/adapters/http-client';
import type { HubApiClient } from '../../../../client/types';

/**
 * 接口格式编辑器的「未保存改动」离开守卫（docs/custom-providers/接口格式旅程-design.md §2）。
 *
 * 钉住三条行为：
 * 1. 有改动时「返回」先确认，取消留在原页且输入保留；
 * 2. 没动过内容时不打扰，直接返回；
 * 3. 编辑器把同一个守卫交给外壳（设置页左侧导航），切分区也走这份确认，
 *    不会因为切导航卸载页面而静默丢输入。
 */

const BASE = 'http://localhost:4877';
const WRITE_TOKEN = 'a'.repeat(32);

const LEAVE_TITLE = '放弃这次编辑？';

type LeaveGuard = () => Promise<boolean>;
type RegisterLeaveGuard = (guard: LeaveGuard | null) => void;

const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

/** 保存成功的响应（形状与校验用例一致，可被契约 parse）。 */
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

/** 页面数据源只经 useHubRuntime 取；桩里只放用例需要的字段。 */
const apiRef = vi.hoisted(() => ({ current: null as HubApiClient | null }));
vi.mock('../../../../components/providers/HubAppProvider', () => ({
  useHubRuntime: (): { api: HubApiClient } => {
    if (apiRef.current === null) throw new Error('用例没有装载 api');
    return { api: apiRef.current };
  },
}));

/** 顶栏带要求 preload 桥，jsdom 没有；这里只关心分区切换，替换成空壳。 */
vi.mock('../../../../components/HubTopBand', () => ({
  HubTopBand: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

/** 切分区后的目标页：只验证「切走了」，不装载外观页的设置数据。 */
vi.mock('../../AppearanceSection', () => ({
  AppearanceSection: () => <div>外观页</div>,
}));

const stubEmptyFormatList = (): void => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/interface-formats') return jsonResponse({ formats: [] });
      throw new Error(`未预期的请求：${url.pathname}`);
    }),
  );
};

const makeApi = (): HubApiClient => createHubApiClient(createHubHttpClient(BASE, WRITE_TOKEN));

type RenderEditorOptions = {
  onCancel?: () => void;
  registerLeaveGuard?: RegisterLeaveGuard;
};

const renderEditor = (
  { onCancel = vi.fn(), registerLeaveGuard }: RenderEditorOptions = {},
): { onCancel: () => void } => {
  render(
    <InterfaceFormatEditor
      mode="create"
      api={makeApi()}
      onCancel={onCancel}
      onSaved={() => undefined}
      {...(registerLeaveGuard === undefined ? {} : { registerLeaveGuard })}
    />,
  );
  return { onCancel };
};

const leaveDialog = async (): Promise<HTMLElement> =>
  screen.findByRole('dialog', { name: LEAVE_TITLE });

const clickInLeaveDialog = (label: string): void => {
  fireEvent.click(within(screen.getByRole('dialog', { name: LEAVE_TITLE })).getByRole('button', { name: label }));
};

const closeDialogSoon = async (): Promise<void> => {
  await waitFor(() => {
    expect(screen.queryByRole('dialog', { name: LEAVE_TITLE })).not.toBeInTheDocument();
  });
};

/** 直接调用守卫会触发 React 状态更新（打开确认框），用 act 包一层避免告警。 */
const startGuard = (guard: LeaveGuard): Promise<boolean> => {
  const holder: { promise: Promise<boolean> | null } = { promise: null };
  act(() => {
    holder.promise = guard();
  });
  const pending = holder.promise;
  if (pending === null) throw new Error('守卫没有开始');
  return pending;
};

beforeEach(() => {
  Object.defineProperty(Element.prototype, 'scrollIntoView', {
    value: vi.fn(),
    configurable: true,
    writable: true,
  });
  window.history.replaceState(null, '', '/');
  window.sessionStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('接口格式编辑器：未保存改动的离开确认', () => {
  it('改过字段后点「返回」先确认；取消留在原页且输入保留，确认后才离开', async () => {
    const { onCancel } = renderEditor();
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '我的格式' } });

    fireEvent.click(screen.getByRole('button', { name: '返回' }));
    await leaveDialog();

    clickInLeaveDialog('取消');
    await closeDialogSoon();
    expect(onCancel).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: '新建接口格式' })).toBeInTheDocument();
    expect(screen.getByLabelText('名称')).toHaveValue('我的格式');

    fireEvent.click(screen.getByRole('button', { name: '返回' }));
    await leaveDialog();
    clickInLeaveDialog('放弃并返回');

    await waitFor(() => {
      expect(onCancel).toHaveBeenCalledTimes(1);
    });
  });

  it('没改过内容时点「返回」不弹确认，直接离开', async () => {
    const { onCancel } = renderEditor();

    fireEvent.click(screen.getByRole('button', { name: '返回' }));

    await waitFor(() => {
      expect(onCancel).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByRole('dialog', { name: LEAVE_TITLE })).not.toBeInTheDocument();
  });

  it('保存成功后再问守卫直接放行：外壳的自动跳转不会被「放弃编辑」拦住', async () => {
    const guardRef: { current: LeaveGuard | null } = { current: null };
    const fetchMock = vi.fn(async () => jsonResponse(writeResponse));
    vi.stubGlobal('fetch', fetchMock);
    renderEditor({ registerLeaveGuard: (guard) => { guardRef.current = guard; } });

    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '我的格式' } });
    fireEvent.change(screen.getByLabelText('提交路径'), { target: { value: '/v1/mine' } });
    fireEvent.change(screen.getByLabelText('产物路径（每行一个）'), { target: { value: 'data.url' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    const guard = guardRef.current;
    if (guard === null) throw new Error('编辑器没有注册离开守卫');
    await expect(guard()).resolves.toBe(true);
  });

  it('registerLeaveGuard 暴露的守卫：取消返回 false、确认返回 true，处理中重复调用不叠弹窗', async () => {
    const guardRef: { current: LeaveGuard | null } = { current: null };
    renderEditor({ registerLeaveGuard: (guard) => { guardRef.current = guard; } });
    expect(guardRef.current).not.toBeNull();

    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '我的格式' } });
    const guard = guardRef.current;
    if (guard === null) throw new Error('编辑器没有注册离开守卫');

    const first = startGuard(guard);
    await leaveDialog();
    await expect(guard()).resolves.toBe(false);
    expect(screen.getAllByRole('dialog')).toHaveLength(1);

    clickInLeaveDialog('取消');
    await expect(first).resolves.toBe(false);
    await closeDialogSoon();

    const second = startGuard(guard);
    await leaveDialog();
    clickInLeaveDialog('放弃并返回');
    await expect(second).resolves.toBe(true);
  });

  it('卸载时撤销守卫，并把仍在等待的守卫调用以 false 收尾', async () => {
    const guardRef: { current: LeaveGuard | null } = { current: null };
    const registerLeaveGuard = vi.fn((guard: LeaveGuard | null): void => {
      guardRef.current = guard;
    });
    const { unmount } = render(
      <InterfaceFormatEditor
        mode="create"
        api={makeApi()}
        onCancel={() => undefined}
        onSaved={() => undefined}
        registerLeaveGuard={registerLeaveGuard}
      />,
    );

    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '我的格式' } });
    const guard = guardRef.current;
    if (guard === null) throw new Error('编辑器没有注册离开守卫');

    const pending = startGuard(guard);
    await leaveDialog();
    unmount();

    await expect(pending).resolves.toBe(false);
    expect(registerLeaveGuard).toHaveBeenLastCalledWith(null);
  });
});

describe('接口格式页：把守卫透传给编辑器', () => {
  it('进入新建并改字段后，外壳拿到的守卫会弹出同一个确认', async () => {
    stubEmptyFormatList();
    apiRef.current = makeApi();
    const guardRef: { current: LeaveGuard | null } = { current: null };

    render(
      <InterfaceFormatPage
        onSelectSection={() => undefined}
        registerLeaveGuard={(guard) => { guardRef.current = guard; }}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: '新建格式' }));
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '我的格式' } });

    const guard = guardRef.current;
    if (guard === null) throw new Error('页面没有把离开守卫交给外壳');

    const pending = startGuard(guard);
    await leaveDialog();
    clickInLeaveDialog('取消');
    await expect(pending).resolves.toBe(false);
  });
});

describe('设置外壳：切分区前先问离开守卫', () => {
  it('守卫拒绝时不切分区、输入保留；确认后才切到目标分区', async () => {
    stubEmptyFormatList();
    apiRef.current = makeApi();
    window.history.replaceState(null, '', '#interface-formats');

    render(<SettingsTab />);

    fireEvent.click(await screen.findByRole('button', { name: '新建格式' }));
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '我的格式' } });

    const nav = screen.getByRole('navigation', { name: '设置分区' });
    fireEvent.click(within(nav).getByRole('button', { name: '外观' }));

    await leaveDialog();
    clickInLeaveDialog('取消');
    await closeDialogSoon();
    expect(screen.getByRole('heading', { name: '新建接口格式' })).toBeInTheDocument();
    expect(screen.getByLabelText('名称')).toHaveValue('我的格式');

    fireEvent.click(within(nav).getByRole('button', { name: '外观' }));
    await leaveDialog();
    clickInLeaveDialog('放弃并返回');

    expect(await screen.findByText('外观页')).toBeInTheDocument();
  });
});

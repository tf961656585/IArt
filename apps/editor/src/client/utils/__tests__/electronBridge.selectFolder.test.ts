import { afterEach, describe, expect, it } from 'vitest';

import {
  type ElectronBridge,
  type SelectFolderOptions,
  SELECT_FOLDER_ERROR_CODES,
  selectFolder,
  selectProjectFolder,
} from '../electronBridge';

const defaultSelectFolderOptions: SelectFolderOptions = {
  title: undefined,
  defaultPath: undefined,
  buttonLabel: undefined,
};

const setElectronBridge = (bridge: Partial<ElectronBridge> | Record<string, unknown>): void => {
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: bridge,
  });
};

describe('electronBridge.selectFolder', () => {
  afterEach(() => {
    Reflect.deleteProperty(window, 'electron');
  });

  it('returns environment_unavailable when Electron bridge is missing', async () => {
    const result = await selectFolder(defaultSelectFolderOptions);
    expect(result.status).toBe('error');
    expect(result.errorCode).toBe(SELECT_FOLDER_ERROR_CODES.ENVIRONMENT_UNAVAILABLE);
    expect(result.userMessage).toBe('请在桌面应用中选择保存位置');
  });

  it('passes through a success result from Electron', async () => {
    setElectronBridge({
      selectFolder: async () => ({
        status: 'success',
        path: '/tmp/project',
        errorCode: null,
        userMessage: null,
        debugMessage: null,
      }),
    });

    const result = await selectFolder(defaultSelectFolderOptions);
    expect(result).toEqual({
      status: 'success',
      path: '/tmp/project',
      errorCode: null,
      userMessage: null,
      debugMessage: null,
    });
  });

  it('passes through a canceled result from Electron', async () => {
    setElectronBridge({
      selectFolder: async () => ({
        status: 'canceled',
        path: null,
        errorCode: null,
        userMessage: null,
        debugMessage: null,
      }),
    });

    const result = await selectFolder(defaultSelectFolderOptions);
    expect(result).toEqual({
      status: 'canceled',
      path: null,
      errorCode: null,
      userMessage: null,
      debugMessage: null,
    });
  });

  it('passes through a window_unavailable error result from Electron', async () => {
    setElectronBridge({
      selectFolder: async () => ({
        status: 'error',
        path: null,
        errorCode: SELECT_FOLDER_ERROR_CODES.WINDOW_UNAVAILABLE,
        userMessage: '当前窗口不可用，请返回主窗口后重试',
        debugMessage: 'No available browser window',
      }),
    });

    const result = await selectFolder(defaultSelectFolderOptions);
    expect(result).toEqual({
      status: 'error',
      path: null,
      errorCode: SELECT_FOLDER_ERROR_CODES.WINDOW_UNAVAILABLE,
      userMessage: '当前窗口不可用，请返回主窗口后重试',
      debugMessage: 'No available browser window',
    });
  });

  it('passes through a dialog_open_failed error result from Electron', async () => {
    setElectronBridge({
      selectFolder: async () => ({
        status: 'error',
        path: null,
        errorCode: SELECT_FOLDER_ERROR_CODES.DIALOG_OPEN_FAILED,
        userMessage: '系统文件夹选择器打开失败，请重试',
        debugMessage: 'dialog crashed',
      }),
    });

    const result = await selectFolder(defaultSelectFolderOptions);
    expect(result).toEqual({
      status: 'error',
      path: null,
      errorCode: SELECT_FOLDER_ERROR_CODES.DIALOG_OPEN_FAILED,
      userMessage: '系统文件夹选择器打开失败，请重试',
      debugMessage: 'dialog crashed',
    });
  });

  it('passes through an unknown error result from Electron', async () => {
    setElectronBridge({
      selectFolder: async () => ({
        status: 'error',
        path: null,
        errorCode: SELECT_FOLDER_ERROR_CODES.UNKNOWN,
        userMessage: '选择保存位置时发生异常，请重试',
        debugMessage: 'Dialog returned an empty folder path',
      }),
    });

    const result = await selectFolder(defaultSelectFolderOptions);
    expect(result).toEqual({
      status: 'error',
      path: null,
      errorCode: SELECT_FOLDER_ERROR_CODES.UNKNOWN,
      userMessage: '选择保存位置时发生异常，请重试',
      debugMessage: 'Dialog returned an empty folder path',
    });
  });

  it('returns invalid_response when Electron returns an unexpected payload', async () => {
    setElectronBridge({
      selectFolder: async () => ({ canceled: false, path: '/tmp/project' }),
    });

    const result = await selectFolder(defaultSelectFolderOptions);
    expect(result.status).toBe('error');
    expect(result.errorCode).toBe(SELECT_FOLDER_ERROR_CODES.INVALID_RESPONSE);
    expect(result.userMessage).toBe('文件夹选择结果无效，请重试');
  });

  it('returns invoke_failed when Electron invocation throws', async () => {
    setElectronBridge({
      selectFolder: async () => {
        throw new Error('boom');
      },
    });

    const result = await selectFolder(defaultSelectFolderOptions);
    expect(result.status).toBe('error');
    expect(result.errorCode).toBe(SELECT_FOLDER_ERROR_CODES.INVOKE_FAILED);
    expect(result.userMessage).toBe('无法打开文件夹选择窗口，请重试');
    expect(result.debugMessage).toBe('boom');
  });
});

describe('electronBridge.selectProjectFolder', () => {
  afterEach(() => {
    Reflect.deleteProperty(window, 'electron');
  });

  it('returns environment_unavailable when Electron bridge is missing', async () => {
    const result = await selectProjectFolder(defaultSelectFolderOptions);
    expect(result.status).toBe('error');
    expect(result.errorCode).toBe(SELECT_FOLDER_ERROR_CODES.ENVIRONMENT_UNAVAILABLE);
    expect(result.userMessage).toBe('请在桌面应用中打开项目文件夹');
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type CharacterPinsResponse = {
  version: number;
  updatedAt: number;
  pinnedCharacterIds: string[];
};

const getAllIndexMock = vi.fn<(...args: unknown[]) => Promise<unknown[]>>();
const getCurrentProjectCharacterPinsMock = vi.fn<(...args: unknown[]) => Promise<CharacterPinsResponse>>();
const setCurrentProjectCharacterPinnedIdsMock = vi.fn<(...args: unknown[]) => Promise<CharacterPinsResponse>>();

vi.mock('../../services/characterStore', () => ({
  CharacterStore: {
    getAllIndex: (...args: unknown[]) => getAllIndexMock(...args),
  },
}));

vi.mock('../../storage/backend', () => ({
  getCurrentProjectCharacterPins: (...args: unknown[]) =>
    getCurrentProjectCharacterPinsMock(...args),
  setCurrentProjectCharacterPinnedIds: (...args: unknown[]) =>
    setCurrentProjectCharacterPinnedIdsMock(...args),
}));

import { useCharacterUIStore } from '../characterUIStore';

const resetStoreState = () => {
  useCharacterUIStore.setState({
    characters: [],
    hasLoaded: false,
    isLoading: false,
    lastCharacterIndexLoadOk: false,
    pinnedCharacterIds: [],
    pinsLoading: false,
    migrationPending: false,
    lastPinsLoadOk: false,
    pinsError: null,
    libraryOpen: false,
    saveDialogOpen: false,
    saveDialogNodeId: null,
    pendingPlacement: null,
  });
};

describe('characterUIStore pins', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    getAllIndexMock.mockResolvedValue([]);
    resetStoreState();
  });

  afterEach(async () => {
    await vi.runOnlyPendingTimersAsync();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('pins 在 503 时进入 migration pending，并在短轮询后恢复', async () => {
    getCurrentProjectCharacterPinsMock
      .mockRejectedValueOnce({ message: 'Service Unavailable', status: 503 })
      .mockResolvedValueOnce({
        version: 1,
        updatedAt: 10,
        pinnedCharacterIds: ['c1', 'c2'],
      });

    await useCharacterUIStore.getState().loadPinnedCharacters();

    expect(useCharacterUIStore.getState().migrationPending).toBe(true);
    expect(useCharacterUIStore.getState().pinsLoading).toBe(false);
    expect(useCharacterUIStore.getState().pinnedCharacterIds).toEqual([]);
    expect(useCharacterUIStore.getState().lastPinsLoadOk).toBe(false);
    expect(useCharacterUIStore.getState().pinsError).toBeNull();

    await vi.advanceTimersByTimeAsync(1200);

    expect(getCurrentProjectCharacterPinsMock).toHaveBeenCalledTimes(2);
    expect(useCharacterUIStore.getState().migrationPending).toBe(false);
    expect(useCharacterUIStore.getState().pinnedCharacterIds).toEqual(['c1', 'c2']);
    expect(useCharacterUIStore.getState().lastPinsLoadOk).toBe(true);
    expect(useCharacterUIStore.getState().pinsError).toBeNull();
  });

  it('pins 在非503错误时不应覆盖为 []，并进入可重试错误态', async () => {
    useCharacterUIStore.setState({
      pinnedCharacterIds: ['keep-1', 'keep-2'],
      lastPinsLoadOk: true,
      pinsError: null,
    });
    getCurrentProjectCharacterPinsMock.mockRejectedValueOnce({
      message: 'internal error',
      status: 500,
    });

    await useCharacterUIStore.getState().loadPinnedCharacters();

    expect(useCharacterUIStore.getState().pinnedCharacterIds).toEqual(['keep-1', 'keep-2']);
    expect(useCharacterUIStore.getState().migrationPending).toBe(false);
    expect(useCharacterUIStore.getState().lastPinsLoadOk).toBe(false);
    expect(useCharacterUIStore.getState().pinsError).toBe('internal error');
  });

  it('savePinnedCharacters 保存后应回写 store 状态', async () => {
    setCurrentProjectCharacterPinnedIdsMock.mockResolvedValueOnce({
      version: 1,
      updatedAt: 20,
      pinnedCharacterIds: ['p2', 'p1', 'p1'],
    });

    await useCharacterUIStore.getState().savePinnedCharacters(['p1', 'p2']);

    expect(setCurrentProjectCharacterPinnedIdsMock).toHaveBeenCalledWith(['p1', 'p2']);
    expect(useCharacterUIStore.getState().pinnedCharacterIds).toEqual(['p2', 'p1']);
    expect(useCharacterUIStore.getState().migrationPending).toBe(false);
    expect(useCharacterUIStore.getState().lastPinsLoadOk).toBe(true);
    expect(useCharacterUIStore.getState().pinsError).toBeNull();
  });
});

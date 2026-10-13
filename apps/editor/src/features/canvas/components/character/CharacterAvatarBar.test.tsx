import React from 'react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';

import { CharacterAvatarBar } from './CharacterAvatarBar';

const setSelectedCharactersMock = vi.fn();
const loadCharactersMock = vi.fn();
const loadPinnedCharactersMock = vi.fn();
const savePinnedCharactersMock = vi.fn();
const removePinnedCharacterMock = vi.fn();
const openLibraryMock = vi.fn();
const startPlacementMock = vi.fn();

vi.mock('@tabler/icons-react', () => ({
  IconDots: () => <span>dots</span>,
}));

vi.mock('@/components/ui/button', () => ({
  Button: ({
    children,
    onClick,
  }: {
    children?: React.ReactNode;
    onClick?: React.MouseEventHandler<HTMLButtonElement>;
  }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
}));

vi.mock('./CharacterAvatar', () => ({
  CharacterAvatar: ({
    characterId,
  }: {
    characterId: string | null;
  }) => <div>{characterId ? `avatar:${characterId}` : 'avatar:empty'}</div>,
}));

type CanvasStoreMockState = {
  nodeGraph: { id: string; meta: { selectedCharacterIds: string[] } };
  setSelectedCharacters: typeof setSelectedCharactersMock;
};

type CharacterUIStoreMockState = {
  openLibrary: typeof openLibraryMock;
  startPlacement: typeof startPlacementMock;
  characters: Array<{
    id: string;
    name: string;
    description: string;
    imageUrl: string;
    createdAt: number;
  }>;
  hasLoaded: boolean;
  isLoading: boolean;
  lastCharacterIndexLoadOk: boolean;
  pinnedCharacterIds: string[];
  pinsLoading: boolean;
  lastPinsLoadOk: boolean;
  migrationPending: boolean;
  loadCharacters: typeof loadCharactersMock;
  loadPinnedCharacters: typeof loadPinnedCharactersMock;
  savePinnedCharacters: typeof savePinnedCharactersMock;
  removePinnedCharacter: typeof removePinnedCharacterMock;
};

vi.mock('../../store/canvasStore', () => ({
  useCanvasStore: <T,>(selector: (state: CanvasStoreMockState) => T) =>
    selector({
      nodeGraph: { id: 'g1', meta: { selectedCharacterIds: ['legacy-only'] } },
      setSelectedCharacters: setSelectedCharactersMock,
    }),
}));

let characterUIState: CharacterUIStoreMockState;
vi.mock('../../store/characterUIStore', () => ({
  useCharacterUIStore: <T,>(selector: (state: CharacterUIStoreMockState) => T) =>
    selector(characterUIState),
}));

describe('CharacterAvatarBar', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setSelectedCharactersMock.mockReset();
    loadCharactersMock.mockReset();
    loadPinnedCharactersMock.mockReset();
    savePinnedCharactersMock.mockReset();
    removePinnedCharacterMock.mockReset();
    openLibraryMock.mockReset();
    startPlacementMock.mockReset();

    loadCharactersMock.mockResolvedValue(undefined);
    loadPinnedCharactersMock.mockResolvedValue(undefined);
    savePinnedCharactersMock.mockResolvedValue(undefined);
    removePinnedCharacterMock.mockResolvedValue(undefined);

    characterUIState = {
      openLibrary: openLibraryMock,
      startPlacement: startPlacementMock,
      characters: [],
      hasLoaded: true,
      isLoading: true,
      lastCharacterIndexLoadOk: false,
      pinnedCharacterIds: ['c1'],
      pinsLoading: false,
      lastPinsLoadOk: true,
      migrationPending: false,
      loadCharacters: loadCharactersMock,
      loadPinnedCharacters: loadPinnedCharactersMock,
      savePinnedCharacters: savePinnedCharactersMock,
      removePinnedCharacter: removePinnedCharacterMock,
    };
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('角色索引加载中时不应清理 selectedCharacterIds（避免新创建角色被误删）', () => {
    render(<CharacterAvatarBar />);
    vi.runAllTimers();
    expect(setSelectedCharactersMock).not.toHaveBeenCalled();
  });

  it('角色索引已加载完成且存在无效 ID 时应清理', () => {
    characterUIState.isLoading = false;
    characterUIState.lastCharacterIndexLoadOk = true;
    characterUIState.pinnedCharacterIds = ['invalid-id'];
    render(<CharacterAvatarBar />);
    vi.runAllTimers();
    expect(setSelectedCharactersMock).toHaveBeenCalledWith([]);
    expect(savePinnedCharactersMock).toHaveBeenCalledWith([]);
  });

  it('角色索引请求失败时不应触发 destructive cleanup', () => {
    characterUIState.isLoading = false;
    characterUIState.lastCharacterIndexLoadOk = false;
    characterUIState.pinnedCharacterIds = ['invalid-id'];
    render(<CharacterAvatarBar />);
    vi.runAllTimers();
    expect(setSelectedCharactersMock).not.toHaveBeenCalled();
    expect(savePinnedCharactersMock).not.toHaveBeenCalled();
  });

  it('角色栏应优先渲染 pinnedCharacterIds 而不是 legacy selectedCharacterIds', () => {
    characterUIState.isLoading = false;
    characterUIState.lastCharacterIndexLoadOk = true;
    characterUIState.characters = [
      {
        id: 'c1',
        name: '角色1',
        description: '',
        imageUrl: '/files/global-characters/c1.png',
        createdAt: 1,
      },
    ];
    render(<CharacterAvatarBar />);
    expect(screen.getByText('avatar:c1')).toBeInTheDocument();
    expect(screen.queryByText('avatar:legacy-only')).not.toBeInTheDocument();
  });
});

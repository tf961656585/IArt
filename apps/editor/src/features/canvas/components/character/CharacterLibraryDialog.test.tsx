import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { CharacterLibraryDialog } from './CharacterLibraryDialog';

const deleteCharacterMock = vi.fn<(id: string) => Promise<void>>();
const refreshAfterDeleteMock = vi.fn<(characterId: string) => Promise<void>>();
const removePinnedCharacterMock = vi.fn<(id: string) => Promise<void>>();
const savePinnedCharactersMock = vi.fn<(ids: string[]) => Promise<void>>();
const loadPinnedCharactersMock = vi.fn<() => Promise<void>>();
const setSelectedCharactersMock = vi.fn<(ids: string[]) => void>();

type PropsWithChildren = { children?: React.ReactNode };
type CharacterUIStoreMockState = {
  libraryOpen: boolean;
  closeLibrary: () => void;
  characters: Array<{
    id: string;
    name: string;
    description: string;
    imageUrl: string;
    createdAt: number;
  }>;
  hasLoaded: boolean;
  isLoading: boolean;
  pinsLoading: boolean;
  migrationPending: boolean;
  pinnedCharacterIds: string[];
  refreshAfterDelete: (characterId: string) => unknown;
  loadCharacters: () => void;
  savePinnedCharacters: (ids: string[]) => unknown;
  removePinnedCharacter: (id: string) => unknown;
  loadPinnedCharacters: () => unknown;
};

type CanvasStoreMockState = {
  nodeGraph: {
    meta: {
      selectedCharacterIds: string[];
    };
  };
  setSelectedCharacters: (ids: string[]) => unknown;
};

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

vi.mock('@/components/ui/dialog', () => {
  const Dialog = ({ open, children }: { open: boolean } & PropsWithChildren) =>
    open ? <div>{children}</div> : null;
  const Passthrough = ({ children }: PropsWithChildren) => <div>{children}</div>;
  return {
    Dialog,
    DialogBody: Passthrough,
    DialogContent: Passthrough,
    DialogDescription: Passthrough,
    DialogFooter: Passthrough,
    DialogHeader: Passthrough,
    DialogTitle: Passthrough,
  };
});

vi.mock('@/components/ui/button', () => ({
  Button: ({
    children,
    onClick,
    disabled,
  }: {
    children?: React.ReactNode;
    onClick?: React.MouseEventHandler<HTMLButtonElement>;
    disabled?: boolean;
  }) => (
    <button type="button" onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
}));

vi.mock('@/components/ui/input', () => ({
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
}));

vi.mock('@/components/ui/select', () => {
  const Passthrough = ({ children }: PropsWithChildren) => <div>{children}</div>;
  return {
    Select: Passthrough,
    SelectContent: Passthrough,
    SelectItem: Passthrough,
    SelectTrigger: Passthrough,
    SelectValue: Passthrough,
  };
});

vi.mock('@/components/ui/scroll-area', () => ({
  ScrollArea: ({ children }: PropsWithChildren) => <div>{children}</div>,
}));

vi.mock('./CharacterCard', () => ({
  CharacterCard: ({
    character,
    onDelete,
  }: {
    character: { id: string };
    onDelete?: (characterId: string) => void;
  }) => (
    <button type="button" onClick={() => onDelete?.(character.id)}>
      触发删除
    </button>
  ),
}));

vi.mock('./EditCharacterDialog', () => ({
  EditCharacterDialog: () => null,
}));

vi.mock('../../services/characterStore', () => ({
  CharacterStore: {
    delete: (id: string) => deleteCharacterMock(id),
  },
}));

vi.mock('../../store/characterUIStore', () => ({
  useCharacterUIStore: <T,>(selector: (state: CharacterUIStoreMockState) => T): T =>
    selector({
      libraryOpen: true,
      closeLibrary: vi.fn(),
      characters: [
        {
          id: 'c1',
          name: '角色 1',
          description: '',
          imageUrl: '/files/characters/c1.png',
          createdAt: 0,
        },
      ],
      hasLoaded: true,
      isLoading: false,
      pinsLoading: false,
      migrationPending: false,
      pinnedCharacterIds: ['c1'],
      refreshAfterDelete: (characterId: string) => refreshAfterDeleteMock(characterId),
      loadCharacters: vi.fn(),
      savePinnedCharacters: (ids: string[]) => savePinnedCharactersMock(ids),
      removePinnedCharacter: (id: string) => removePinnedCharacterMock(id),
      loadPinnedCharacters: () => loadPinnedCharactersMock(),
    }),
}));

vi.mock('../../store/canvasStore', () => ({
  useCanvasStore: <T,>(selector: (state: CanvasStoreMockState) => T): T =>
    selector({
      nodeGraph: {
        meta: {
          selectedCharacterIds: ['c1'],
        },
      },
      setSelectedCharacters: setSelectedCharactersMock,
    }),
}));

describe('CharacterLibraryDialog', () => {
  it('删除角色时应立即从当前项目预设中移除该角色（同步更新 AvatarBar）', async () => {
    deleteCharacterMock.mockResolvedValueOnce(undefined);
    refreshAfterDeleteMock.mockResolvedValueOnce(undefined);
    removePinnedCharacterMock.mockResolvedValueOnce(undefined);

    const user = userEvent.setup();
    render(<CharacterLibraryDialog />);

    // 触发删除确认弹窗
    await user.click(screen.getByRole('button', { name: '触发删除' }));

    // 确认删除
    await user.click(screen.getByRole('button', { name: '删除' }));

    await waitFor(() => {
      expect(deleteCharacterMock).toHaveBeenCalledWith('c1');
      expect(refreshAfterDeleteMock).toHaveBeenCalledWith('c1');
      expect(removePinnedCharacterMock).toHaveBeenCalledWith('c1');
      expect(setSelectedCharactersMock).toHaveBeenCalledWith([]);
    });
  });
});

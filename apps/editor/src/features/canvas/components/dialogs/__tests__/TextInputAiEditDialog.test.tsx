import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TextInputAiEditDialog, type TextInputAiEditModelOption } from '../TextInputAiEditDialog';

const { runTextInputAiEditMock, getAllSystemPromptsMock } = vi.hoisted(() => ({
  runTextInputAiEditMock: vi.fn(),
  getAllSystemPromptsMock: vi.fn(),
}));

vi.mock('@/features/canvas/services/textInputAiEditService', () => ({
  runTextInputAiEdit: runTextInputAiEditMock,
}));

vi.mock('@/features/canvas/services/systemPromptStore', () => ({
  SystemPromptStore: {
    getAll: getAllSystemPromptsMock,
  },
}));

const modelOptions: TextInputAiEditModelOption[] = [
  {
    modelId: 'chat-model-1',
    modelLabel: 'Chat Model A',
  },
];

const renderDialog = (options: TextInputAiEditModelOption[]) => {
  const onApply = vi.fn();
  const onOpenChange = vi.fn();

  render(
    <TextInputAiEditDialog
      open
      onOpenChange={onOpenChange}
      sourceText="原始文本"
      onApply={onApply}
      enableTemplates
      modelOptions={options}
    />,
  );

  return { onApply, onOpenChange };
};

describe('TextInputAiEditDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runTextInputAiEditMock.mockResolvedValue({
      modelId: 'chat-model-1',
      content: '改写后的文本',
    });
    getAllSystemPromptsMock.mockResolvedValue([]);
  });

  afterEach(() => {
    cleanup();
  });

  it('shows empty state and disables generation when no chat model is available', () => {
    renderDialog([]);

    expect(screen.getByText('当前没有可用的对话模型。到主窗口「设置 → 服务商与模型」添加后，重新打开本窗口再试。')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '开始修改' })).toBeDisabled();
  });

  it('runs temporary edit with the selected model and applies the editable result', async () => {
    const user = userEvent.setup();
    const { onApply } = renderDialog(modelOptions);

    fireEvent.change(screen.getByLabelText('你想怎么改'), {
      target: { value: '更具体' },
    });
    await user.click(screen.getByRole('button', { name: '开始修改' }));

    await waitFor(() => {
      expect(runTextInputAiEditMock).toHaveBeenCalledOnce();
    });
    expect(runTextInputAiEditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: 'chat-model-1',
        systemPromptId: undefined,
        sourceText: '原始文本',
        userInstruction: '更具体',
      }),
    );
    expect(screen.getByDisplayValue('改写后的文本')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('修改结果'), {
      target: { value: '手动调整后的文本' },
    });
    await user.click(screen.getByRole('button', { name: '覆盖原文' }));

    expect(onApply).toHaveBeenCalledWith('手动调整后的文本');
  });
});

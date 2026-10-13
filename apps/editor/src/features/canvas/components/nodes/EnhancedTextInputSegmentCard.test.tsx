import { forwardRef } from 'react';

import { render, screen } from '@testing-library/react';
import { DndContext } from '@dnd-kit/core';
import { describe, expect, it, vi } from 'vitest';
import { EnhancedTextInputSegmentCard } from './EnhancedTextInputSegmentCard';
import type { EnhancedTextInputSegmentCardProps } from './EnhancedTextInputSegmentCard.types';
import type { TextInputSegment } from '../../types';

vi.mock('./shared/PromptPresetTokenEditor', () => ({
  PromptPresetTokenEditor: forwardRef<HTMLDivElement, { value: string }>(function MockPromptEditor(
    { value },
    ref,
  ) {
    return (
      <div ref={ref} data-testid="prompt-editor">
        {value}
      </div>
    );
  }),
}));

vi.mock('./shared/PromptPresetSlashPopover', () => ({
  PromptPresetSlashPopover: () => null,
}));

vi.mock('./shared/PromptMentionPopover', () => ({
  PromptMentionPopover: () => null,
}));

function createSegment(overrides: Partial<TextInputSegment> = {}): TextInputSegment {
  return { kind: 'local', id: 'seg_1', enabled: true, text: '', ...overrides };
}

const noop = (): void => undefined;

function renderCard(
  segment: TextInputSegment,
  props: Partial<EnhancedTextInputSegmentCardProps> = {},
) {
  return render(
    <DndContext>
      <EnhancedTextInputSegmentCard
        segment={segment}
        index={0}
        totalCount={1}
        readOnly={false}
        draftText={segment.text}
        promptPresetSnapshots={null}
        mentionEnabled={false}
        mentionCandidates={[]}
        mentionDisplay={null}
        promptLimit={null}
        surfaceRef={{ current: null }}
        onToggle={noop}
        onMove={noop}
        onRemove={noop}
        onDraftChange={noop}
        onDraftChangeWithPromptPreset={noop}
        onFocus={noop}
        onBlur={noop}
        onCompositionStart={noop}
        onCompositionEnd={noop}
        {...props}
      />
    </DndContext>,
  );
}

describe('EnhancedTextInputSegmentCard', () => {
  it('渲染段落标题、拖拽手柄与全部操作区', () => {
    renderCard(createSegment({ text: 'hello' }));

    expect(screen.getByText('段落 1')).toBeInTheDocument();
    expect(screen.getByLabelText('拖拽排序文本段')).toBeInTheDocument();
    expect(screen.getByLabelText('上移')).toBeInTheDocument();
    expect(screen.getByLabelText('下移')).toBeInTheDocument();
    expect(screen.getByLabelText('删除')).toBeInTheDocument();
    expect(screen.getByTestId('prompt-editor')).toHaveTextContent('hello');
  });

  it('readOnly 时禁用手柄与全部操作按钮', () => {
    renderCard(createSegment(), { readOnly: true });

    expect(screen.getByLabelText('拖拽排序文本段')).toBeDisabled();
    expect(screen.getByLabelText('上移')).toBeDisabled();
    expect(screen.getByLabelText('下移')).toBeDisabled();
    expect(screen.getByLabelText('删除')).toBeDisabled();
  });

  it('首位段上移按钮禁用', () => {
    renderCard(createSegment({ id: 'seg_first' }), { index: 0, totalCount: 2 });
    expect(screen.getByLabelText('上移')).toBeDisabled();
    expect(screen.getByLabelText('下移')).toBeEnabled();
  });

  it('末位段下移按钮禁用', () => {
    renderCard(createSegment({ id: 'seg_last' }), { index: 1, totalCount: 2 });
    expect(screen.getByLabelText('下移')).toBeDisabled();
    expect(screen.getByLabelText('上移')).toBeEnabled();
  });
});

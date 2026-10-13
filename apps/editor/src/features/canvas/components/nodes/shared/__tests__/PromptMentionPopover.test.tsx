import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { forwardRef, useImperativeHandle, useRef, useState } from 'react';
import { PromptMentionPopover } from '../PromptMentionPopover';
import type { PromptTextSurface } from '../promptTextSurface';
import type { AssetMentionCandidate } from '../../../../engine/promptAssetMentions';

const TextareaSurface = forwardRef<PromptTextSurface, { value: string; onChange: (next: string) => void }>(
  function TextareaSurface({ value, onChange }, ref) {
    const textareaRef = useRef<HTMLTextAreaElement | null>(null);

    useImperativeHandle(
      ref,
      () => ({
        focus: () => textareaRef.current?.focus(),
        getElement: () => textareaRef.current,
        getValue: () => textareaRef.current?.value ?? value,
        tryGetSelectionRange: () => ({
          start: textareaRef.current?.selectionStart ?? (textareaRef.current?.value ?? value).length,
          end: textareaRef.current?.selectionEnd ?? (textareaRef.current?.value ?? value).length,
        }),
        getSelectionRange: () => ({
          start: textareaRef.current?.selectionStart ?? (textareaRef.current?.value ?? value).length,
          end: textareaRef.current?.selectionEnd ?? (textareaRef.current?.value ?? value).length,
        }),
        setSelectionRange: (start: number, end: number) => {
          textareaRef.current?.setSelectionRange(start, end);
        },
        getCaretViewportRect: () => {
          const el = textareaRef.current;
          if (!el) return { left: 0, top: 0, bottom: 0, height: 0 };
          return { left: 0, top: 0, bottom: 0, height: 0 };
        },
        setSuggestionOpen: () => undefined,
        suppressNextInput: () => undefined,
      }),
      [value],
    );

    return <textarea ref={textareaRef} value={value} onChange={(e) => onChange(e.target.value)} />;
  },
);

const CANDIDATES: AssetMentionCandidate[] = [
  { assetId: 'a1', label: 'Image1', mediaKind: 'image', index: 0 },
  { assetId: 'a2', label: 'Image2', mediaKind: 'image', index: 1 },
  { assetId: 'a3', label: 'Video1', mediaKind: 'video', index: 0 },
];

function Harness() {
  const [value, setValue] = useState('');
  const surfaceRef = useRef<PromptTextSurface | null>(null);

  return (
    <div>
      <TextareaSurface ref={surfaceRef} value={value} onChange={(next) => setValue(next)} />
      <PromptMentionPopover
        surfaceRef={surfaceRef}
        candidates={CANDIDATES}
        disabled={false}
        onInsert={({ nextValue }) => setValue(nextValue)}
      />
      <div data-testid="raw">{value}</div>
    </div>
  );
}

/** 候选项定位：候选列表项带 data-candidate-index（usePromptTriggerSuggestion 的悬停委托契约）。 */
function candidateItem(index: number): HTMLElement {
  const item = document.querySelector<HTMLElement>(`[data-candidate-index="${index}"]`);
  if (item === null) throw new Error(`candidate item ${index} not found`);
  return item;
}

describe('PromptMentionPopover 键盘导航（useListNavigation 统一基元）', () => {
  it('悬停候选后按 Enter 选中悬停项（悬停与键盘共用同一索引，两本账修复）', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    const textarea = screen.getByRole('textbox');
    await user.click(textarea);
    await user.type(textarea, '@');

    await screen.findByText('@Image1');

    // 悬停第 3 项（@Video1）后直接 Enter：修复前 hover 只改 cmdk 内部态、Enter 仍选中首项。
    fireEvent.pointerMove(candidateItem(2));
    await user.keyboard('{Enter}');
    expect(screen.getByTestId('raw').textContent).toBe('[[@asset:a3]] ');
  });

  it('键盘移动时 data-active 高亮跟随，且 cmdk 旧 data-selected 不再滞留首项', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    const textarea = screen.getByRole('textbox');
    await user.click(textarea);
    await user.type(textarea, '@');

    await screen.findByText('@Image1');

    expect(candidateItem(0).getAttribute('data-active')).toBe('true');

    await user.keyboard('{ArrowDown}');
    expect(candidateItem(1).getAttribute('data-active')).toBe('true');
    expect(candidateItem(0).getAttribute('data-active')).toBeNull();
    // cmdk 内部选中态被受控 value 钉在 activeIndex 同项：旧项不滞留 data-selected（双高亮守卫）。
    expect(candidateItem(0).getAttribute('data-selected')).not.toBe('true');
    expect(candidateItem(1).getAttribute('data-selected')).toBe('true');

    // 循环：末项 ArrowDown 回首项。
    await user.keyboard('{ArrowDown}{ArrowDown}');
    expect(candidateItem(0).getAttribute('data-active')).toBe('true');
  });
});

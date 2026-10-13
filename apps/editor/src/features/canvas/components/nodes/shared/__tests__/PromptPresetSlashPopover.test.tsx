import { describe, expect, it, beforeEach, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { forwardRef, useImperativeHandle, useRef, useState } from 'react';
import { PromptPresetSlashPopover } from '../PromptPresetSlashPopover';
import { PromptCollectionStore } from '../../../../services/promptCollectionStore';
import { PromptPresetTokenEditor, type PromptTextSurface } from '../PromptPresetTokenEditor';
import { getTextareaCaretViewportRect } from '../textareaPopoverPosition';
import type { PromptCollectionItem } from '@/features/canvas/types';

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
          const cursor = typeof el.selectionStart === 'number' ? el.selectionStart : (el.value ?? '').length;
          return getTextareaCaretViewportRect(el, cursor);
        },
        setSuggestionOpen: () => undefined,
        suppressNextInput: () => undefined,
      }),
      [value],
    );

    return <textarea ref={textareaRef} value={value} onChange={(e) => onChange(e.target.value)} />;
  },
);

function Harness() {
  const [value, setValue] = useState('');
  const [_snapshots, setSnapshots] = useState<Record<string, PromptCollectionItem>>({});
  const surfaceRef = useRef<PromptTextSurface | null>(null);

  return (
    <div>
      <TextareaSurface ref={surfaceRef} value={value} onChange={(next) => setValue(next)} />
      <PromptPresetSlashPopover
        surfaceRef={surfaceRef}
        disabled={false}
        onInsert={({ nextValue, preset }) => {
          setValue(nextValue);
          setSnapshots((prev) => ({ ...prev, [preset.id]: preset }));
        }}
      />
      <div data-testid="raw">{value}</div>
    </div>
  );
}

function ContentEditableHarness() {
  const [value, setValue] = useState('');
  const [snapshots, setSnapshots] = useState<Record<string, PromptCollectionItem>>({});
  const surfaceRef = useRef<PromptTextSurface | null>(null);

  return (
    <div>
      <PromptPresetTokenEditor
        ref={surfaceRef}
        value={value}
        onChange={(next) => setValue(next)}
        promptPresetSnapshots={snapshots}
        readOnly={false}
        promptLimit={null}
        editingSessionActive={true}
        placeholder={undefined}
        containerClassName={undefined}
        mentionDisplay={undefined}
      />
      <PromptPresetSlashPopover
        surfaceRef={surfaceRef}
        disabled={false}
        onInsert={({ nextValue, preset }) => {
          setValue(nextValue);
          setSnapshots((prev) => ({ ...prev, [preset.id]: preset }));
        }}
      />
      <div data-testid="raw">{value}</div>
    </div>
  );
}

const getAllSpy = vi.spyOn(PromptCollectionStore, 'getAll');

beforeEach(() => {
  if (typeof globalThis.requestAnimationFrame === 'undefined') {
    vi.stubGlobal('requestAnimationFrame', ((cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    }));
  }

  getAllSpy.mockResolvedValue([
    {
      id: 'p1',
      name: 'Portrait',
      content: 'portrait prompt',
      createdAt: 0,
      updatedAt: 2,
    },
    {
      id: 'p2',
      name: 'Landscape',
      content: 'landscape prompt',
      createdAt: 0,
      updatedAt: 1,
    },
    {
      id: 'p3',
      name: 'Foo',
      content: 'bar content',
      createdAt: 0,
      updatedAt: 0,
    },
  ]);
});

describe('PromptPresetSlashPopover', () => {
  it('点击候选会用 `[[pp:<presetId>]]` 替换 /query，并在末尾补空格', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    const textarea = screen.getByRole('textbox');
    await user.click(textarea);
    await user.type(textarea, '/por');

    const item = await screen.findByText('/Portrait');
    await user.click(item);

    expect(screen.getByTestId('raw').textContent).toBe('[[pp:p1]] ');
  });

  it('D1=B：仅在空白/行首的 / 才触发', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    const textarea = screen.getByRole('textbox');
    await user.click(textarea);
    await user.type(textarea, 'a/');

    expect(screen.queryByText('/Portrait')).not.toBeInTheDocument();
  });

  it('D2=A：仅按名称过滤（内容命中不应出现）', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    const textarea = screen.getByRole('textbox');
    await user.click(textarea);
    await user.type(textarea, '/bar');

    expect(await screen.findByText('没有匹配的预设')).toBeInTheDocument();
    expect(screen.queryByText('/Foo')).not.toBeInTheDocument();
  });

  it('支持键盘 Arrow + Enter 选择候选', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    const textarea = screen.getByRole('textbox');
    await user.click(textarea);
    await user.type(textarea, '/');

    await screen.findByText('/Portrait');
    await screen.findByText('/Landscape');

    await user.keyboard('{ArrowDown}{Enter}');
    expect(screen.getByTestId('raw').textContent).toBe('[[pp:p2]] ');
  });

  it('contentEditable 支持键盘 Arrow + Enter 选择候选', async () => {
    const user = userEvent.setup();
    render(<ContentEditableHarness />);

    const editor = screen.getByRole('textbox');
    await user.click(editor);
    await user.type(editor, '/');

    await screen.findByText('/Portrait');
    await screen.findByText('/Landscape');

    await user.keyboard('{ArrowDown}{Enter}');
    expect(screen.getByTestId('raw').textContent).toBe('[[pp:p2]] ');
  });

  it('弹层打开时 Shift+Enter 插入换行而非选中候选（换行优先于选候选）', async () => {
    const user = userEvent.setup();
    render(<ContentEditableHarness />);

    const editor = screen.getByRole('textbox');
    await user.click(editor);
    await user.type(editor, '/');

    await screen.findByText('/Portrait');
    await screen.findByText('/Landscape');

    fireEvent.keyDown(editor, { key: 'Enter', shiftKey: true });

    await waitFor(() => {
      expect(screen.getByTestId('raw').textContent).toBe('/\n');
    });
    expect(editor.textContent).not.toContain('[[pp:');
    // 换行终止了 / 触发上下文：弹层按既有 input 同步机制自然关闭
    await waitFor(() => {
      expect(screen.queryByText('/Portrait')).not.toBeInTheDocument();
    });
  });

  it('候选为空（无匹配）时 Shift+Enter 换行不被吞，且弹层随内容一致关闭', async () => {
    const user = userEvent.setup();
    render(<ContentEditableHarness />);

    const editor = screen.getByRole('textbox');
    await user.click(editor);
    await user.type(editor, '/zzz');

    await screen.findByText('没有匹配的预设');

    fireEvent.keyDown(editor, { key: 'Enter', shiftKey: true });

    await waitFor(() => {
      expect(screen.getByTestId('raw').textContent).toBe('/zzz\n');
    });
    expect(screen.queryByText('没有匹配的预设')).not.toBeInTheDocument();
  });

  it('组合中的 Enter 不选候选（组合中回车属于 IME，弹层 capture 层不抢）', async () => {
    const user = userEvent.setup();
    render(<ContentEditableHarness />);

    const editor = screen.getByRole('textbox');
    await user.click(editor);
    await user.type(editor, '/');

    await screen.findByText('/Portrait');

    fireEvent.keyDown(editor, { key: 'Enter', isComposing: true });

    expect(screen.getByTestId('raw').textContent).toBe('/');
    expect(screen.queryByText('/Portrait')).toBeInTheDocument();
  });
});

/** 候选项定位：候选列表项带 data-candidate-index（usePromptTriggerSuggestion 的悬停委托契约）。 */
function candidateItem(index: number): HTMLElement {
  const item = document.querySelector<HTMLElement>(`[data-candidate-index="${index}"]`);
  if (item === null) throw new Error(`candidate item ${index} not found`);
  return item;
}

describe('PromptPresetSlashPopover 键盘导航（useListNavigation 统一基元）', () => {
  it('末项按 ArrowDown 回绕到首项（wrap 循环）', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    const textarea = screen.getByRole('textbox');
    await user.click(textarea);
    await user.type(textarea, '/');

    await screen.findByText('/Portrait');

    // 3 个候选：3 次 ArrowDown 从首项绕回首项，Enter 选中首项 Portrait。
    await user.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}{Enter}');
    expect(screen.getByTestId('raw').textContent).toBe('[[pp:p1]] ');
  });

  it('首项按 ArrowUp 回绕到末项（wrap 循环）', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    const textarea = screen.getByRole('textbox');
    await user.click(textarea);
    await user.type(textarea, '/');

    await screen.findByText('/Portrait');

    await user.keyboard('{ArrowUp}{Enter}');
    expect(screen.getByTestId('raw').textContent).toBe('[[pp:p3]] ');
  });

  it('End 跳到末项、Home 回到首项（弹层打开时接管光标移动键）', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    const textarea = screen.getByRole('textbox');
    await user.click(textarea);
    await user.type(textarea, '/');

    await screen.findByText('/Portrait');

    await user.keyboard('{End}{Enter}');
    expect(screen.getByTestId('raw').textContent).toBe('[[pp:p3]] ');
  });

  it('Home 回到首项候选', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    const textarea = screen.getByRole('textbox');
    await user.click(textarea);
    await user.type(textarea, '/');

    await screen.findByText('/Portrait');

    await user.keyboard('{ArrowDown}{ArrowDown}{Home}{Enter}');
    expect(screen.getByTestId('raw').textContent).toBe('[[pp:p1]] ');
  });

  it('悬停候选后按 Enter 选中悬停项（悬停与键盘共用同一索引，两本账修复）', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    const textarea = screen.getByRole('textbox');
    await user.click(textarea);
    await user.type(textarea, '/');

    await screen.findByText('/Portrait');

    // 悬停第 3 项（Foo）后直接 Enter：修复前 hover 只改 cmdk 内部态、Enter 仍选中 activeIndex（首项）。
    fireEvent.pointerMove(candidateItem(2));
    await user.keyboard('{Enter}');
    expect(screen.getByTestId('raw').textContent).toBe('[[pp:p3]] ');
  });

  it('键盘移动时 data-active 高亮跟随，且 cmdk 旧 data-selected 不再滞留首项', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    const textarea = screen.getByRole('textbox');
    await user.click(textarea);
    await user.type(textarea, '/');

    await screen.findByText('/Portrait');

    expect(candidateItem(0).getAttribute('data-active')).toBe('true');

    await user.keyboard('{ArrowDown}');
    expect(candidateItem(1).getAttribute('data-active')).toBe('true');
    expect(candidateItem(0).getAttribute('data-active')).toBeNull();
    // cmdk 内部选中态被受控 value 钉在 activeIndex 同项：旧项不滞留 data-selected（双高亮守卫）。
    expect(candidateItem(0).getAttribute('data-selected')).not.toBe('true');
    expect(candidateItem(1).getAttribute('data-selected')).toBe('true');

    // 悬停写入同一索引后，键盘相对移动基于悬停位置。
    fireEvent.pointerMove(candidateItem(2));
    await user.keyboard('{ArrowUp}');
    expect(candidateItem(1).getAttribute('data-active')).toBe('true');
  });

  it('键盘移动高亮时滚动跟随（scrollIntoView block: nearest）', async () => {
    const user = userEvent.setup();
    const scrollIntoViewSpy = vi.spyOn(Element.prototype, 'scrollIntoView');
    try {
      render(<Harness />);

      const textarea = screen.getByRole('textbox');
      await user.click(textarea);
      await user.type(textarea, '/');

      await screen.findByText('/Portrait');
      scrollIntoViewSpy.mockClear();

      await user.keyboard('{ArrowDown}');
      expect(scrollIntoViewSpy).toHaveBeenCalledWith({ block: 'nearest' });
      const contexts = scrollIntoViewSpy.mock.contexts as Element[];
      expect(contexts.length).toBeGreaterThan(0);
      expect(contexts.every((element) => element === candidateItem(1))).toBe(true);
    } finally {
      scrollIntoViewSpy.mockRestore();
    }
  });
});

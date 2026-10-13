import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { PromptPresetTokenEditor, type PromptTextSurface } from '../PromptPresetTokenEditor';

const defaultEditorProps = {
  promptPresetSnapshots: undefined,
  readOnly: undefined,
  promptLimit: null,
  editingSessionActive: true,
  placeholder: undefined,
  containerClassName: undefined,
  mentionDisplay: undefined,
} as const;

function Harness() {
  const [value, setValue] = useState('');
  return (
    <div>
      <PromptPresetTokenEditor
        value={value}
        onChange={(next) => setValue(next)}
        {...defaultEditorProps}
      />
      <div data-testid="raw">{value}</div>
    </div>
  );
}

function CompositionCommitHarness() {
  const [value, setValue] = useState('');
  const surfaceRef = useRef<PromptTextSurface | null>(null);

  return (
    <div>
      <PromptPresetTokenEditor
        ref={surfaceRef}
        value={value}
        onChange={(next) => setValue(next)}
        {...defaultEditorProps}
        onCompositionEnd={() => {
          const next = surfaceRef.current?.getValue() ?? '';
          setValue(next);
        }}
      />
      <div data-testid="raw">{value}</div>
    </div>
  );
}

function PlaceholderHarness() {
  const [value, setValue] = useState('');
  return (
    <div>
      <PromptPresetTokenEditor
        value={value}
        onChange={(next) => setValue(next)}
        {...defaultEditorProps}
        placeholder="描述你想生成的内容… 输入 / 插入提示词预设"
      />
      <div data-testid="raw">{value}</div>
    </div>
  );
}

/** jsdom 不会像真实浏览器那样维护插入符：显式把选区折叠到编辑器内容末尾，
 * 等价真实场景「点击文本末尾 / IME 上屏后光标停在上屏文本之后」。 */
function collapseSelectionToEnd(el: HTMLElement): void {
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
}

describe('PromptPresetTokenEditor', () => {
  it('输入单个字符不会重复', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    const editor = screen.getByRole('textbox');
    await user.click(editor);
    await user.type(editor, 'a');

    expect(screen.getByTestId('raw').textContent).toBe('a');
    expect(editor.textContent).toBe('a');
  });

  it('输入全角标点不会向上冒泡 keydown（避免画布误清空选择）', async () => {
    const user = userEvent.setup();
    const onWrapperKeyDown = vi.fn();

    render(
      <div role="button" tabIndex={0} onKeyDown={onWrapperKeyDown}>
        <Harness />
      </div>
    );

    const editor = screen.getByRole('textbox');
    await user.click(editor);
    await user.type(editor, '，');

    expect(screen.getByTestId('raw').textContent).toBe('，');
    expect(onWrapperKeyDown).not.toHaveBeenCalled();
  });

  it('按下 Shift 不会向上冒泡 keydown（避免 selection 模式干扰编辑）', async () => {
    const user = userEvent.setup();
    const onWrapperKeyDown = vi.fn();

    render(
      <div role="button" tabIndex={0} onKeyDown={onWrapperKeyDown}>
        <Harness />
      </div>
    );

    const editor = screen.getByRole('textbox');
    await user.click(editor);
    fireEvent.keyDown(editor, { key: 'Shift' });

    expect(onWrapperKeyDown).not.toHaveBeenCalled();
  });

  it('按下 Backspace 不会向上冒泡 keydown（避免触发画布删除）', async () => {
    const user = userEvent.setup();
    const onWrapperKeyDown = vi.fn();

    render(
      <div role="button" tabIndex={0} onKeyDown={onWrapperKeyDown}>
        <Harness />
      </div>
    );

    const editor = screen.getByRole('textbox');
    await user.click(editor);
    fireEvent.keyDown(editor, { key: 'Backspace' });

    expect(onWrapperKeyDown).not.toHaveBeenCalled();
  });

  it('Ctrl 组合键允许向上冒泡（不影响全局快捷键）', async () => {
    const user = userEvent.setup();
    const onWrapperKeyDown = vi.fn();

    render(
      <div role="button" tabIndex={0} onKeyDown={onWrapperKeyDown}>
        <Harness />
      </div>
    );

    const editor = screen.getByRole('textbox');
    await user.click(editor);
    fireEvent.keyDown(editor, { key: 's', ctrlKey: true });

    expect(onWrapperKeyDown).toHaveBeenCalled();
  });

  it('按下 Enter 会插入换行且不失焦', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    const editor = screen.getByRole('textbox');
    await user.click(editor);
    await user.type(editor, 'a');

    expect(screen.getByTestId('raw').textContent).toBe('a');
    expect(screen.getByRole('textbox')).toHaveFocus();

    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    await waitFor(() => {
      expect(screen.getByTestId('raw').textContent).toBe('a\n');
    });
    expect(screen.getByRole('textbox')).toHaveFocus();

    await user.type(screen.getByRole('textbox'), 'b');
    expect(screen.getByTestId('raw').textContent).toBe('a\nb');
    expect(screen.getByRole('textbox')).toHaveFocus();
  });

  it('在编辑器内按 Backspace 仅删除文本，不触发外层删除事件', async () => {
    const user = userEvent.setup();
    const onWrapperKeyDown = vi.fn();
    const onEditorKeyDown = vi.fn();

    render(
      <div role="button" tabIndex={0} onKeyDown={onWrapperKeyDown}>
        <PromptPresetTokenEditor
          value="ab"
          onChange={() => {}}
          onKeyDown={onEditorKeyDown}
          {...defaultEditorProps}
        />
      </div>
    );

    const editor = screen.getByRole('textbox');
    await user.click(editor);
    await user.keyboard('{Backspace}');

    expect(onEditorKeyDown).toHaveBeenCalled();
    expect(onWrapperKeyDown).not.toHaveBeenCalled();
  });

  it('中文输入法上屏（compositionend）同步 value 不应导致失焦', async () => {
    const user = userEvent.setup();
    render(<CompositionCommitHarness />);

    const editor = screen.getByRole('textbox');
    await user.click(editor);
    expect(editor).toHaveFocus();

    fireEvent.compositionStart(editor);
    editor.textContent = '中文';
    fireEvent.compositionEnd(editor);

    await waitFor(() => {
      expect(screen.getByTestId('raw').textContent).toBe('中文');
    });
    expect(screen.getByRole('textbox')).toHaveFocus();
  });

  it('中文组合结束（compositionend）即同步 value，不依赖父组件补同步：占位隐藏、提交可读', async () => {
    const user = userEvent.setup();
    render(<PlaceholderHarness />);

    const editor = screen.getByRole('textbox');
    await user.click(editor);
    expect(screen.getByText('描述你想生成的内容… 输入 / 插入提示词预设')).toBeInTheDocument();

    // 组合进行中：受控 value 有意不同步（避免半截拼音进入 token 解析），但占位应隐藏
    fireEvent.compositionStart(editor);
    editor.textContent = '是是是';
    fireEvent.input(editor, { inputType: 'insertCompositionText', isComposing: true });
    await waitFor(() => {
      expect(screen.queryByText('描述你想生成的内容… 输入 / 插入提示词预设')).toBeNull();
    });
    expect(screen.getByTestId('raw').textContent).toBe('');

    // 上屏：compositionend 必须同步 value，否则占位与已上屏文本共存、消费方提交空串
    fireEvent.compositionEnd(editor);
    await waitFor(() => {
      expect(screen.getByTestId('raw').textContent).toBe('是是是');
    });
    expect(editor.textContent).toBe('是是是');
    expect(editor).toHaveFocus();
    expect(screen.queryByText('描述你想生成的内容… 输入 / 插入提示词预设')).toBeNull();
  });

  it('组合被取消（compositionend 后无文本）时占位恢复显示', async () => {
    const user = userEvent.setup();
    render(<PlaceholderHarness />);

    const editor = screen.getByRole('textbox');
    await user.click(editor);

    fireEvent.compositionStart(editor);
    editor.textContent = 'shi';
    fireEvent.input(editor, { inputType: 'insertCompositionText', isComposing: true });
    // 真实取消流程：IME 先把预编辑文本从 DOM 撤销，再派发 compositionend
    editor.textContent = '';
    fireEvent.compositionEnd(editor);

    await waitFor(() => {
      expect(screen.getByTestId('raw').textContent).toBe('');
    });
    expect(screen.getByText('描述你想生成的内容… 输入 / 插入提示词预设')).toBeInTheDocument();
  });

  it('组合期 Shift+Enter 一次完成：先让 IME 上屏，compositionend 后自动补插入换行', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    const editor = screen.getByRole('textbox');
    await user.click(editor);

    // 组合进行中按 Shift+Enter：不拦截（让位 IME 上屏），挂起「待补换行」
    fireEvent.compositionStart(editor);
    editor.textContent = '中文';
    // 真实浏览器在上屏完成时把光标放在已上屏文本之后，jsdom 需显式模拟
    collapseSelectionToEnd(editor);
    fireEvent.keyDown(editor, { key: 'Enter', shiftKey: true, isComposing: true });
    // compositionend 上屏后应紧接着自动补一次换行（一次完成，无需再按一次）
    fireEvent.compositionEnd(editor);

    await waitFor(() => {
      expect(screen.getByTestId('raw').textContent).toBe('中文\n');
    });
    expect(editor.textContent).toBe('中文\n');
    expect(screen.getByRole('textbox')).toHaveFocus();
  });

  it('组合中普通 Enter 让位 IME：不插入换行、不挂起待补换行（现状保持）', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    const editor = screen.getByRole('textbox');
    await user.click(editor);

    fireEvent.compositionStart(editor);
    editor.textContent = 'zh';
    fireEvent.keyDown(editor, { key: 'Enter', isComposing: true });

    expect(screen.getByTestId('raw').textContent).toBe('');

    // 上屏后也不应凭空多出换行（普通 Enter 未挂起过待补换行）
    fireEvent.compositionEnd(editor);
    await waitFor(() => {
      expect(screen.getByTestId('raw').textContent).toBe('zh');
    });
    expect(editor.textContent).toBe('zh');
  });

  it('候选弹层打开（dataset 信号，含候选为空的同款信号）时 Shift+Enter 仍插入换行且不失焦', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    const editor = screen.getByRole('textbox');
    await user.click(editor);
    await user.type(editor, 'a');

    // 与 syncSuggestionDataset 同款 dataset 信号：弹层打开态（候选是否为空不改信号）
    editor.dataset.ppOpen = 'true';
    fireEvent.keyDown(editor, { key: 'Enter', shiftKey: true });

    await waitFor(() => {
      expect(screen.getByTestId('raw').textContent).toBe('a\n');
    });
    expect(editor.textContent).toBe('a\n');
    expect(editor.textContent).not.toContain('[[pp:');
    expect(screen.getByRole('textbox')).toHaveFocus();
  });

  it('选区漂移兜底：光标不在编辑器内时按 Shift+Enter 仍在末尾插入换行且不掉焦点', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    const editor = screen.getByRole('textbox');
    await user.click(editor);
    await user.type(editor, 'a');

    // 模拟选区漂移（selection 不在编辑器内）：不得引发 renderEpoch 重建 + 焦点掉落
    window.getSelection()?.removeAllRanges();

    fireEvent.keyDown(editor, { key: 'Enter', shiftKey: true });

    await waitFor(() => {
      expect(screen.getByTestId('raw').textContent).toBe('a\n');
    });
    expect(screen.getByRole('textbox')).toHaveFocus();

    // 焦点仍在且 DOM 与受控值一致：可继续正常输入
    await user.type(screen.getByRole('textbox'), 'b');
    expect(screen.getByTestId('raw').textContent).toBe('a\nb');
    expect(screen.getByRole('textbox')).toHaveFocus();
  });

  it('残留组合态自愈：compositionend 丢失导致 ref 卡死后，干净 keydown 的 Enter 恢复换行', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    const editor = screen.getByRole('textbox');
    await user.click(editor);
    await user.type(editor, 'a');

    // 组合开始但 compositionend 丢失（如组合期间表面 DOM 被重建）：isComposingRef 卡在 true
    fireEvent.compositionStart(editor);

    // 随后到达的 keydown 自身是干净的（isComposing=false、keyCode≠229）：按非组合态处理
    fireEvent.keyDown(editor, { key: 'Enter', shiftKey: true });
    await waitFor(() => {
      expect(screen.getByTestId('raw').textContent).toBe('a\n');
    });
    expect(screen.getByRole('textbox')).toHaveFocus();

    // 自愈后不回弹：下一次普通 Enter 仍正常换行
    fireEvent.keyDown(editor, { key: 'Enter' });
    await waitFor(() => {
      expect(screen.getByTestId('raw').textContent).toBe('a\n\n');
    });
    expect(screen.getByRole('textbox')).toHaveFocus();
  });

  it('标记卫生：组合期 Shift+Enter 后未发生 compositionend 时，下一次组合不被泄漏标记污染', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    const editor = screen.getByRole('textbox');
    await user.click(editor);

    // 组合一：Shift+Enter 挂起待补换行，但该次按键被 IME 忽略、compositionend 未发生
    fireEvent.compositionStart(editor);
    fireEvent.keyDown(editor, { key: 'Enter', shiftKey: true, isComposing: true });

    // 组合二开始（组合一异常终止、无 compositionend）：compositionstart 必须清掉挂起标记，
    // 否则组合二上屏时会被动补出一个用户没有再表达的换行
    fireEvent.compositionStart(editor);
    editor.textContent = '第二';
    fireEvent.compositionEnd(editor);

    await waitFor(() => {
      expect(screen.getByTestId('raw').textContent).toBe('第二');
    });
    expect(editor.textContent).toBe('第二');
  });
});

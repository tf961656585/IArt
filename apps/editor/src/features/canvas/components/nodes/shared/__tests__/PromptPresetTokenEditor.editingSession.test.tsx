import React from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import { PromptPresetTokenEditor } from '../PromptPresetTokenEditor';

describe('PromptPresetTokenEditor 编辑 session 语义', () => {
  it('非编辑态不应暴露活跃 textbox 语义', () => {
    const { container } = render(
      <PromptPresetTokenEditor
        value="hello"
        onChange={() => undefined}
        promptPresetSnapshots={undefined}
        readOnly={false}
        promptLimit={null}
        editingSessionActive={false}
        placeholder={undefined}
        containerClassName={undefined}
        mentionDisplay={undefined}
      />,
    );

    expect(screen.queryByRole('textbox')).toBeNull();
    const surface = container.querySelector(
      '[contenteditable="false"]',
    ) as HTMLDivElement | null;
    expect(surface).not.toBeNull();
    expect(surface?.getAttribute('tabindex')).toBe('-1');
    expect(
      surface?.getAttribute('data-canvas-selection-edit-session'),
    ).toBeNull();
  });

  it('编辑态应暴露活跃 textbox 语义与画布编辑保护标记', () => {
    render(
      <PromptPresetTokenEditor
        value="hello"
        onChange={() => undefined}
        promptPresetSnapshots={undefined}
        readOnly={false}
        promptLimit={null}
        editingSessionActive={true}
        placeholder={undefined}
        containerClassName={undefined}
        mentionDisplay={undefined}
      />,
    );

    const surface = screen.getByRole('textbox');
    expect(surface.getAttribute('contenteditable')).toBe('true');
    expect(surface.getAttribute('tabindex')).toBe('0');
    expect(
      surface.getAttribute('data-canvas-selection-edit-session'),
    ).toBe('true');
  });
});

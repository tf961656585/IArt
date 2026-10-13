import { describe, expect, it } from 'vitest';
import { findMentionMatch } from '../PromptMentionPopover';
import { findSlashMatch } from '../PromptPresetSlashPopover';
import {
  hasSuggestionOpen,
  syncSuggestionDataset,
} from '../promptPresetTokenEditorDom';

describe('findMentionMatch（@ 触发）', () => {
  it('行首 @ 触发，空 query', () => {
    expect(findMentionMatch('@', 1)).toEqual({
      triggerIndex: 0,
      cursor: 1,
      query: '',
    });
  });

  it('空白后 @ 触发并带 query', () => {
    expect(findMentionMatch('hello @Ima', 10)).toEqual({
      triggerIndex: 6,
      cursor: 10,
      query: 'Ima',
    });
  });

  it('紧跟文字的 @ 不触发（email/路径场景）', () => {
    expect(findMentionMatch('a@b', 3)).toBeNull();
  });

  it('query 含空白后不触发', () => {
    expect(findMentionMatch('@abc def', 8)).toBeNull();
  });

  it('光标前存在更近的 / 时让位给 slash', () => {
    expect(findMentionMatch('@ab /cd', 7)).toBeNull();
  });
});

describe('findSlashMatch（/ 触发）', () => {
  it('行首 / 触发，空 query', () => {
    expect(findSlashMatch('/', 1)).toEqual({
      triggerIndex: 0,
      cursor: 1,
      query: '',
    });
  });

  it('光标前存在更近的 @ 时让位给 mention', () => {
    expect(findSlashMatch('/ab @cd', 7)).toBeNull();
  });
});

describe('slash / mention 触发互斥', () => {
  it('同一文本同一光标，两个触发符有更近者胜出，另一方不触发', () => {
    // 更近的是 @：mention 触发，slash 让位
    const textA = '/preset @ima';
    const cursorA = textA.length;
    expect(findMentionMatch(textA, cursorA)).not.toBeNull();
    expect(findSlashMatch(textA, cursorA)).toBeNull();

    // 更近的是 /：slash 触发，mention 让位
    const textB = '@ima /pre';
    const cursorB = textB.length;
    expect(findSlashMatch(textB, cursorB)).not.toBeNull();
    expect(findMentionMatch(textB, cursorB)).toBeNull();
  });
});

describe('suggestion 槽位（pp / mention）状态同步', () => {
  it('两个槽位互不影响，任一为 true 时 hasSuggestionOpen 为 true', () => {
    const editor = document.createElement('div');
    const state = { pp: false, mention: false };

    state.mention = true;
    syncSuggestionDataset(editor, state);
    expect(hasSuggestionOpen(editor)).toBe(true);

    state.mention = false;
    state.pp = true;
    syncSuggestionDataset(editor, state);
    expect(editor.dataset['mentionOpen']).toBeUndefined();
    expect(hasSuggestionOpen(editor)).toBe(true);

    state.pp = false;
    syncSuggestionDataset(editor, state);
    expect(hasSuggestionOpen(editor)).toBe(false);
  });
});
